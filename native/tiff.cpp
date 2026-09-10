// C entry points called from src/decode/tiff-worker.ts; see src/decode/libraw.d.ts.

#include "dng_host.h"
#include "dng_ifd.h"
#include "dng_info.h"
#include "dng_read_image.h"
#include "dng_simple_image.h"
#include "dng_stream.h"
#include "dng_tag_codes.h"
#include "dng_tag_types.h"
#include <algorithm>
#include <emscripten/emscripten.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

// The SDK reads headers and compressed blocks on demand. Uncompressed pixels stay
// in the worker's original ArrayBuffer instead of being copied into WASM first.
EM_JS(void, read_tiff_bytes, (void *destination, unsigned offset, unsigned count),
      { HEAPU8.set(Module["tiffBytes"].subarray(offset, offset + count), destination); });

class TiffStream final : public dng_stream {
    uint64 length;

  public:
    explicit TiffStream(unsigned size) : length(size) {}

  protected:
    uint64 DoGetLength() override {
        return length;
    }

    void DoRead(void *data, uint32 count, uint64 offset) override {
        if (offset > length || count > length - offset) {
            throw std::runtime_error("TIFF read exceeds the file size");
        }
        read_tiff_bytes(data, unsigned(offset), count);
    }
};

// Plain TIFF parsing with two additions: reject samples the SDK would silently clamp, and keep
// the embedded ICC profile.
class TiffInfo : public dng_info {
  public:
    std::vector<uint8> profile;

  protected:
    void ParseTag(dng_host &host, dng_stream &stream, dng_exif *exif, dng_shared *shared,
                  dng_ifd *ifd, uint32 parent, uint32 tag, uint32 type, uint32 count, uint64 offset,
                  int64 delta) override {
        if (parent == 0 && tag == tcBitsPerSample) {
            const auto position = stream.Position();
            for (uint32 i = 0; i < count; ++i) {
                if (stream.TagValue_uint32(type) > 32) {
                    throw std::runtime_error("TIFF samples wider than 32 bits are not supported");
                }
            }
            stream.SetReadPosition(position);
        }
        if (parent == 0 && tag == tcICCProfile) {
            if (count > stream.Length() || offset > stream.Length() - count) {
                throw std::runtime_error("Invalid TIFF color profile");
            }
            profile.resize(count);
            stream.SetReadPosition(offset);
            stream.Get(profile.data(), count);
            return;
        }
        dng_info::ParseTag(host, stream, exif, shared, ifd, parent, tag, type, count, offset,
                           delta);
    }
};

struct Tiff {
    std::unique_ptr<dng_simple_image> image;
    dng_pixel_buffer pixels; // SDK image data, or just row layout for browser strips.
    std::vector<uint8> profile;
    std::vector<uint32> strips; // File offset, stored bytes, decoded bytes per strip.
    // Mirrored by TiffPixels.metadata in src/tiff/upload.ts: width, height, channels, bytes per
    // sample, bits per sample (zero for float), orientation, photometric, extra-sample kind,
    // row bytes, compression, predictor.
    uint32 metadata[11];
    bool bigEndian = false;
};

// Simple strips keep their file layout for direct upload or browser-native Deflate.
// Planar/tiled storage and other predictors retain SDK decoding.
static std::vector<uint32> browser_strips(const dng_ifd &ifd, dng_stream &stream, bool deflate) {
    if ((!deflate && ifd.fCompression != 1) ||
        (ifd.fCompression != 1 && ifd.fCompression != 8 && ifd.fCompression != 32946) ||
        (ifd.fPredictor != 1 &&
         (ifd.fPredictor != 2 || stream.BigEndian() || ifd.fSampleFormat[0] != 1)) ||
        ifd.fPlanarConfiguration != 1 || ifd.fFillOrder != 1 || !ifd.fUsesStrips ||
        !ifd.fTileLength || ifd.fTileOffsetsCount != ifd.TilesPerImage() ||
        ifd.fTileByteCountsCount != ifd.fTileOffsetsCount ||
        ifd.fBitsPerSample[0] != TagTypeSize(ifd.PixelType()) * 8) {
        return {};
    }
    std::vector<uint32> strips;
    for (uint32 i = 0; i < ifd.fTileOffsetsCount; ++i) {
        stream.SetReadPosition(ifd.fTileOffsetsOffset +
                               uint64(i) * TagTypeSize(ifd.fTileOffsetsType));
        const auto offset = stream.TagValue_uint64(ifd.fTileOffsetsType);
        stream.SetReadPosition(ifd.fTileByteCountsOffset +
                               uint64(i) * TagTypeSize(ifd.fTileByteCountsType));
        const auto count = stream.TagValue_uint64(ifd.fTileByteCountsType);
        const auto rows = std::min(uint64(ifd.fTileLength),
                                   uint64(ifd.fImageLength) - uint64(i) * ifd.fTileLength);
        const auto decoded =
            rows * ifd.fImageWidth * ifd.fSamplesPerPixel * TagTypeSize(ifd.PixelType());
        if (offset > stream.Length() || count > stream.Length() - offset || decoded > UINT32_MAX ||
            (ifd.fCompression == 1 && count < decoded)) {
            throw std::runtime_error("Invalid TIFF strip size");
        }
        strips.insert(strips.end(), {uint32(offset), uint32(count), uint32(decoded)});
    }
    return strips;
}

