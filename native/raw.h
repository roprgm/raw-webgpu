#pragma once

#include "dng_color_spec.h"
#include "dng_host.h"
#include "dng_negative.h"
#include "dng_temperature.h"
#include <libraw/libraw.h>
#include <memory>

struct Raw {
    dng_host host;
    LibRaw decoder;
    AutoPtr<dng_negative> negative;
    std::unique_ptr<dng_color_spec> color;
    dng_temperature asShot;
    dng_xy_coord asShotXY;
    unsigned width, height, flip, mosaic;
    bool cpuDemosaic = false;
    unsigned cfa[4] = {};
    double black[4] = {};
    double white;
    double vignette[9] = {};
    double calibration[12] = {};
    unsigned opcodes[3] = {};
    Raw() {
        decoder.set_dng_host(&host);
    }
};

void prepare_pixels(Raw *source, void *bytes, unsigned length);
void pack_pixels(Raw *source);
void prepare_calibration(Raw *source, void *bytes, unsigned length);
double *calibrate(Raw *source, double temperature, double tint);
