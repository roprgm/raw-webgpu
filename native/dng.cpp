// The SDK owns mandatory DNG corrections and their ordering. This compatibility path starts
// from the original file so LibRaw's linearization and black subtraction cannot run twice.
#include "dng_image.h"
#include "dng_pixel_buffer.h"
#include "dng_tag_types.h"
#include "raw.h"
#include <algorithm>
#include <stdexcept>

void prepare_dng_pixels(Raw *source, void *bytes, unsigned length) {
    dng_stream stream(bytes, length);
    auto &negative = *source->negative;
    negative.ReadStage1Image(source->host, stream, *source->info);
    negative.BuildStage2Image(source->host);
    negative.BuildStage3Image(source->host);
    const auto &image = *negative.Stage3Image();
    if (image.Planes() != 3) {
        throw std::runtime_error("DNG preparation did not produce three-channel camera RGB");
    }
    source->width = image.Bounds().W();
    source->height = image.Bounds().H();
    source->prepared.resize(size_t(source->width) * source->height * 4);
    dng_pixel_buffer buffer;
    buffer.fArea = image.Bounds();
    buffer.fPlane = 0;
    buffer.fPlanes = 3;
    buffer.fRowStep = source->width * 4;
    buffer.fColStep = 4;
    buffer.fPlaneStep = 1;
    buffer.fPixelType = ttFloat;
    buffer.fPixelSize = sizeof(float);
    buffer.fData = source->prepared.data();
    image.Get(buffer);
    AutoPtr<dng_image> empty;
    negative.SetStage3Image(empty); // Keep calibration, release the SDK pixel allocation.
    source->cpuPrepared = true;
    source->mosaic = 0;
    source->originalOffset = 0;
    source->white = 1;
    std::fill_n(source->black, 4, 0);
    std::fill_n(source->vignette, 9, 0); // Stage 3 already applied the opcode list.
}
