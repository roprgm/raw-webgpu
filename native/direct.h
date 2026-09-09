#pragma once

#include "dng_ifd.h"
#include "dng_stream.h"

// Byte offset of the image data when it can be used straight from the file: one uncompressed
// strip, native-sized samples, no predictor. Zero otherwise.
inline uint32 uncompressed_offset(const dng_ifd &ifd, dng_stream &stream) {
    if (ifd.fCompression != 1 || ifd.fPredictor != 1 || ifd.fPlanarConfiguration != 1 ||
        ifd.fFillOrder != 1 || !ifd.fUsesStrips || ifd.fTileOffsetsCount != 1 ||
        ifd.fTileByteCountsCount != 1 ||
        (ifd.fBitsPerSample[0] != 8 && ifd.fBitsPerSample[0] != 16 &&
         ifd.fBitsPerSample[0] != 32)) {
        return 0;
    }

    stream.SetReadPosition(ifd.fTileOffsetsOffset);
    const auto offset = stream.TagValue_uint64(ifd.fTileOffsetsType);
    stream.SetReadPosition(ifd.fTileByteCountsOffset);
    const auto count = stream.TagValue_uint64(ifd.fTileByteCountsType);

    const uint64 bytes = uint64(ifd.fImageWidth) * ifd.fImageLength * ifd.fSamplesPerPixel *
                         (ifd.fBitsPerSample[0] / 8);
    if (offset > stream.Length() || bytes > stream.Length() - offset || count < bytes ||
        offset > UINT32_MAX) {
        return 0;
    }
    return uint32(offset);
}
