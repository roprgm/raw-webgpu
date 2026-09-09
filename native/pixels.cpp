#include "direct.h"
#include "dng_info.h"
#include "raw.h"
#include <memory>
#include <stdexcept>

static void check(int code) {
    if (code) {
        throw std::runtime_error(libraw_strerror(code));
    }
}

static void parse_dng(Raw *source, void *bytes, unsigned length) {
    dng_stream stream(bytes, length);
    auto info = std::make_unique<dng_info>();
    info->Parse(source->host, stream);
    info->PostParse(source->host);
    if (!info->IsValidDNG()) {
        throw std::runtime_error("Unsupported DNG metadata");
    }
    source->info = std::move(info);
}

// Byte offset of a DNG mosaic the GPU can read as-is: unsigned 16-bit little-endian Bayer in one
// uncompressed strip, uncropped, with no linearization table or stage-1/2 opcodes. Zero otherwise.
static unsigned direct_bayer(Raw *source, void *bytes, unsigned length) {
    const auto &data = source->decoder.imgdata;
    if (!source->info || source->info->fBigEndian || data.idata.filters <= 1000 ||
        data.sizes.top_margin || data.sizes.left_margin) {
        return 0;
    }

    const auto &ifd = *source->info->fIFD[source->info->fMainIndex];
    if (ifd.fBitsPerSample[0] != 16 || ifd.fSamplesPerPixel != 1 || ifd.fSampleFormat[0] != 1 ||
        ifd.fPhotometricInterpretation != 32803 || ifd.fLinearizationTableCount ||
        ifd.fOpcodeList1Count || ifd.fOpcodeList2Count || ifd.fImageWidth != data.sizes.width ||
        ifd.fImageLength != data.sizes.height ||
        ifd.fActiveArea != dng_rect(ifd.fImageLength, ifd.fImageWidth)) {
        return 0;
    }

    // A Uint16Array view over the file needs an even offset.
    dng_stream stream(bytes, length);
    const auto offset = uncompressed_offset(ifd, stream);
    return offset % 2 ? 0 : offset;
}

// Failure here selects LibRaw preparation; malformed files still report decoder errors.
struct GpuLayoutUnsupported : std::runtime_error {
    using std::runtime_error::runtime_error;
};

static void describe_pixels(Raw *source) {
    auto &raw = source->decoder;
    auto &idata = raw.imgdata.idata;
    auto &levels = raw.imgdata.color;
    auto &sizes = raw.imgdata.sizes;
    if ((!source->cpuPrepared && idata.filters && idata.filters != 9 && idata.filters < 1000) ||
        (!source->cpuPrepared && (sizes.iwidth != sizes.width || sizes.iheight != sizes.height))) {
        throw GpuLayoutUnsupported("This RAW mosaic is not supported by the GPU pipeline");
    }
    if (source->cpuPrepared) {
        idata.filters = 0; // Demosaiced samples are camera RGB from here on.
    }

    source->cfaSize = idata.filters == 9 ? 6 : 2;

    // LibRaw stores a spatial black pattern of cblack[4] rows by cblack[5] columns from cblack[6].
    // A pattern must fold into one black level per CFA color, or a single value for RGB.
    unsigned blackRows = levels.cblack[4], blackCols = levels.cblack[5];
    if ((blackRows && blackCols) &&
        ((idata.filters && (blackRows > source->cfaSize || blackCols > source->cfaSize)) ||
         (!idata.filters && (blackRows != 1 || blackCols != 1)))) {
        throw GpuLayoutUnsupported(
            "This RAW black calibration is not supported by the GPU pipeline");
    }

    source->width = sizes.width;
    source->height = sizes.height;
    if (sizes.width < 3 || sizes.height < 3) {
        throw GpuLayoutUnsupported("RAW image is too small for the GPU pipeline");
    }
    source->flip = sizes.flip;
    source->mosaic = idata.filters ? 1 : 0;

    bool seen[4] = {};
    unsigned counts[3] = {};
    unsigned cells = source->mosaic ? source->cfaSize * source->cfaSize : 4;
    for (unsigned p = 0; p < cells; ++p) {
        unsigned y = p / source->cfaSize, x = p % source->cfaSize;
        unsigned channel = source->mosaic ? raw.COLOR(y, x) : p;
        source->cfa[p] = channel;
        double black = levels.black + levels.cblack[channel];
        if (blackRows && blackCols) {
            black += levels.cblack[6 + (y % blackRows) * blackCols + x % blackCols];
        }
        if (seen[channel] && source->black[channel] != black) {
            throw GpuLayoutUnsupported("Spatial RAW black calibration requires CPU preparation");
        }
        seen[channel] = true;
        source->black[channel] = black;
        if (black >= levels.maximum) {
            throw std::runtime_error("Invalid RAW black and white calibration");
        }
        if (source->mosaic) {
            counts[channel == 3 ? 1 : channel]++;
        }
    }
    if (source->mosaic) {
        if (!counts[0] || !counts[1] || !counts[2]) {
            throw GpuLayoutUnsupported("The mosaic must contain red, green and blue samples");
        }
        // The 2x2 fast shader uses MHC's diagonal Bayer filters.
        if (source->cfaSize == 2 && (counts[0] != 1 || counts[1] != 2 || counts[2] != 1 ||
                                     ((source->cfa[0] == 1 || source->cfa[0] == 3) !=
                                      (source->cfa[3] == 1 || source->cfa[3] == 3)))) {
            throw GpuLayoutUnsupported("Non-Bayer 2x2 mosaic requires CPU preparation");
        }
        for (unsigned y = 0; y < 12; ++y) {
            for (unsigned x = 0; x < source->cfaSize; ++x) {
                if (raw.COLOR(y, x) != source->cfa[(y % source->cfaSize) * source->cfaSize + x]) {
                    throw GpuLayoutUnsupported("Non-periodic mosaic requires CPU preparation");
                }
            }
        }
    }
    source->white = levels.maximum;
}

