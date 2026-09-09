# JPEG XL decoder and WASM size comparison

Historical experiment, September 9, 2026. Build sizes and decisions below describe that experiment, not necessarily the current package. See [the current RAW benchmark](RAW-BENCHMARK.md) and [README](README.md) for current behavior and limitations.

## Decision

Keep libjxl. On the two tested DNG codestream sets, both tested jxl-rs builds are slower and larger than the existing standalone libjxl decoder. Enable WASM SIMD in libjxl, retain its Release optimization for speed, eliminate unused virtual functions in the statically linked native code, disable unused RTTI, and build only the JPEG XL decoder and thread-runner targets.

The size-first libjxl build is a valid alternative, but is not selected: it reduces the complete package to 1.50 MB at a measurable decoding speed cost. No camera decoder or supported format was removed. No handwritten codec, Rust dependency, or new runtime TypeScript/C++ was added.

## Method

Measured locally in Chromium on macOS ARM64. Decode inputs and WASM modules are already in memory. Each codec uses one thread and produces interleaved unsigned 16-bit RGB without orientation changes. A fresh decoder is created for each codestream. Input transfer is measured separately; file parsing, DNG calibration, WebGPU, network, module compilation and output validation are excluded from codec timings.

The standalone C++ adapter links the exact libjxl 0.11.2 object archives used by the original raw-webgpu build and uses the original final link flags. It isolates the codec, not the complete DNG SDK adapter. jxl-rs is version 0.7.1, commit `450fef016d5d9c848a92b041b29f844a008f1e78`, built with Rust 1.96.0 for `wasm32-unknown-unknown`, SIMD, full LTO and stripped symbols. Both Rust speed (`opt-level=3`) and size (`opt-level=z`) builds were tested. libjxl SIMD builds use the same bundled source, with `-msimd128` and either Release `-O3` or `-Oz`.

The DNG files contain 4032 × 3024 × 3 samples:

- Synthetic linear DNG: one JPEG XL codestream.
- OpenLight `public/debug/IMG_3460.DNG`: twelve JPEG XL codestreams. Its metadata identifies an iPhone 17 Pro. All twelve are decoded sequentially and their times summed.

Each comparison rotates codec order across seven runs and discards the first run. Tables report the median of the remaining six. Every decoded sample is compared to the existing libjxl output after the timed section. All 36,578,304 samples per file match exactly in every run. This is evidence for these files, not general JPEG XL conformance or a universal performance ranking.

## Codec comparison

| Decoder/build | Synthetic JPEG XL | iPhone JPEG XL | Standalone WASM | Brotli quality 11 |
| --- | ---: | ---: | ---: | ---: |
| Existing libjxl, scalar | 1,013.8 ms | 803.4 ms | 793,137 B | 219,084 B |
| jxl-rs, SIMD, speed | 1,389.5 ms | 1,359.0 ms | 1,384,464 B | 346,371 B |
| jxl-rs, SIMD, size | 1,654.5 ms | 960.1 ms | 1,021,150 B | 271,704 B |
| libjxl, SIMD, size | 1,102.8 ms | 955.7 ms | 503,885 B | 166,599 B |

A subsequent paired comparison tests the selected speed-oriented SIMD codec:

| Decoder/build | Synthetic JPEG XL | iPhone JPEG XL |
| --- | ---: | ---: |
| Existing scalar control | 1,025.8 ms | 805.9 ms |
| libjxl, SIMD, speed | 938.5 ms | 721.6 ms |

The speed SIMD standalone decoder is 804,246 B, or 214,915 B with Brotli. It reduces decoding time by about 9–10% in this paired comparison. The two scalar control measurements differ slightly between batches; use the within-batch control to calculate improvements.

## Complete RAW loading

Paired comparison of the original complete package against the selected SIMD build with virtual-function elimination and RTTI disabled. Same browser and GPU device, file Blob in memory, fresh source/worker for every load, five measured runs after one warmup, alternating order. Timing ends after GPU development and queue completion. The three GPU readback probes match exactly in every run.

