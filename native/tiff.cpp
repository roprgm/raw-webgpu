// C entry points called from src/decode/tiff-worker.ts; see src/decode/libraw.d.ts.

#include "direct.h"
#include "dng_host.h"
#include "dng_ifd.h"
#include "dng_info.h"
#include "dng_simple_image.h"
#include "dng_stream.h"
#include "dng_tag_codes.h"
#include "dng_tag_types.h"
#include <emscripten/emscripten.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

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
    dng_pixel_buffer pixels; // Points into `image`, or into the file bytes for the direct path.
    std::vector<uint8> profile;
    // Mirrored by TiffPixels.metadata in src/tiff/upload.ts: width, height, channels, bytes per
    // sample, bits per sample (zero for float), orientation, photometric, extra-sample kind,
    // row bytes.
    uint32 metadata[9];
    uint32 originalOffset = 0;
    bool bigEndian = false;
};

static std::string tiffError;

extern "C" {

EMSCRIPTEN_KEEPALIVE Tiff *tiff_open(void *bytes, unsigned length) {
    try {
        dng_host host;
        dng_stream stream(bytes, length);
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

        // Samples that already fill their storage type can be read from the file bytes directly;
        // anything else, such as packed 12-bit or compressed data, goes through the SDK.
        auto result = std::make_unique<Tiff>();
        result->originalOffset =
            ifd.fBitsPerSample[0] == TagTypeSize(type) * 8 ? uncompressed_offset(ifd, stream) : 0;
        result->bigEndian = info.fBigEndian;
        if (result->originalOffset) {
            result->pixels.fData = static_cast<uint8 *>(bytes) + result->originalOffset;
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
                                   uint32(result->pixels.fRowStep) * sampleBytes};
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

EMSCRIPTEN_KEEPALIVE unsigned tiff_original_offset(Tiff *source) {
    return source->originalOffset;
}

// SDK-decoded samples are already native-endian; only direct file bytes keep the file's order.
EMSCRIPTEN_KEEPALIVE unsigned tiff_big_endian(Tiff *source) {
    return source->originalOffset && source->bigEndian;
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
