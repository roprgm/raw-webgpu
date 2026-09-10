# raw-webgpu

Load camera RAW, DNG and TIFF files into WebGPU textures. Develop into linear Rec.2020 or display sRGB, with adjustable white balance and exposure.

[Try the demo](https://raw-webgpu.vercel.app) or browse its [minimal TypeScript source](web/main.ts). Files stay in your browser.

LibRaw, Adobe DNG SDK and libjxl decode files in a WASM worker. WebGPU handles supported demosaic and color processing. Supply your own `GPUDevice`; no rendering framework is required.

## Features

- Camera RAW and iPhone DNG/ProRAW, including JPEG XL.
- GPU Bayer and X-Trans demosaic, with library CPU preparation for special layouts and mandatory DNG corrections.
- Absolute temperature/tint and initial white-balance restoration without decoding again.
- HDR output, camera calibration, orientation and explicit resource disposal.
- TIFF support with ICC matrix/TRC profiles and alpha.

## Installation

```sh
npm install raw-webgpu
```

WASM, workers and TypeScript types are included. No C++ build is needed. Use a WebGPU browser with WASM SIMD/exception support and a bundler such as Vite. With TypeScript 5.9, also install `@webgpu/types` and include it in `compilerOptions.types`.

## Usage

```ts
import { createRawDecoder } from "raw-webgpu";

const decoder = createRawDecoder(device); // Your GPUDevice.
const source = await decoder.load(file); // File or Blob.
const destination = device.createTexture({
  size: source.size,
  format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
const pass = source.createDevelopPass();
pass.render({ destination, calibration: source.calibration });

// Adjust the same source without decoding or uploading pixels again.
const calibration = await source.calibrate({ temperature: 5500, tint: 10 });
pass.render({ destination, calibration, exposure: 1 }); // +1 stop.

// When finished:
source.dispose(); // Also releases its passes and worker.
destination.destroy();
decoder.dispose();
```

### Display on a canvas

Create a pass with `{ outputColorSpace: "srgb", format }`, where `format` matches your sRGB canvas configuration, usually `navigator.gpu.getPreferredCanvasFormat()`. Render to `context.getCurrentTexture()` with the canvas dimensions set to `source.size`. No app shader is needed.

The default is `{ outputColorSpace: "linear-rec2020", format: "rgba16float" }`. Supported formats are `rgba16float`, `rgba8unorm` and `bgra8unorm`. sRGB output converts primaries, clips to [0, 1] and applies the sRGB transfer function on GPU; it does not add a photographic tone curve. Do not apply sRGB encoding again.

### TIFF

```ts
import { decodeTiff } from "raw-webgpu";

const image = await decodeTiff(device, file);
// Use image.texture, a linear Rec.2020 rgba16float texture.
image.dispose(); // When finished.
```

Both loaders accept `{ signal }` for cancellation. `source.calibrate()` restores the initial white point.

Use separate passes for independent previews or exports. If passing an external `encoder` to `render`, render each pass only once before submitting it because uniform writes are not snapshots. Loading queues GPU work; use `device.queue.onSubmittedWorkDone()` to wait for completion.

For file export, see the [Bun PNG/JPEG/BMP conversion example](docs/conversion.md).

## API contract and support

Tested with Chromium on macOS and Linux CI with software rendering. Safari, Firefox and mobile browsers have not been validated. Bun is also tested; WebGPU is still required.

- Default RAW and decoded TIFF output is linear Rec.2020/D65 `rgba16float`, with no display tone curve. HDR values can exceed 1. RAW passes can instead output encoded sRGB for display. TIFF alpha is straight. Camera JPEG previews apply their own rendering and are not pixel references for this output.
- `source.texture` contains sensor or camera-RGB samples, not developed output. Read its format and metadata; do not assume every RAW is a one-channel mosaic. `source.size` is oriented output size; `metadata.size` is the unrotated sample size.
- Calibration has three RGB gains and a nine-value column-major matrix. Development applies gains before the camera-to-working-space matrix; exposure is in stops. Independent passes can use different calibration without changing the source.
- A decoder owns its sources, each source owns its passes and worker, and the caller owns destination textures. Disposal is idempotent. Device loss closes the decoder; create another decoder with a new device. Pending loads and calibration requests reject when their owner closes.
- Abort signals cover loading only, including pending GPU setup. Cancellation rejects with the signal's reason. Invalid or unsupported files reject with an `Error`; message text is diagnostic, not a stable error code.

The API contract applies to 0.1.x. Release tests check shader pixels, worker lifecycles and the installed npm package. All 30 files in the local camera corpus converted successfully; this does not establish support for every camera.

## Limitations and planned work

**X-Trans quality remains experimental.** Two GPU passes reconstruct camera RGB using nearby samples and color differences. This recovers less fine detail than the LibRaw Markesteijn references; directional edges and aliasing need further GPU work. White balance is applied to the cached reconstruction, rather than rerunning a WB-dependent demosaic.

The camera-RGB cache keeps WB edits fast. A 16 MP image retains about 128 MB of RGB plus the 32 MB mosaic; reconstruction temporarily needs another 128 MB texture. That temporary texture is released after submission.

RAW coverage depends on camera calibration and sensor layout. Missing as-shot multipliers use a reported daylight fallback; Sigma color remains experimental and can have visible color casts. Floating-point RAW input, baked white balance and non-three-color sensors have limitations. CPU-prepared sources cannot expose pre-demosaic edits. There is no GPU denoising, highlight reconstruction or CPU rendering fallback.

TIFF passes 20 of 24 fixtures; bilevel, palette, float64 and YCbCr JPEG are rejected. Only the first IFD is read, and unsupported or malformed embedded ICC profiles are rejected. Untagged integer TIFF defaults to sRGB; untagged floating-point TIFF is treated as linear sRGB. Images must fit the GPU's texture limits.

## Benchmark

Published **raw-webgpu 0.1.1** vs [libraw-wasm 1.6.0](https://github.com/ybouane/LibRaw-Wasm), measured September 10, 2026 on Apple M4 Pro, macOS, Chromium 151 with hardware WebGPU. Cross-origin isolation was enabled for LibRaw's worker threads. The table covers all 30 downloaded models from [rawsamples.ch](https://rawsamples.ch/index.php/en/), ten additional mirrorless cameras from [raw.pixls.us](https://raw.pixls.us/), and a local iPhone ProRAW file. Recent mirrorless models appear first; this is not a sales ranking.

Times are in milliseconds. MP is output megapixels; MB is input file size in decimal megabytes. The target is a full-resolution sRGB RGBA8 texture on the GPU. raw-webgpu completed all 41 files without reported GPU errors; libraw-wasm produced RGB output for 39. Dimensions matched for all 39 shared successes. Completion does not establish color or demosaic quality.

| Camera | File | MP | MB | raw-webgpu | LibRaw q3 | LibRaw q0 | WB update¹ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sony A7 III | ARW | 24.2 | 25.6 | 162 | 801 | 405 | 3.4 |
| Sony A7 IV | ARW | 32.9 | 40.7 | 229 | 1,043 | 552 | 4.6 |
| Sony A6400 | ARW | 24.2 | 25.1 | 158 | 759 | 411 | 3.4 |
| Canon EOS R5 | CR3 | 44.7 | 40.6 | 523 | 1,659 | 958 | 5.9 |
| Canon EOS R6 | CR3 | 20.2 | 22.9 | 226 | 726 | 426 | 2.8 |
| Canon EOS R6 Mark II | CR3 | 24.2 | 29.4 | 286 | 889 | 501 | 3.6 |
| Nikon Z6 | NEF | 24.5 | 30.2 | 254 | 1,036 | 667 | 3.4 |
| Nikon Z8 | NEF | 45.7 | 60.8 | 548 | 1,954 | 1,225 | 6.1 |
| Fujifilm X-T5 | RAF | 40.1 | 43.1 | 1,844 | 13,908 | 1,876 | 1.2 |
| Fujifilm X100VI | RAF | 40.1 | 49.4 | 1,805 | 14,282 | 2,158 | 1.2 |
| iPhone ProRAW | DNG | 12.2 | 11.6 | 833 | No output | No output | 1.7 |
| Canon EOS 5D Mark III | CR2 | 22.4 | 38.1 | 505 | 1,116 | 676 | 3.3 |
| Canon EOS 5DS | CR2 | 51.2 | 67.1 | 953 | 2,435 | 1,615 | 7.1 |
| Canon EOS 10D | CRW | 6.3 | 6.4 | 84 | 256 | 157 | 4.6 |
| Nikon D800 | NEF | 36.3 | 43.3 | 423 | 1,564 | 1,045 | 5.1 |
| Nikon D750 | NEF | 24.3 | 22.3 | 269 | 1,048 | 671 | 3.6 |
| Nikon D70 | NEF | 6.1 | 5.5 | 74 | 284 | 191 | 2.0 |
| Sony Alpha 7R II | ARW | 42.4 | 43.0 | 371 | 1,519 | 888 | 6.0 |
| Sony RX100 | ARW | 20.2 | 20.9 | 150 | 659 | 348 | 5.5 |
| Sony Alpha 100 | ARW | 10.1 | 9.1 | 132 | 407 | 247 | 2.8 |
| Fujifilm X-Pro1 | RAF | 16.3 | 26.1 | 326 | 5,518 | 325 | 0.8 |
| Fujifilm X-T10 | RAF | 16.3 | 33.8 | 329 | 5,677 | 256 | 0.9 |
| Fujifilm S5 Pro | RAF | 6.1 | 25.7 | 193 | 388 | 197 | 0.7 |
| Olympus E-M1 | ORF | 16.1 | 16.4 | 452 | 793 | 534 | 3.5 |
| Olympus E-1 | ORF | 5.2 | 10.7 | 35 | 164 | 82 | 1.7 |
| Panasonic GH4 | RW2 | 16.1 | 19.9 | 140 | 623 | 364 | 3.2 |
| Panasonic FZ8 | RAW | 7.2 | 11.6 | 63 | 263 | 147 | 2.1 |
| Pentax K-3 II | PEF | 24.4 | 33.2 | 383 | 1,046 | 642 | 6.7 |
| Pentax K-50 | DNG | 16.2 | 14.4 | 264 | 690 | 435 | 2.8 |
| Leica M Typ 240 | DNG | 23.9 | 28.1 | 312 | 1,021 | 630 | 3.6 |
| Samsung NX500 | SRW | 28.2 | 46.3 | 366 | 1,073 | 612 | 4.0 |
| Sigma DP2 Quattro | X3F | 19.7 | 57.7 | 1,031 | No output | No output | 1.3 |
| Kodak DCS Pro | DCR | 13.6 | 14.1 | 167 | 544 | 329 | 2.5 |
| Hasselblad H3DII-39 | 3FR | 39.5 | 55.0 | 744 | 1,536 | 879 | 7.4 |
| Mamiya ZD | MEF | 21.5 | 36.6 | 158 | 887 | 534 | 3.6 |
| Minolta Dynax 7D | MRW | 6.1 | 9.2 | 48 | 214 | 120 | 1.8 |
| Ricoh GR | DNG | 10.4 | 11.3 | 234 | 514 | 351 | 1.7 |
| Epson R-D1 | ERF | 6.2 | 10.0 | 52 | 217 | 127 | 1.6 |
| Leaf Aptus 22 | MOS | 21.4 | 43.4 | 147 | 749 | 391 | 3.2 |
| OnePlus One | DNG | 13.1 | 17.2 | 485 | 495 | 284 | 1.9 |
| Nokia Lumia 1020 | DNG | 38.3 | 49.7 | 2,384 | 1,429 | 805 | 2.5 |

Loading includes decoding, development, CPU-to-GPU transfer and GPU completion. Values are medians of three measured runs after one warmup per file and mode, with alternating execution order. File reads/downloads, initial module setup, canvas presentation and export encoding are excluded. LibRaw timings include RGB-to-RGBA packing and `writeTexture`; raw-webgpu uses `createDevelopPass({ outputColorSpace: "srgb", format: "rgba8unorm" })`.

LibRaw uses camera WB, no auto-brightening, 8-bit sRGB output and `gamm: [1 / 2.4, 12.92]`. **q3** is its standard quality setting; **q0** selects fast interpolation. Demosaic, calibration and highlight handling differ, so this compares loading workflows, not identical pixels or equal image quality. In particular, raw-webgpu's X-Trans reconstruction retains less fine detail than the higher-quality LibRaw reference.

¹ WB update measures raw-webgpu's calibration request, rendering and GPU completion on an already loaded source, with no decoding or upload. Each run measures five temperature/tint edits after two warmups; the table reports the median of the three run medians. These are full-resolution timings, not guaranteed application frame rates.

The comparison has exceptions: LibRaw q0 matches or beats raw-webgpu on the X-Pro1 and X-T10, and both LibRaw settings beat it on the Lumia 1020. Those results held in a separate repeat run. LibRaw q0 also beats raw-webgpu on the OnePlus One. “No output” means this package version's `imageData()` returned no RGB data for that sample, confirmed in the repeat run; it is not a claim that upstream LibRaw cannot support the camera. Sigma color remains experimental in raw-webgpu.

Scripts, inputs and measurements are retained locally in the ignored `.cache/readme-benchmark/` and `.cache/rawsamples-30/` directories. WASM is 1.82 MB, or about 570 KB with Brotli.

## Development

With Bun, Python 3, CMake and Emscripten 6.0.9 activated:

```sh
bun install
bun run build
bun run test:package
```

The native build downloads checksum-pinned dependencies and caches objects in `.cache/native`. Use `bun run build:sdk` for TypeScript-only changes. `dist/` and downloaded camera files stay outside Git. For local development, run `bun link` here and `bun link raw-webgpu` in the consuming app.

`test:package` builds a tarball, installs it in a temporary project, checks types and runs RAW/TIFF tests in Chromium with WebGPU. `bun run test:gpu` checks shader pixels; `bun run check` formats and lints.

### Demo

```sh
cd web
bun install
bun run dev
```

The demo uses the published npm package. Build with `bun run build`; deploy `web/dist/` over HTTPS. On Vercel, use `web` as the root directory. With the server running, `bun run test:web` from the repository root checks the prompt, invalid files and RAW loading.

### Publishing

Merge the version change into `main`, then publish a GitHub Release with the matching `vX.Y.Z` tag. GitHub Actions builds and tests the package before publishing to npm with trusted publishing and provenance. Stable releases use `latest`; `-alpha.N` prereleases use `alpha`.

## License

SDK and shaders: [MIT](LICENSE). Native dependencies retain their own licenses; see [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.txt).
