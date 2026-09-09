# RAW fixtures

These generated images belong to OpenLight and use the repository's MIT license. They contain no camera photographs. Run `python3 generate.py` with NumPy, tifffile and imagecodecs installed to regenerate them.

The Bayer and linear JPEG XL fixtures describe an sRGB-like synthetic camera with a known XYZ-to-camera matrix, unit As Shot neutral, 16-bit white level 65535, and orientation 6. The image is 128 by 96 before orientation and 96 by 128 afterwards. `bayer.dng` stores uncompressed RGGB samples. `linear-jxl.dng` stores the equivalent linear camera RGB using lossless JPEG XL.

The camera samples are R=32768, G=16384, B=8192. `reference.json` records the independently calculated linear Rec.2020 values. The corresponding sRGB export should be approximately [188, 137, 99]. This checks transfer function, channel order, matrix conversion, bit depth, orientation and JPEG XL decoding without a photographic reference whose expected pixels are unknown.

The three additional Bayer phase fixtures cover BGGR, GRBG and GBRG. The odd ActiveArea crop checks CFA phase after library preparation. The 600 by 600 X-Trans fixture exercises the CPU demosaic fallback. All fixtures use the same constant camera samples and color calibration.
