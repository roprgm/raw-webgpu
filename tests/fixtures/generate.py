"""Generate synthetic RAW fixtures with known camera samples and color values."""

import json
from pathlib import Path

import imagecodecs
import numpy as np
import tifffile

ROOT = Path(__file__).parent
CAMERA_SAMPLES = np.array([32768, 16384, 8192], dtype=np.uint16)
CAMERA_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
CAMERA_TO_REC2020 = np.array(
    [
        [0.627404, 0.329283, 0.043313],
        [0.069097, 0.91954, 0.011362],
        [0.016391, 0.088013, 0.895595],
    ]
)


def rationals(values):
    denominator = 10_000_000
    return tuple(
        number
        for value in values
        for number in (round(value * denominator), denominator)
    )


def camera_tags():
    return [
        (254, "I", 1, 0, False),  # NewSubfileType
        (50706, "B", 4, (1, 7, 1, 0), False),  # DNGVersion
        (50707, "B", 4, (1, 7, 1, 0), False),  # DNGBackwardVersion
        (50721, "2i", 9, rationals(np.linalg.inv(CAMERA_TO_XYZ).flatten()), False),
        (50728, "2I", 3, rationals([1, 1, 1]), False),  # AsShotNeutral
        (50717, "I", 1, 65535, False),  # WhiteLevel
        (50778, "H", 1, 21, False),  # CalibrationIlluminant1: D65
        (274, "H", 1, 6, False),  # Orientation
        (50708, "s", 0, "OpenLight Synthetic Camera", False),
    ]


def write_mosaic(name, pattern, repeats, active_area=None):
    samples = CAMERA_SAMPLES[np.tile(pattern, repeats)]
    tags = camera_tags() + [
        (33421, "H", 2, pattern.shape, False),  # CFARepeatPatternDim
        (33422, "B", pattern.size, tuple(pattern.flatten()), False),  # CFAPattern
    ]
    if active_area:
        # CFAPattern is relative to ActiveArea; an odd RGGB crop begins on blue.
        tags[-1] = (33422, "B", 4, (2, 1, 1, 0), False)
        tags.append((50829, "I", 4, active_area, False))
    tifffile.imwrite(
        ROOT / name,
        samples,
        photometric=32803,
        rowsperstrip=samples.shape[0],
        metadata=None,
        extratags=tags,
    )


def write_linear_jxl():
    pixels = np.broadcast_to(CAMERA_SAMPLES, (96, 128, 3)).copy()
    encoded = imagecodecs.jpegxl_encode(pixels, lossless=True)
    path = ROOT / "linear-jxl.dng"
    tifffile.imwrite(
        path,
        iter([encoded]),
        shape=pixels.shape,
        dtype=pixels.dtype,
        photometric=2,
        rowsperstrip=96,
        compression=52546,
        metadata=None,
        extratags=camera_tags(),
    )
    # tifffile uses the TIFF JPEG XL code; DNG requires compression code 34892.
    with tifffile.TiffFile(path) as image:
        compression_offset = image.pages[0].tags[262].valueoffset
    with path.open("r+b") as image:
        image.seek(compression_offset)
        image.write((34892).to_bytes(2, "little"))


def main():
    bayer_patterns = {
        "bayer.dng": [[0, 1], [1, 2]],
        "bayer-bggr.dng": [[2, 1], [1, 0]],
        "bayer-grbg.dng": [[1, 0], [2, 1]],
        "bayer-gbrg.dng": [[1, 2], [0, 1]],
    }
    for name, pattern in bayer_patterns.items():
        write_mosaic(name, np.array(pattern), (48, 64))
    write_mosaic(
        "bayer-cropped.dng",
        np.array(bayer_patterns["bayer.dng"]),
        (48, 64),
        active_area=(1, 1, 95, 127),
    )
    xtrans = np.array(
        [
            [1, 0, 1, 1, 2, 1],
            [2, 1, 2, 0, 1, 0],
            [1, 0, 1, 1, 2, 1],
            [1, 2, 1, 1, 0, 1],
            [0, 1, 0, 2, 1, 2],
            [1, 2, 1, 1, 0, 1],
        ],
        dtype=np.uint8,
    )
    # LibRaw's CPU fallback needs an image larger than its demosaic tile.
    write_mosaic("xtrans.dng", xtrans, (100, 100))
    write_linear_jxl()
    expected = CAMERA_TO_REC2020 @ CAMERA_SAMPLES / 65535
    reference = {"width": 96, "height": 128, "expectedRgb": expected.tolist()}
    (ROOT / "reference.json").write_text(json.dumps(reference, indent=2))


if __name__ == "__main__":
    main()
