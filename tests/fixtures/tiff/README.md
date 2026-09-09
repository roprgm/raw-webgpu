# Fixtures

Small synthetic TIFF files, one per feature, written once with tifffile. `reference.json` holds the output size and, for a few pixels of each, the linear Rec.2020 `rgba` reference values for the decoder, computed from standard sRGB and ICC color math rather than from the shaders.

Most files hold a 19×17 RGB gradient where red is `x·3000 + 123`, green `y·3500 + 45`, and blue `(x + y)·1700 + 67` in 16 bits, or those values shifted to 8 bits.

| File | What it covers |
| --- | --- |
| `rgb16-le.tif` | Uncompressed strips, little-endian |
| `rgb16-lzw-be.tif` | LZW, big-endian |
| `rgb16-planar-tiled.tif` | Deflate, horizontal prediction, planar 16×16 tiles |
| `rgb16-bigtiff.tif` | BigTIFF |
| `rgb8-packbits.tif` | PackBits, 8-bit |
| `lzw-strips.tif` | 200×130 gradient in 130 one-row LZW strips with prediction, enough for the GPU codec |
| `lzw-tiles.tif` | 40×17 8-bit gray `(x·6 + y·3) % 256` in 16×16 LZW tiles with prediction, so bottom tiles are clipped |
| `rgb16-prophoto.tif` | ICC profile with ProPhoto colorants and a gamma 1.8 `curv` |
| `rgb8-srgb-table.tif` | ICC profile with sRGB colorants and a 256-entry `curv` table |
| `gray16-para.tif` | 5×7 gray at 16384 with a `para` sRGB `kTRC` profile |
| `bilevel.tif` | 1-bit, white is zero, black where `(x + y) % 3 == 0` |
| `palette8.tif` | 8-bit indices `(x·7 + y·11) % 256` into a 256-entry color map |
| `alpha16.tif` | 5×7 associated alpha: premultiplied `[8192, 16384, 24576]` at alpha 32768 |
| `orientation-3.tif`, `orientation-6.tif` | Orientation tags 3 and 6 |
| `float32-be.tif`, `float64.tif`, `half-predictor.tif` | Floats `-0.125, 0, 0.18, 0.5, 1, 2, 4` across a 7×3 image, big-endian 32-bit, 64-bit, and 16-bit with Deflate and floating-point prediction |
| `precision16.tif` | 2×1 gray with adjacent values 32768 and 32800 |
| `packed12.tif` | 9×5 gray `(x·397 + y·811) % 4096` in packed 12-bit samples, as raw camera files store them |
| `rgb8-jpeg.tif` | JPEG compression, which the decoder must reject |