class TiffReader final : public dng_read_image {
  public:
    using dng_read_image::DecodePredictor;
};

static std::string tiffError;

extern "C" {

EMSCRIPTEN_KEEPALIVE Tiff *tiff_open(unsigned length, bool browserDeflate) {
    try {
        dng_host host;
        TiffStream stream(length);
        TiffInfo info;
        info.Parse(host, stream);
        if (info.fIFD.empty()) {
            throw std::runtime_error("TIFF contains no image");
        }
        auto &ifd = *info.fIFD[0];
        ifd.PostParse();

        const unsigned colors = ifd.fPhotometricInterpretation == 2 ? 3 : 1;
        if (ifd.fPhotometricInterpretation > 2 || ifd.fSamplesPerPixel < colors ||
            ifd.fSamplesPerPixel > colors + 1 || !ifd.CanRead()) {
            throw std::runtime_error("Unsupported TIFF pixel layout or compression");
        }
        const auto type = ifd.PixelType();
        if (type != ttByte && type != ttShort && type != ttLong && type != ttFloat) {
            throw std::runtime_error("Unsupported TIFF sample type");
        }
        if (ifd.fSampleFormat[0] != 1 && ifd.fSampleFormat[0] != 3) {
            throw std::runtime_error("Unsupported TIFF sample format");
        }

        auto result = std::make_unique<Tiff>();
        result->bigEndian = info.fBigEndian;
        result->strips = browser_strips(ifd, stream, browserDeflate);
        if (!result->strips.empty()) {
            result->pixels.fData = nullptr; // The worker retains the original bytes.
            result->pixels.fArea = dng_rect(ifd.fImageLength, ifd.fImageWidth);
            result->pixels.fPlanes = ifd.fSamplesPerPixel;
            result->pixels.fPixelType = type;
            result->pixels.fRowStep = ifd.fImageWidth * ifd.fSamplesPerPixel;
        } else {
            result->image = std::make_unique<dng_simple_image>(
                dng_rect(ifd.fImageLength, ifd.fImageWidth), ifd.fSamplesPerPixel, type);
            ifd.ReadImage(host, stream, *result->image);
            result->image->GetPixelBuffer(result->pixels);
        }
        result->profile = std::move(info.profile);

        const unsigned sampleBytes = TagTypeSize(type);
        const uint32 metadata[] = {ifd.fImageWidth,
                                   ifd.fImageLength,
                                   ifd.fSamplesPerPixel,
                                   sampleBytes,
                                   ifd.fBitsPerSample[0],
                                   ifd.fOrientation,
                                   ifd.fPhotometricInterpretation,
                                   ifd.fExtraSamplesCount ? ifd.fExtraSamples[0] : 0,
                                   uint32(result->pixels.fRowStep) * sampleBytes,
                                   ifd.fCompression,
                                   ifd.fPredictor};
        std::copy(std::begin(metadata), std::end(metadata), result->metadata);
        // The sample type is encoded separately from integer bit depth.
        if (type == ttFloat) {
            result->metadata[4] = 0;
        }
        return result.release();
    } catch (const std::exception &exception) {
        tiffError = exception.what();
    } catch (...) {
        tiffError = "TIFF decoding failed";
    }
    return nullptr;
}

EMSCRIPTEN_KEEPALIVE const char *tiff_error() {
    return tiffError.c_str();
}

EMSCRIPTEN_KEEPALIVE uint32 *tiff_metadata(Tiff *source) {
    return source->metadata;
}

// Browser strips retain file byte order; SDK-decoded samples are native-endian.
EMSCRIPTEN_KEEPALIVE unsigned tiff_big_endian(Tiff *source) {
    return !source->strips.empty() && source->bigEndian;
}

// Reuse the SDK predictor after browser decompression; no custom delta decoder.
EMSCRIPTEN_KEEPALIVE void tiff_predict(Tiff *source, void *data) {
    auto buffer = source->pixels;
    buffer.fData = data;
    dng_ifd ifd;
    ifd.fPredictor = source->metadata[10];
    dng_host host;
    TiffReader().DecodePredictor(host, ifd, buffer);
}

EMSCRIPTEN_KEEPALIVE uint32 *tiff_strips(Tiff *source) {
    return source->strips.data();
}

EMSCRIPTEN_KEEPALIVE unsigned tiff_strip_count(Tiff *source) {
    return source->strips.size() / 3;
}

EMSCRIPTEN_KEEPALIVE void *tiff_pixels(Tiff *source) {
    return source->pixels.fData;
}

EMSCRIPTEN_KEEPALIVE void *tiff_profile(Tiff *source) {
    return source->profile.data();
}

EMSCRIPTEN_KEEPALIVE unsigned tiff_profile_size(Tiff *source) {
    return source->profile.size();
}

EMSCRIPTEN_KEEPALIVE void tiff_close(Tiff *source) {
    delete source;
}
}
