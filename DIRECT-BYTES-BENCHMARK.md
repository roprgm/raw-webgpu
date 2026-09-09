# Original-byte upload experiment

Historical experiment, September 9, 2026. Build sizes and decisions below describe that experiment, not necessarily the current package. See [the current RAW benchmark](RAW-BENCHMARK.md) and [README](README.md) for current behavior and limitations.

The baseline git commit remains `a9fb2d7`. The frozen build immediately before this experiment is in ignored `.cache/before-direct/dist`.

## Method

Same Mac, Chromium 151, same device and in-memory file per comparison. One first load is excluded, followed by five loads per implementation in alternating/rotating order. Total time includes fresh worker startup, native module initialization, decoding/preparation, transfer and GPU development through queue completion. File download, device setup and pixel readback are excluded. The TIFF reference uses OpenLight’s actual worker and GPU loader. First-load values and all samples remain in the JSON results.

## TIFF files from OpenLight public/debug

| File | Compression | tiff-gpu ms | Previous raw-webgpu ms | Direct-capable raw-webgpu ms |
|---|---|---:|---:|---:|
| _DSC5765-Pano-B.tif | Deflate, 84 strips | 364.5 | 460.2 | 451.5 |
| tif-example-srgb-16bit.tif | None, one strip | 57.6 | 105.9 | 69.2 |
| tif-example-srgb-8bit.tif | None, one strip | 38.8 | 60.7 | 47.7 |
| tiff-example-rec2020-16bit.tif | None, one strip | 60.0 | 90.0 | 69.4 |

The direct path removes the SDK decoded image allocation and the copied pixel output for eligible TIFFs. Big-endian interpretation moves to the GPU. It still copies the file into WASM so the SDK can parse metadata. The compressed panorama keeps its original path; its small timing change is not evidence of a codec optimization.

## RAW/DNG

| File | Previous ms | New ms | Direct path used |
|---|---:|---:|---|
| Bayer 12MP uncompressed | 77.2 | 31.2 | Yes |
| Bayer 12MP lossless JPEG | 193.3 | 191.6 | No |
| Linear 12MP JPEG XL | 1220.4 | 1223.7 | No |
| iPhone DNG | 1034.9 | 1042.8 | No |
| Sony ARW | 387.1 | 366.8 | No |

Only unsigned little-endian 16-bit Bayer DNG in one uncompressed strip can take the new RAW path. Crops, linearization tables and stage-1/2 opcodes disable it. LibRaw identifies the file; DNG SDK validates the layout and supplies calibration. GPU demosaic and color processing are unchanged. The synthetic Bayer fixture qualifies; compressed DNG and Sony ARW do not. Timing changes on fallback files must not be attributed to this optimization.

The iPhone file is `public/debug/IMG_3460.DNG`. Its metadata says Apple iPhone 17 Pro; its main linear RGB image uses JPEG XL compression 52546. It decoded successfully in both builds. This is now real iPhone JPEG XL coverage, in addition to the synthetic fixture.

## Correctness and limits

All 21 tiff-gpu fixtures were exercised: 17 match reference pixels and four retain explicit unsupported errors. RAW browser fixtures pass, including Bayer phases, crop, X-Trans fallback and white-balance restoration. Three RAW pixels per benchmark image match bit-for-bit across all runs. Large TIFF samples remain within 0.002 per channel of tiff-gpu. No GPU validation errors were reported.

This is a bounded prototype, not a replacement for all native unpacking. It does not accelerate decompression, tiled files or arbitrary camera-specific layouts. tiff-gpu remains faster on these TIFF inputs and retains broader TIFF coverage. OpenLight continues using tiff-gpu for TIFF.

## Reproduce

`bun run test:tiff`, `bun run test:browser`, and `bun run benchmark:tiff` run the package checks and TIFF comparison. The optional third comparator needs `.cache/before-direct/dist`. The RAW experiment harness is saved at `.cache/raw-direct-benchmark.ts`; it references the local synthetic benchmark fixtures and OpenLight files used in this session. Full data: `.cache/tiff-benchmark.json` and `.cache/raw-direct-benchmark.json`.
