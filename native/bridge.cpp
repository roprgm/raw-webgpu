// C entry points called from src/decode/worker.ts; see src/decode/libraw.d.ts for the signatures.

#include "raw.h"
#include <emscripten/emscripten.h>
#include <stdexcept>
#include <string>

static std::string error;

extern "C" {

EMSCRIPTEN_KEEPALIVE const char *raw_error() {
    return error.c_str();
}

EMSCRIPTEN_KEEPALIVE Raw *raw_open(void *bytes, unsigned length) {
    try {
        auto source = std::make_unique<Raw>();
        prepare_pixels(source.get(), bytes, length);
        prepare_calibration(source.get(), bytes, length);
        pack_pixels(source.get());
        return source.release();
    } catch (const std::exception &exception) {
        error = exception.what();
    } catch (...) {
        error = "RAW calibration or decoding failed";
    }
    return nullptr;
}

EMSCRIPTEN_KEEPALIVE double *raw_calibration(Raw *source, double temperature, double tint) {
    try {
        return calibrate(source, temperature, tint);
    } catch (...) {
        error = "RAW white balance calibration failed";
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE unsigned raw_original_offset(Raw *source) {
    return source->originalOffset;
}

EMSCRIPTEN_KEEPALIVE unsigned raw_width(Raw *source) {
    return source->width;
}

EMSCRIPTEN_KEEPALIVE unsigned raw_height(Raw *source) {
    return source->height;
}

EMSCRIPTEN_KEEPALIVE unsigned raw_flip(Raw *source) {
    return source->flip;
}

EMSCRIPTEN_KEEPALIVE unsigned raw_cpu_demosaic(Raw *source) {
    return source->cpuPrepared && source->sensorMosaic;
}

EMSCRIPTEN_KEEPALIVE unsigned raw_float(Raw *source) {
    return !source->prepared.empty();
}

EMSCRIPTEN_KEEPALIVE unsigned raw_daylight_balance(Raw *source) {
    return source->daylightBalance;
}

EMSCRIPTEN_KEEPALIVE unsigned raw_mosaic(Raw *source) {
    return source->mosaic;
}

EMSCRIPTEN_KEEPALIVE unsigned raw_cfa_size(Raw *source) {
    return source->cfaSize;
}

EMSCRIPTEN_KEEPALIVE unsigned *raw_cfa(Raw *source) {
    return source->cfa;
}

EMSCRIPTEN_KEEPALIVE double *raw_black(Raw *source) {
    return source->black;
}

EMSCRIPTEN_KEEPALIVE double *raw_vignette(Raw *source) {
    return source->vignette;
}

EMSCRIPTEN_KEEPALIVE double raw_white(Raw *source) {
    return source->white;
}

// Packed samples: LibRaw's processed image when one was made, else its raw buffer.
EMSCRIPTEN_KEEPALIVE void *raw_pixels(Raw *source) {
    if (!source->prepared.empty()) {
        return source->prepared.data();
    }
    return source->decoder.imgdata.image
               ? static_cast<void *>(source->decoder.imgdata.image)
               : static_cast<void *>(source->decoder.imgdata.rawdata.raw_image);
}

// Releases the decoded samples once copied out; calibration stays available.
EMSCRIPTEN_KEEPALIVE void raw_free_pixels(Raw *source) {
    source->decoder.recycle();
    std::vector<float>().swap(source->prepared);
}

EMSCRIPTEN_KEEPALIVE double raw_temperature(Raw *source) {
    return source->asShot.Temperature();
}

EMSCRIPTEN_KEEPALIVE double raw_tint(Raw *source) {
    return source->asShot.Tint();
}

EMSCRIPTEN_KEEPALIVE void raw_close(Raw *source) {
    delete source;
}
}
