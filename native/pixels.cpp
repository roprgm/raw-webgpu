#include "raw.h"
#include <stdexcept>

static void check(int code) {
    if (code) {
        throw std::runtime_error(libraw_strerror(code));
    }
}

void prepare_pixels(Raw *source, void *bytes, unsigned length) {
    auto &raw = source->decoder;
    check(raw.open_buffer(bytes, length));
    raw.imgdata.rawparams.options &= ~LIBRAW_RAWOPTIONS_CONVERTFLOAT_TO_INT;
    check(raw.unpack());
    if (raw.imgdata.idata.colors != 3 || raw.imgdata.color.as_shot_wb_applied || raw.is_sraw() ||
        raw.is_nikon_sraw() || raw.is_floating_point() || raw.is_fuji_rotated()) {
        throw std::runtime_error("This RAW sensor layout is not supported by the GPU pipeline");
    }
    source->cpuDemosaic = raw.imgdata.idata.filters == 9;
    if (source->cpuDemosaic) {
        auto &options = raw.imgdata.params;
        options.no_auto_scale = 1;
        options.no_auto_bright = 1;
        options.adjust_maximum_thr = 0;
        options.output_color = 0;
        options.gamm[0] = options.gamm[1] = 1;
        options.use_fuji_rotate = 0;
        check(raw.dcraw_process());
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
    auto &idata = raw.imgdata.idata;
    auto &levels = raw.imgdata.color;
    auto &sizes = raw.imgdata.sizes;
    if ((!source->cpuDemosaic && idata.filters && idata.filters < 1000) ||
        sizes.iwidth != sizes.width || sizes.iheight != sizes.height) {
        throw std::runtime_error("This RAW mosaic is not supported by the GPU pipeline");
    }
    if (source->cpuDemosaic) {
        idata.filters = 0;
    }
    unsigned rows = levels.cblack[4], cols = levels.cblack[5];
    if ((rows && cols) && ((idata.filters && (rows > 2 || cols > 2)) ||
                           (!idata.filters && (rows != 1 || cols != 1)))) {
        throw std::runtime_error("This RAW black calibration is not supported by the GPU pipeline");
    }
    source->width = sizes.width;
    source->height = sizes.height;
    if (sizes.width < 3 || sizes.height < 3) {
        throw std::runtime_error("RAW image is too small for the GPU pipeline");
    }
    source->flip = sizes.flip;
    source->mosaic = idata.filters ? 1 : 0;
    bool seen[4] = {};
    int counts[3] = {};
    for (int p = 0; p < 4; ++p) {
        int channel = idata.filters ? raw.COLOR(p / 2, p % 2) : p;
        source->cfa[p] = channel;
        double black = levels.black + levels.cblack[channel];
        if (rows && cols) {
            black += levels.cblack[6 + (p / 2 % rows) * cols + p % 2 % cols];
        }
        if (seen[channel] && source->black[channel] != black) {
            throw std::runtime_error(
                "Spatial RAW black calibration is not supported by the GPU pipeline");
        }
        seen[channel] = true;
        source->black[channel] = black;
        if (black >= levels.maximum) {
            throw std::runtime_error("Invalid RAW black and white calibration");
        }
        if (idata.filters) {
            counts[channel == 3 ? 1 : channel]++;
        }
    }
    if (idata.filters) {
        if (counts[0] != 1 || counts[1] != 2 || counts[2] != 1) {
            throw std::runtime_error("Only RGB Bayer mosaics are supported by the GPU pipeline");
        }
        if (((source->cfa[0] == 0 || source->cfa[0] == 2)
                 ? (source->cfa[3] == 1 || source->cfa[3] == 3)
                 : (source->cfa[3] == 0 || source->cfa[3] == 2))) {
            throw std::runtime_error(
                "Only diagonal RGB Bayer mosaics are supported by the GPU pipeline");
        }
        for (int y = 0; y < 8; ++y) {
            for (int x = 0; x < 2; ++x) {
                if (raw.COLOR(y, x) != source->cfa[(y % 2) * 2 + x]) {
                    throw std::runtime_error(
                        "Only 2x2 Bayer mosaics are supported by the GPU pipeline");
                }
            }
        }
    }
    source->white = levels.maximum;
}

void pack_pixels(Raw *source) {
    auto &raw = source->decoder;
    if (source->mosaic && raw.imgdata.image) {
        // Preserve LibRaw's camera-specific preparation, then pack its sparse image in place.
        auto *packed = reinterpret_cast<unsigned short *>(raw.imgdata.image);
        for (unsigned y = 0; y < source->height; ++y) {
            for (unsigned x = 0; x < source->width; ++x) {
                unsigned i = y * source->width + x;
                packed[i] = raw.imgdata.image[i][source->cfa[(y % 2) * 2 + x % 2]];
            }
        }
    }
}
