# raw-webgpu

Load camera RAW, DNG and TIFF files into WebGPU textures. Develop into linear Rec.2020 `rgba16float`, with adjustable white balance and exposure.

LibRaw, Adobe DNG SDK and libjxl decode files in a WASM worker. WebGPU handles supported demosaic and color processing. Supply your own `GPUDevice`; no rendering framework or runtime dependencies are required.

## Features

- Camera RAW and iPhone DNG/ProRAW, including JPEG XL.
- GPU Bayer and X-Trans demosaic, with library CPU preparation for special layouts and mandatory DNG corrections.
- Absolute temperature/tint and initial white-balance restoration without decoding again.
- HDR output, camera calibration, orientation and explicit resource disposal.
- Experimental TIFF support with ICC matrix/TRC profiles and alpha.

## Installation

`0.1.0-alpha.1` is prepared but not published yet. Once available:

```sh
npm install --save-exact raw-webgpu@0.1.0-alpha.1
```

WASM, workers and types are included; consumers do not compile C++. Use a WebGPU browser with WASM SIMD/exception support and a bundler that handles worker/WASM asset URLs, such as Vite. Older TypeScript versions may need `@webgpu/types` in `compilerOptions.types`.

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

## Limitations and planned work

**X-Trans detail needs improvement.** Its current fixed-weight interpolation softens fine textures compared with the previous LibRaw Markesteijn algorithm. Replace it with higher-quality GPU reconstruction and compare detail, aliasing and WB performance against the retained reference images. This is an algorithm trade-off, not a GPU limitation. The camera-RGB cache keeps WB edits fast but adds about 128 MB for a 16 MP image, alongside the 32 MB mosaic. Revisit that cache if a new algorithm depends on WB.

RAW coverage depends on camera calibration and sensor layout. Missing as-shot multipliers use a reported daylight fallback; Sigma color remains experimental. Floating-point RAW input, baked white balance and non-three-color sensors have limitations. CPU-prepared sources cannot expose pre-demosaic edits. There is no GPU denoising, highlight reconstruction or CPU rendering fallback.

TIFF passes 17 of 21 fixtures; bilevel, palette, float64 and YCbCr JPEG are rejected. Only the first IFD is read, and unsupported ICC profiles fall back to sRGB. Images must fit the GPU's texture limits.

## Benchmark

All 30 camera samples converted in Chromium and Bun. Selected results on Apple M4 Pro with Chromium 151, measured September 9, 2026:

| Camera | Load | WB GPU update |
| --- | ---: | ---: |
| Nikon D800 | 397 ms | Not measured |
| Sony A7R II | 365 ms | Not measured |
| Fuji X-Pro1 | 240 ms | 0.9 ms |
| Fuji X-T10 | 211 ms | 1.7 ms |
| Nokia Lumia 1020 | 1,719 ms | Not measured |

Loading is the median of three runs after one warmup, from an in-memory file through decoding, upload and GPU completion. Disk reads and export encoding are excluded. WB timings measure the GPU stage over ten edits after two warmups. X-Trans uses the simpler demosaic described above; these numbers do not guarantee application frame rates.

WASM is 1.81 MB, or about 570 KB with Brotli. Full measurements and downloaded files remain in the local ignored `.cache/` directory.

## Development

With Bun, Python 3, CMake and Emscripten 6.0.9 activated:

```sh
bun install
bun run build
bun run test:package
```

The native build downloads checksum-pinned dependencies and caches objects in `.cache/native`. Use `bun run build:sdk` for TypeScript-only changes. `dist/` and downloaded camera files stay outside Git. For local development, run `bun link` here and `bun link raw-webgpu` in the consuming app.

`test:package` builds a tarball, installs it in a temporary project, checks types and runs RAW/TIFF tests in Chromium with WebGPU. `bun run test:gpu` checks shader pixels; `bun run check` formats and lints.

To publish with an authorized npm account and the same build toolchain:

```sh
npm publish --dry-run
npm publish --tag alpha --access public
```

`prepack` rebuilds the package; `prepublishOnly` checks formatting, GPU tests and the installed tarball. Keep the prerelease version and `alpha` tag until a stable release is ready.

## License

SDK and shaders: [MIT](LICENSE). Native dependencies retain their own licenses; see [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.txt).
