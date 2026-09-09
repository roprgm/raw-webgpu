# TIFF extension benchmark

Historical experiment, September 9, 2026. Build sizes and decisions below describe that experiment, not necessarily the current package. See [the current RAW benchmark](RAW-BENCHMARK.md) and [README](README.md) for current behavior and limitations.

Baseline commit: `a9fb2d7` (`Add RAW decoding and WebGPU development`).

## Method

Chromium 151 on this Mac. Both paths use the same WebGPU device, a fresh worker per image and the same Blob already loaded into memory. Times include worker startup, decoding, CPU-to-GPU transfer, color conversion and orientation, ending at `queue.onSubmittedWorkDone()`. File download, device setup, readback and cleanup are excluded. Each file gets one first load followed by five timed loads per implementation, alternating order. These are local measurements, not a network or cross-device benchmark.

The reference bundles OpenLight’s actual TIFF worker, `prepareTiff` and `uploadTiff`; the candidate calls the exported `decodeTiff`. Both produce linear Rec.2020 RGBA16F. Three sample pixels are compared per large image outside the timed section, with a maximum allowed difference of 0.002.

## Large files from OpenLight public/debug

| File | Size MB | tiff-gpu median ms | raw-webgpu median ms | Ratio new / old |
|---|---:|---:|---:|---:|
| _DSC5765-Pano-B.tif | 75.2 | 363.2 | 457.4 | 1.26× |
| tif-example-srgb-16bit.tif | 114.4 | 56.1 | 98.4 | 1.75× |
| tif-example-srgb-8bit.tif | 57.2 | 38.4 | 59.1 | 1.54× |
| tiff-example-rec2020-16bit.tif | 114.4 | 55.1 | 94.0 | 1.71× |

Maximum sampled channel difference: 0.00024414. No WebGPU validation errors.

The three example files are uncompressed single-strip images, 3274×5821, RGB 8/16-bit. The panorama is 3423×4279 RGB16, Deflate compression in 84 strips.

The new path is slower on all four files in this run. It decodes TIFF samples into a native CPU allocation and copies them through the WASM heap before GPU upload. The existing uncompressed path can transfer encoded bytes and prepare samples directly in GPU. This explains additional work in the candidate; this benchmark does not separately profile the contribution of each copy or codec.

## Fixture coverage

| Fixture | Result |
|---|---|
| alpha16.tif | Pass: reference pixels within tolerance |
| bilevel.tif | Error: Unsupported TIFF pixel layout or compression |
| float32-be.tif | Pass: reference pixels within tolerance |
| float64.tif | Error: TIFF samples wider than 32 bits are not supported |
| gray16-para.tif | Pass: reference pixels within tolerance |
| half-predictor.tif | Pass: reference pixels within tolerance |
| lzw-strips.tif | Pass: reference pixels within tolerance |
| lzw-tiles.tif | Pass: reference pixels within tolerance |
| orientation-3.tif | Pass: reference pixels within tolerance |
| orientation-6.tif | Pass: reference pixels within tolerance |
| packed12.tif | Pass: reference pixels within tolerance |
| palette8.tif | Error: Unsupported TIFF pixel layout or compression |
| precision16.tif | Pass: reference pixels within tolerance |
| rgb16-bigtiff.tif | Pass: reference pixels within tolerance |
| rgb16-le.tif | Pass: reference pixels within tolerance |
| rgb16-lzw-be.tif | Pass: reference pixels within tolerance |
| rgb16-planar-tiled.tif | Pass: reference pixels within tolerance |
| rgb16-prophoto.tif | Pass: reference pixels within tolerance |
| rgb8-jpeg.tif | Error: Unsupported TIFF pixel layout or compression |
| rgb8-packbits.tif | Pass: reference pixels within tolerance |
| rgb8-srgb-table.tif | Pass: reference pixels within tolerance |

17 of 21 fixtures decode with correct reference pixels. Four are explicitly rejected: bilevel, palette, float64 and YCbCr JPEG. The JPEG fixture is also rejected by tiff-gpu; the other three are coverage regressions relative to tiff-gpu. Do not replace OpenLight’s TIFF loader with this extension yet.

## Reproduce

Run `bun run test:tiff` for the standalone fixtures. Run `bun run benchmark:tiff` with OpenLight checked out beside raw-webgpu for the photographic comparison. Override its location with `OPENLIGHT`. Full timings and first loads are in `.cache/tiff-benchmark.json`; fixture results are in `.cache/tiff-fixtures.json`. The shared harness is `tests/tiff.browser.ts`.
