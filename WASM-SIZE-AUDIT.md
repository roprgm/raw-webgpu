# WASM size audit

Historical experiment, September 9, 2026. Build sizes and decisions below describe that experiment, not necessarily the current package. See [the current RAW benchmark](RAW-BENCHMARK.md) and [README](README.md) for current behavior and limitations.

## Recommendation

First disable JPEG XL metadata-box extraction with the upstream `JPEGXL_ENABLE_BOXES=OFF` build option. Our DNG tile reader already sets `fNeedBoxMeta=false`; image decoding and the DNG's outer metadata remain intact. The isolated build saves 192,815 bytes, or 51,419 bytes after Brotli. This requires no replacement codec and no new GPU or JavaScript processing.

Second, consider specializing LibRaw's CPU demosaic dispatch to X-Trans, its only caller in our wrapper. The experiment retains LibRaw's X-Trans algorithm and the surrounding processing, while removing unrelated Bayer demosaic choices. It saves 37,435 bytes and passes the RAW fixtures, but requires a small maintained patch to the pinned LibRaw source. It does not require implementing X-Trans ourselves.

Do not port calibration or TIFF parsing to JavaScript just to shrink this binary. Their marginal savings are small and the replacement would add application-owned behavior and tests. GPU X-Trans should be considered for processing control, quality or speed, not for its modest download-size saving alone.

Combining those two candidates produces **1,565,900 bytes**, down **230,248 bytes (12.8%)**. Brotli quality 11 drops from **563,756 to 498,165 bytes (11.6%)**. The combined build passes the RAW/iPhone/container checks and all 21 TIFF fixture expectations. It retains LibRaw's X-Trans algorithm; additional textured X-Trans reference coverage is still advisable before maintaining the dispatch patch in production. Complete-load timing was measured for the no-boxes variant, not for this combined pair.

This audit uses temporary builds. The package's runtime source and the WASM consumed by OpenLight remain unchanged.

## Baseline and attribution

Baseline: `dist/libraw.wasm`, SHA-256 `682e986587a070fbd0b02d7d0f9f5855d0cfc9226a80aa637cf95b83b62c0807`, 1,796,148 bytes. Brotli quality 11 produces 563,756 bytes. This is the SIMD build from the previous JPEG XL comparison.

| Binary section | Bytes |
| --- | ---: |
| Code section | 1,499,760 |
| Static data | 291,117 |
| Other sections, headers and framing | 5,271 |
| Total | 1,796,148 |

A separately linked build with function names has the same code/data section sizes. Attribution below groups final function bodies by symbol name. LTO inlines and merges code, so these are attribution buckets, not independently removable library sizes. Anonymous camera-codec helpers, libc and shared C++ templates are included in the shared bucket rather than incorrectly attributed to C++ overhead alone.

| Function-body attribution | Bytes |
| --- | ---: |
| JPEG XL, Highway and DNG JPEG XL bridge | 605,203 |
| Named LibRaw functions | 346,212 |
| Other named DNG SDK functions | 267,505 |
| Other codecs, adapters, C/C++ runtime and shared helpers | 277,921 |
| Function bodies total | 1,496,841 |

Function declarations/body-length encodings account for the remaining 2,919 bytes of the code section. The data section contains codec tables, camera data, strings and other constants. Brotli alone includes a 122,784-byte static dictionary. Static data is separate from the runtime image buffers or maximum WASM heap setting; reducing a heap limit does not remove these bytes.

Notable live functions include `dng_jxl_decoder::Decode` at 150,037 bytes including inlined library code, `LibRaw::dcraw_process` at 49,541 bytes, the SDK lossless JPEG decoder at 47,070 bytes, and LibRaw's generic open/identification routine at 45,463 bytes. Replacing a named function does not necessarily save its full measured body size, because its dependencies may also be used elsewhere.

## Measured removals

Each variant starts from the same baseline and changes one responsibility. Savings are marginal and must not be added: dependencies and code layout overlap. Figures below refer to the entire resulting WASM, not individual archive sizes.

| Experiment | Resulting WASM | Saved raw bytes | Saved Brotli bytes | Consequence |
| --- | ---: | ---: | ---: | --- |
| No JPEG XL metadata-box extraction | 1,603,333 | 192,815 | 51,419 | Keeps image decoding and outer DNG metadata; internal JPEG XL metadata extraction unavailable |
| Remove all CPU demosaic | 1,728,349 | 67,799 | 24,652 | X-Trans cannot load until a replacement exists |
| Remove SDK stage-2/3 development route | 1,754,553 | 41,595 | 14,272 | Changes processing of some DNGs, especially the lossy 8-bit JPEG route; needs a deliberately constrained contract or replacement |
| Narrow the SDK opcode factory | 1,757,556 | 38,592 | 12,183 | Retains radial-vignette parsing; other opcodes become unknown and cannot be applied by the SDK |
| Remove our calibration implementation | 1,784,439 | 11,709 | 4,104 | Invalid color/WB output; an upper-bound size experiment, not a usable loader |
| Use Emscripten emmalloc | 1,789,010 | 7,138 | 1,315 | Alternative allocator; allocation performance/fragmentation not evaluated |
| Remove the TIFF entry point | 1,792,492 | 3,656 | 1,154 | Loses the package TIFF API; almost all codec work is shared with DNG |
| Narrow opcodes through a host subclass only | 1,796,298 | -150 | -359 | No size benefit: base SDK factory remains reachable |

