# raw-webgpu

Load camera RAW, DNG and TIFF files into WebGPU textures. Develop into linear Rec.2020 `rgba16float`, with adjustable white balance and exposure.

LibRaw, Adobe DNG SDK and libjxl decode files in a WASM worker. Simple TIFF strips use original file bytes or browser Deflate; complex layouts retain the SDK fallback. WebGPU handles supported demosaic and color processing. Supply your own `GPUDevice`; no rendering framework or runtime dependencies are required.

## Features

- Camera RAW and iPhone DNG/ProRAW, including JPEG XL.
- GPU Bayer and X-Trans demosaic, with library CPU preparation for special layouts and mandatory DNG corrections.
- Absolute temperature/tint and initial white-balance restoration without decoding again.
- HDR output, camera calibration, orientation and explicit resource disposal.
- TIFF support with ICC matrix/TRC profiles and alpha.

## Installation

```sh
npm install --save-exact raw-webgpu@0.1.0
```

WASM, workers and types are included; consumers do not compile C++. Use a WebGPU browser with WASM SIMD/exception support and a bundler that handles worker/WASM asset URLs, such as Vite. TypeScript 5.9 and newer are tested; with TypeScript 5.9, install `@webgpu/types` and include it in `compilerOptions.types`.

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

For TIFF:

```ts
import { decodeTiff } from "raw-webgpu";

const image = await decodeTiff(device, file);
// Use image.texture, a linear Rec.2020 rgba16float texture.
image.dispose(); // When finished.
```

Both loaders accept `{ signal }` for cancellation. `source.metadata` describes the samples and calibration origin; `source.calibrate()` restores the initial white point. The caller owns the device and destination textures. `decoder.dispose()` also closes pending loads and loaded sources.

Use separate passes for independent previews or exports. If passing an external `encoder` to `render`, render each pass only once before submitting it because uniform writes are not snapshots. Loading queues GPU work; use `device.queue.onSubmittedWorkDone()` to wait for completion.

For file export, see the [Bun PNG/JPEG/BMP conversion example](docs/conversion.md).


## API contract and support

The supported browser baseline is Chromium with WebGPU. Verified environments are Chromium 151 on macOS with Apple M4 Pro and Linux CI with software rendering, plus Chrome 153 on macOS. Safari, Firefox, mobile browsers and other physical GPUs have not been validated. Tests simulate lower texture/buffer limits; they do not establish a device memory budget. Bun is an additional tested runtime, not a CPU fallback.

- Developed RAW and decoded TIFF output is linear Rec.2020/D65 `rgba16float`, with no display tone curve. HDR values can exceed 1. TIFF alpha is straight. Camera JPEG previews apply their own rendering and are not pixel references for this output.
- `source.texture` contains sensor or camera-RGB samples, not developed output. Read its format and metadata; do not assume every RAW is a one-channel mosaic. `source.size` is oriented output size; `metadata.size` is the unrotated sample size.
- Calibration has three RGB gains and a nine-value column-major matrix. Development applies gains before the camera-to-working-space matrix; exposure is in stops. Independent passes can use different calibration without changing the source.
- A decoder owns its sources, each source owns its passes and worker, and the caller owns destination textures. Disposal is idempotent. Device loss closes the decoder; create another decoder with a new device. Pending loads and calibration requests reject when their owner closes.
- Abort signals cover loading only, including pending GPU setup. Cancellation rejects with the signal's reason. Invalid or unsupported files reject with an `Error`; message text is diagnostic, not a stable error code. Load completion queues GPU work; wait on the device queue when you need GPU completion.

The public API and output contract are the supported baseline for 0.1.x. Release checks compare synthetic pixels against known color math and demosaic filters, test real workers and resource cleanup, and install the actual npm tarball in a separate consumer using TypeScript 5.9. The retained 30-camera corpus is a manual compatibility/regression check; X-Trans detail and Sigma color remain explicitly experimental in 0.1.0.

## Limitations and planned work

**X-Trans quality remains experimental.** Two GPU passes reconstruct camera RGB: nearby samples provide an initial estimate, then interpolated R−G and B−G differences recover detail. White balance is applied after this fixed reconstruction; it is not equivalent to running a WB-dependent demosaic again. Further work should improve directional edges and aliasing against the retained LibRaw Markesteijn references.