static void prepare_camera_rgb(Raw *source) {
    auto &raw = source->decoder;
    if (source->originalOffset) {
        check(raw.unpack());
    }
    auto &options = raw.imgdata.params;
    options.no_auto_scale = 1;
    options.no_auto_bright = 1;
    options.adjust_maximum_thr = 0;
    options.output_color = 0;
    options.gamm[0] = options.gamm[1] = 1;
    options.use_fuji_rotate = 1;
    check(raw.dcraw_process());
    source->cpuPrepared = true;
    source->originalOffset = 0;
}

void prepare_pixels(Raw *source, void *bytes, unsigned length) {
    auto &raw = source->decoder;
    check(raw.open_buffer(bytes, length));
    source->sensorMosaic = raw.imgdata.idata.filters != 0;
    raw.imgdata.rawparams.options &= ~LIBRAW_RAWOPTIONS_CONVERTFLOAT_TO_INT;
    if (raw.imgdata.idata.dng_version) {
        parse_dng(source, bytes, length);
    }

    // A mosaic usable straight from the file skips LibRaw's unpacking.
    source->originalOffset = direct_bayer(source, bytes, length);
    if (!source->originalOffset) {
        check(raw.unpack());
    }
    if (raw.imgdata.idata.colors != 3 || raw.imgdata.color.as_shot_wb_applied ||
        raw.is_floating_point()) {
        throw std::runtime_error("This RAW sensor layout is not supported by the GPU pipeline");
    }

    // Choose how the samples reach the GPU. LibRaw's filters value is 9 for X-Trans, above 1000
    // for a 2x2 Bayer pattern and zero for full-color images.
    source->cpuPrepared = raw.is_fuji_rotated() || raw.imgdata.idata.is_foveon || raw.is_sraw() ||
                          raw.is_nikon_sraw();
    if (source->originalOffset) {
        raw.imgdata.sizes.iwidth = raw.imgdata.sizes.width;
        raw.imgdata.sizes.iheight = raw.imgdata.sizes.height;
    } else if (source->cpuPrepared) {
        prepare_camera_rgb(source);
    } else if (raw.imgdata.idata.dng_version && raw.imgdata.idata.filters > 1000 &&
               raw.imgdata.rawdata.raw_image && raw.imgdata.sizes.top_margin == 0 &&
               raw.imgdata.sizes.left_margin == 0 &&
               raw.imgdata.sizes.raw_pitch == raw.imgdata.sizes.width * 2 &&
               raw.imgdata.sizes.raw_height == raw.imgdata.sizes.height) {
        // Standard uncropped DNG can keep LibRaw's single-channel allocation.
        raw.imgdata.sizes.iwidth = raw.imgdata.sizes.width;
        raw.imgdata.sizes.iheight = raw.imgdata.sizes.height;
    } else {
        check(raw.raw2image_ex(0));
    }

    try {
        describe_pixels(source);
    } catch (const GpuLayoutUnsupported &) {
        if (source->cpuPrepared) {
            throw;
        }
        prepare_camera_rgb(source);
        describe_pixels(source);
    }
}

void pack_pixels(Raw *source) {
    auto &raw = source->decoder;
    if (source->prepared.empty() && source->mosaic && raw.imgdata.image) {
        // Preserve LibRaw's camera-specific preparation, then pack its sparse image in place.
        // Every write lands at or before the sample it read, so a forward walk is safe.
        auto *packed = reinterpret_cast<unsigned short *>(raw.imgdata.image);
        for (unsigned y = 0; y < source->height; ++y) {
            for (unsigned x = 0; x < source->width; ++x) {
                unsigned i = y * source->width + x;
                packed[i] =
                    raw.imgdata.image[i][source->cfa[(y % source->cfaSize) * source->cfaSize +
                                                     x % source->cfaSize]];
            }
        }
    }
}
