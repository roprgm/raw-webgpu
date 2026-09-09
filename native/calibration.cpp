#include "dng_camera_profile.h"
#include "dng_color_space.h"
#include "dng_color_spec.h"
#include "dng_host.h"
#include "dng_ifd.h"
#include "dng_info.h"
#include "dng_lens_correction.h"
#include "dng_negative.h"
#include "dng_opcode_list.h"
#include "dng_stream.h"
#include "dng_temperature.h"
#include "raw.h"
#include <cmath>
#include <libraw/libraw.h>
#include <memory>
#include <stdexcept>
#include <string>

// Reads the DNG vignette opcode into source->vignette: five polynomial coefficients, then the
// origin and per-axis scale that map pixel centers to the radius the polynomial expects.
static void read_vignette(Raw *source, const dng_opcode &opcode) {
    const auto &params = static_cast<const dng_opcode_FixVignetteRadial &>(opcode).Params();
    for (int k = 0; k < 5; ++k) {
        source->vignette[k] = params.fParams[k];
    }
    double cx = source->width * params.fCenter.h, cy = source->height * params.fCenter.v;
    double aspect = source->negative->PixelAspectRatio();
    double radius =
        std::hypot(std::max(cx, source->width - cx), std::max(cy, source->height - cy) / aspect);
    source->vignette[5] = -cx / radius;
    source->vignette[6] = -cy / (aspect * radius);
    source->vignette[7] = 1 / radius;
    source->vignette[8] = 1 / (aspect * radius);
}

void prepare_calibration(Raw *source, void *bytes, unsigned length) {
    auto &raw = source->decoder;
    source->negative.Reset(source->host.Make_dng_negative());

    if (source->info) {
        // DNG carries its own camera profiles; also check the opcodes the GPU path cannot apply.
        dng_stream stream(bytes, length);
        auto &info = *source->info;
        source->negative->Parse(source->host, stream, info);
        source->negative->PostParse(source->host, stream, info);

        const auto &ifd = *info.fIFD[info.fMainIndex];
        source->opcodes[0] = ifd.fOpcodeList1Count;
        source->opcodes[1] = ifd.fOpcodeList2Count;
        source->opcodes[2] = ifd.fOpcodeList3Count;
        const uint64 offsets[] = {ifd.fOpcodeList1Offset, ifd.fOpcodeList2Offset,
                                  ifd.fOpcodeList3Offset};
        bool hasVignette = false;
        bool needsPreparation = ifd.fBlackLevelDeltaHCount || ifd.fBlackLevelDeltaVCount;
        for (unsigned stage = 0; stage < 3; ++stage) {
            if (!source->opcodes[stage]) {
                continue;
            }
            dng_opcode_list list(stage + 1);
            list.Parse(source->host, stream, source->opcodes[stage], offsets[stage]);
            for (unsigned i = 0; i < list.Count(); ++i) {
                const auto &opcode = list.Entry(i);
                if (stage == 2 && opcode.OpcodeID() == dngOpcode_FixVignetteRadial &&
                    !hasVignette) {
                    read_vignette(source, opcode);
                    hasVignette = true;
                } else if (!opcode.Optional()) {
                    needsPreparation = true;
                }
            }
        }
        if (needsPreparation) {
            prepare_dng_pixels(source, bytes, length);
        }
    } else if (raw.imgdata.idata.colors == 3) {
        // Other formats: wrap LibRaw's camera matrix as a single D65 profile.
        source->negative->SetColorChannels(3);
        AutoPtr<dng_camera_profile> profile(new dng_camera_profile);
        dng_matrix matrix(3, 3);
        for (int row = 0; row < 3; ++row) {
            for (int col = 0; col < 3; ++col) {
                matrix[row][col] = raw.imgdata.color.cam_xyz[row][col];
            }
        }
        profile->SetColorMatrix1(matrix);
        profile->SetCalibrationIlluminant1(21); // D65 calibration in LibRaw camera tables.
        source->negative->AddProfile(profile);
    }

    // The as-shot multipliers give the camera neutral, which the profile turns into chromaticity.
    if (source->negative->ProfileCount()) {
        source->color = std::make_unique<dng_color_spec>(*source->negative,
                                                         &source->negative->ProfileByIndex(0));
        dng_vector neutral(source->color->Channels());
        bool valid = true;
        for (unsigned c = 0; c < neutral.Count(); ++c) {
            float multiplier = raw.imgdata.color.cam_mul[c];
            valid &= multiplier > 0 && std::isfinite(multiplier);
            neutral[c] = multiplier > 0 ? 1.0 / multiplier : 1.0;
        }
        if (!valid) {
            // LibRaw supplies daylight multipliers when the file has no usable camera neutral.
            source->daylightBalance = true;
            for (unsigned c = 0; c < neutral.Count(); ++c) {
                float multiplier = raw.imgdata.color.pre_mul[c];
                if (!(multiplier > 0) || !std::isfinite(multiplier)) {
                    throw std::runtime_error("RAW file has no usable white balance calibration");
                }
                neutral[c] = 1.0 / multiplier;
            }
        }
        source->asShotXY = source->color->NeutralToXY(neutral);
        source->asShot = dng_temperature(source->asShotXY);
    }
    if (!source->color || !(source->asShot.Temperature() > 0)) {
        throw std::runtime_error("RAW camera calibration is not supported");
    }
}

// A zero temperature selects the exact as-shot chromaticity.
double *calibrate(Raw *source, double temperature, double tint) {
    source->color->SetWhiteXY(temperature > 0 ? dng_temperature(temperature, tint).Get_xy_coord()
                                              : source->asShotXY);
    const auto &white = source->color->CameraWhite();
    auto matrix = dng_space_Rec2020_Linear::Get().MatrixFromPCS() * source->color->CameraToPCS();

    // Gains neutralize the camera white; the matrix folds it back in, so gains then matrix equals
    // the SDK's camera-to-Rec.2020 transform while still exposing the white balance.
    for (int c = 0; c < 3; ++c) {
        source->calibration[c] = 1.0 / white[c];
        for (int r = 0; r < 3; ++r) {
            source->calibration[3 + r * 3 + c] = matrix[r][c] * white[c];
        }
    }
    return source->calibration;
}