The camera-RGB cache keeps WB edits fast. A 16 MP image retains about 128 MB of RGB plus the 32 MB mosaic; reconstruction temporarily needs another 128 MB texture. That temporary texture is released after submission.

RAW coverage depends on camera calibration and sensor layout. Missing as-shot multipliers use a reported daylight fallback; Sigma color remains experimental and can have visible color casts. Floating-point RAW input, baked white balance and non-three-color sensors have limitations. CPU-prepared sources cannot expose pre-demosaic edits. There is no GPU denoising, highlight reconstruction or CPU rendering fallback.

TIFF passes 20 of 24 fixtures; bilevel, palette, float64 and YCbCr JPEG are rejected. Only the first IFD is read, and unsupported or malformed embedded ICC profiles are rejected. Untagged integer TIFF defaults to sRGB; untagged floating-point TIFF is treated as linear sRGB. Images must fit the GPU's texture limits.

## Benchmark

All 30 camera samples converted in Chromium and Bun. Selected results on Apple M4 Pro with Chromium 151, measured September 9, 2026; Fuji results updated September 10:

| Camera | Load | WB GPU update |
| --- | ---: | ---: |
| Nikon D800 | 397 ms | Not measured |
| Sony A7R II | 365 ms | Not measured |
| Fuji X-Pro1 | 267 ms | 0.8 ms |
| Fuji X-T10 | 232 ms | 0.9 ms |
| Nokia Lumia 1020 | 1,719 ms | Not measured |

Loading is the median of three runs after one warmup, from an in-memory file through decoding, upload and GPU completion. Disk reads and export encoding are excluded. WB timings measure the GPU stage over ten edits after two warmups. These numbers do not guarantee application frame rates. The X-Trans refinement reduced mean absolute RGB error against the retained LibRaw exports from 3.59 to 2.15 levels for X-Pro1 and from 3.77 to 2.30 for X-T10 on an 8-bit scale. Those exports are comparison references, not ground truth.

On the same machine, TIFF loading improved from 437 to 321 ms for a 14.6 MP Deflate image, from 59 to 49 ms for a 19 MP uncompressed RGB16 image, and from 546 to 443 ms for a 19 MP Deflate image with horizontal prediction. Medians exclude one warmup and include GPU completion. The TIFF changes preserved the checked pixels across all 30 RAW samples, with no sustained RAW loading regression observed.

WASM is 1.82 MB, or about 570 KB with Brotli. Full measurements and downloaded files remain in the local ignored `.cache/` directory.

## Development

With Bun, Python 3, CMake and Emscripten 6.0.9 activated:

```sh
bun install
bun run build
bun run test:package
```

The native build downloads checksum-pinned dependencies and caches objects in `.cache/native`. Use `bun run build:sdk` for TypeScript-only changes. `dist/` and downloaded camera files stay outside Git. For local development, run `bun link` here and `bun link raw-webgpu` in the consuming app.

`test:package` builds a tarball, installs it in a temporary project, checks types and runs RAW/TIFF tests in Chromium with WebGPU. `bun run test:gpu` checks shader pixels; `bun run check` formats and lints.

Publishing runs in GitHub Actions. Merge the version change into `main`, then publish a GitHub Release with the matching tag, such as `v0.1.0`. The workflow verifies the tag and commit, installs Emscripten, and runs the package checks before publishing to npm. Stable releases use `latest`; `-alpha.N` prereleases use `alpha`. Local publishing is not required.

Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) once for owner `roprgm`, repository `raw-webgpu`, workflow `publish.yml`, with publishing allowed and no environment name. No npm token secret is needed; npm attaches provenance automatically.

`prepack` rebuilds the package; `prepublishOnly` checks formatting, GPU tests and the installed tarball. Linux browser tests use SwiftShader, and the release job uses vgpu's software renderer for shader tests. Performance measurements should still use real hardware.

## License

SDK and shaders: [MIT](LICENSE). Native dependencies retain their own licenses; see [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.txt).
