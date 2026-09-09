#pragma once

#include "dng_color_spec.h"
#include "dng_host.h"
#include "dng_info.h"
#include "dng_negative.h"
#include "dng_temperature.h"
#include <libraw/libraw.h>
#include <memory>
#include <vector>

// One open RAW file: LibRaw decodes the samples, the DNG SDK owns the color calibration.
struct Raw {
    dng_host host;
    LibRaw decoder;
    std::unique_ptr<dng_info> info; // Parsed once for DNG files, null otherwise.
    AutoPtr<dng_negative> negative;
    std::unique_ptr<dng_color_spec> color;
    dng_temperature asShot;
    dng_xy_coord asShotXY;

    // Sensor layout, mirrored by RawMetadata in src/types.ts.
    unsigned width, height, flip, mosaic;
    bool cpuPrepared = false;
    bool sensorMosaic = false;
    bool daylightBalance = false;
    std::vector<float> prepared; // SDK-normalized camera RGB, with HDR headroom.
    unsigned originalOffset = 0; // Byte offset of a usable mosaic inside the file, or zero.
    unsigned cfa[36] = {};
    unsigned cfaSize = 2;
    double black[4] = {};
    double white;
    double vignette[9] = {};

    double calibration[12] = {}; // Three gains, then a row-major 3x3 matrix.
    unsigned opcodes[3] = {};    // DNG opcode counts per list.

    Raw() {
        decoder.set_dng_host(&host);
    }
};

void prepare_pixels(Raw *source, void *bytes, unsigned length);
void pack_pixels(Raw *source);
void prepare_dng_pixels(Raw *source, void *bytes, unsigned length);
void prepare_calibration(Raw *source, void *bytes, unsigned length);
double *calibrate(Raw *source, double temperature, double tint);