The X-Trans-only dispatch specialization is a separate non-removal experiment: it produces 1,758,713 bytes, saving 37,435 bytes raw and 13,689 bytes over Brotli while retaining the algorithm. The wrapper calls `dcraw_process()` only after checking `filters == 9`; the experimental patched entry point rejects other mosaics, preserves X-Trans callback dispatch and pass-count selection, and omits the unrelated Bayer algorithms. A flat synthetic X-Trans fixture is not full camera/texture coverage, so a production patch should add a textured X-Trans reference and retain the format contract explicitly.

The aggressive combined build is 1,457,244 bytes, or 460,015 bytes over Brotli. It removes CPU demosaic and SDK development, narrows the SDK opcode factory, disables JPEG XL metadata extraction and changes allocator. It retains TIFF and calibration, but loses X-Trans and some DNG processing behavior. It is an experimental lower bound before paying for replacement code, not a release candidate.

## Why the metadata-box cut works

The SDK's DNG image reader constructs `dng_jxl_decoder` with `fNeedBoxMeta=false`, `fNeedImage=true`, and `fUsePixelBuffer=true`. The outer TIFF/DNG parser remains responsible for the metadata our application needs. JPEG XL's embedded color encoding remains in the image codestream; this change does not disable that decoding.

Disabling `JPEGXL_ENABLE_BOXES` disables requests to extract metadata-box contents, including Brotli-compressed `brob` contents. It still permits the decoder to skip metadata boxes and decode the image inside a JPEG XL container. It saves 61,605 bytes of code, 131,186 bytes of static data and 24 bytes of other framing in this build.

This distinction matters: DNG 1.7.1 explicitly allows both bare JPEG XL codestreams and container-format JPEG XL, and recommends bare codestreams for tiled images. See the compression section on pages 21–22 of the [Adobe DNG specification](https://helpx.adobe.com/content/dam/help/en/camera-raw/digital-negative/jcr_content/root/content/flex/items/position/position-par/download_section_733958301/download-1/DNG_Spec_1_7_1_0.pdf).

The experiment recompiles the current libjxl `decode.cc` with the upstream feature macro disabled, then links it before the unchanged archives. The production build should use the CMake option rather than retain this object-injection experiment. In the pinned libjxl source, production uses of this feature macro are in `decode.cc`; other occurrences are defaults and test helpers.

## GPU and JavaScript trade-offs

- Normalization, Bayer demosaic, white-balance gains, camera-to-working-space conversion, orientation and radial vignette application already run on the GPU in our supported pipeline. Moving them again does not remove the CPU fallback dispatch or codec implementations automatically.
- X-Trans uses a different mosaic layout and algorithm from Bayer. Removing CPU development saves about 68 KB raw, only 25 KB over Brotli. Keeping LibRaw's X-Trans algorithm but narrowing its dispatch captures part of that saving without writing a new demosaic shader.
- DNG stage 2/3 also includes special linearization, spatial black handling, opcode application and related image preparation. The generic LibRaw integration can call those stages depending on file type and options. They are not all redundant with our current GPU path. Replacing them must preserve each supported input's behavior or reject unsupported requirements explicitly.
- Absolute white balance is more than multiplying pixels: the GPU already multiplies the final gains/matrix, while the SDK derives calibration from profiles and illuminants. Removing our calibration implementation saved only 12 KB in isolation because other SDK paths share the underlying types and functions. A JavaScript replacement would still need metadata extraction and comparable color tests.
- Camera identification, proprietary decompression and calibration tables enable broad format support. Porting those to custom JavaScript/GPU code would trade a modest binary reduction for the codec maintenance the package is intended to avoid.

## Validation and timing

The no-boxes build passed the existing RAW browser checks, including all four Bayer phases, crop, X-Trans, JPEG XL, white balance, restoration, invalid input and cancellation, plus the real local iPhone DNG. All 21 TIFF fixtures were checked: 17 matched reference pixels and the four previously unsupported fixtures remained expected rejections.

An additional temporary fixture wraps the original synthetic linear JPEG XL codestream in a JPEG XL container containing a Brotli-compressed XML metadata box. An independent imagecodecs decode verifies the wrapped codestream pixels first. The DNG loader then passes the existing reference-pixel and white-balance checks with metadata extraction disabled. This tests container support rather than assuming all DNGs use bare JPEG XL.

Five post-warmup paired complete-load medians, ending after GPU queue completion:

| File | Baseline | No metadata-box extraction |
| --- | ---: | ---: |
| Bayer uncompressed | 35.3 ms | 35.4 ms |
| Bayer lossless JPEG | 184.9 ms | 182.5 ms |
| Linear JPEG XL | 1,101.1 ms | 1,126.5 ms |
| Real iPhone JPEG XL | 929.5 ms | 946.9 ms |
| Sony ARW | 394.5 ms | 410.1 ms |

All three GPU sample probes match exactly in every run. The cut demonstrates a size improvement, not a speed improvement. JPEG XL medians are about 2% slower in this batch; the small sample does not establish a general regression or guarantee identical speed. Other destructive size experiments are not claimed to preserve images unless explicitly tested.

## Reproduction

Experiment scripts, binaries and outputs live in ignored `.cache/wasm-size-audit`, copied from `/private/tmp/raw-wasm-audit`. They are local audit artifacts, not production package modules. `setup.py` resolves the exact cached native recipe and preserves the baseline; `variants.py` links isolated removals; `no_boxes.py`, `narrow_factory.py`, and `xtrans_only.py` build the focused probes; `verify.py` reuses package browser tests against a selected native binary. `container_fixture.py` creates the additional fixture. `size.py`, `sizes.json`, `functions.json`, and the pipeline JSON retain the attribution and measurements.

The scripts reference the local compiler/cache and fixture paths. No runtime source changes, dependency replacement or commit were made as part of this audit.