| Input | Original | Selected build |
| --- | ---: | ---: |
| Bayer DNG, uncompressed | 32.6 ms | 33.2 ms |
| Bayer DNG, lossless JPEG | 194.3 ms | 192.0 ms |
| Linear DNG, JPEG XL | 1,218.0 ms | 1,127.4 ms |
| Real iPhone DNG, JPEG XL | 1,029.0 ms | 943.2 ms |
| Sony ARW | 370.7 ms | 374.9 ms |

Small differences outside JPEG XL should be treated as measurement variation. Codec and full-pipeline numbers must not be subtracted to derive an exact stage breakdown: they use distinct adapters and measurement batches.

## What remains in the WASM

The original binary is 1,818,604 B, with 1,504,092 B in its code section and 308,434 B in data. A temporary build with function names shows live decoding, metadata and calibration code. Some apparently unused functionality remains reachable through virtual methods and shared entry points. `dcraw_process()` remains necessary for the X-Trans CPU fallback and retains more processing code than the Bayer GPU route uses. LibRaw identification and decoding retain camera-specific handlers and tables.

Static linking and LTO already discard unreachable code. Building fewer object archives does not automatically mean an equally large final binary reduction. Restricting the build to decoder targets avoids compiling the encoder; it does not remove an entire encoder from a binary that was already dead-stripped.

Eliminating unused virtual functions alone produced a 1,762,038 B binary, down 56,566 B. Enabling SIMD changes the code-size balance; the final selected build size is recorded below. The aggressive size variant produced 1,502,783 B, or 519,506 B with Brotli, but slowed codec decoding by roughly 9% for the synthetic and 19% for the iPhone compared with its same-batch scalar control.

Brotli figures are locally compressed artifact sizes, not measured deployment transfer sizes. The server must actually serve `Content-Encoding: br` to obtain that network saving.

## Reproduction

The isolated experiment lives in `.cache/jxl-comparison`; generated files are not committed. `fixtures.json` lists the extracted JPEG XL segments. `extract.py` uses tifffile to locate them without altering compressed bytes. `codec.cpp` and `rust/src/lib.rs` are benchmark-only adapters. `bench.ts` compares the four initial codecs; `speed-bench.ts` compares the selected SIMD codec with its scalar control; `full-pipeline.ts` checks the complete RAW pipeline. JSON results retain every timing and pixel comparison.

Paths in these local scripts point to the temporary dependency checkout and OpenLight fixtures. Recreate `/private/tmp/openlight-jxl-rs` at the recorded commit before rebuilding the Rust benchmark. These scripts are experiment artifacts, not a supported package API.

The original complete package is preserved in `.cache/before-jxl-optimization/dist`. The smaller experimental build is retained separately from the selected package build.

## Selected build and verification

| Complete package | WASM | Gzip level 9 | Brotli quality 11 |
| --- | ---: | ---: | ---: |
| Original | 1,818,604 B | 752,061 B | 585,121 B |
| Selected | 1,796,148 B | 723,754 B | 563,756 B |

The selected binary is 22,456 B smaller before HTTP compression, or about 1.2%. Brotli size drops by about 3.7%. This is a modest size saving, not evidence that most of LibRaw was removable. The source change adds 14 net lines in `native/build.py`; the new code is build configuration only.

The final package build reproduces the tested WASM byte-for-byte, SHA-256 `682e986587a070fbd0b02d7d0f9f5855d0cfc9226a80aa637cf95b83b62c0807`. Package build/check, GPU tests, RAW browser tests including the real iPhone, and all 21 TIFF fixture checks passed. The four previously unsupported TIFF fixtures remain explicit expected rejections.

OpenLight check, build, browser-free tests, GPU tests and all seven browser integration tests also passed with the rebuilt package.

No commit was made. OpenLight keeps its existing TIFF loader and consumes the rebuilt RAW package through its existing local link.
