# raw-webgpu

Camera RAW files to reusable WebGPU sensor textures and linear Rec.2020 images. The package includes precompiled LibRaw, Adobe DNG SDK and JPEG XL. Consumers need a browser with WebGPU, not a C++ toolchain.

```ts
import { createRawDecoder } from "raw-webgpu";

const decoder = createRawDecoder(device); // Your existing GPUDevice.
const source = await decoder.load(file);
const destination = device.createTexture({
  size: source.size,
  format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
const pass = source.createDevelopPass();
pass.render({ destination, calibration: source.calibration });

const calibration = await source.calibrate({ temperature: 5500, tint: 10 });
pass.render({ destination, calibration, exposure: 1 });

pass.dispose();
source.dispose();
destination.destroy();
decoder.dispose();
```

`load()` decodes in a worker and uploads the sensor samples. It resolves after queuing the upload; subsequent work on the same device is ordered after it. Use `device.queue.onSubmittedWorkDone()` when a completion measurement is needed. The decoder builds one GPU pipeline and shares it across its sources. Each source retains a worker for small calibration requests, not full-image reprocessing.

## Source and development

- `texture`: `r16uint` Bayer or `rgba16uint` camera RGB. This belongs to the source; consumers may sample it but must not destroy it.
- `metadata`: sensor dimensions, active-area CFA phase, LibRaw orientation bitmask, black/white levels, radial vignette calibration and whether demosaic runs on GPU, CPU or is unnecessary. LibRaw may already apply file linearization while decoding; these are library-prepared samples, not the original encoded bytes.
- `size`: oriented output dimensions.
- `asShot`: absolute Kelvin and Adobe SDK tint coordinates for the camera neutral.
- `calibration`: exact as-shot channel gains and column-major camera-to-linear-Rec.2020/D65 matrix.
- `calibrate(balance?)`: obtains gains and matrix for another white point. Omit the argument to restore as-shot. No pixels cross the worker for this operation.
- `createDevelopPass()`: creates independently owned calibration uniforms. `render()` applies normalization, WB, Bayer MHC demosaic when applicable, radial correction, color conversion and exposure. Output is unclipped `rgba16float` linear Rec.2020.

A pass submits immediately unless given an `encoder`. With an external encoder, call each pass at most once before submitting that encoder: uniform writes are queue operations, not snapshots stored in the command encoder. Use separate passes for independent previews or exports. The consumer owns destination textures, their device, and any supplied encoder. Disposing a source closes its worker and all its passes. Disposing the decoder closes its loaded and pending sources; it never destroys the consumer's device.

## Coverage

The first release supports calibrated three-channel conventional Bayer RAW and 16-bit integer linear DNG, including the lossless JPEG/JPEG XL routes used by DNG and ProRAW. Bayer stays single-channel on GPU. Standard uncropped Bayer DNG skips LibRaw's sparse four-channel image allocation; other Bayer inputs retain library preparation and are compacted before upload.

X-Trans uses LibRaw CPU demosaic once, then GPU WB and color. This fallback returns library-prepared camera RGB rather than a GPU sensor mosaic. It does not provide pre-demosaic edits. Other special layouts, floating-point RAW, baked camera WB, unsupported spatial black calibration, missing camera calibration and mandatory unsupported DNG opcodes produce an explicit error. Optional unimplemented DNG corrections are not applied. Support is bounded by both the compiled codecs and the development path; this is not a claim that every LibRaw camera or every iPhone mode works.

No custom codecs, camera-specific parsers, noise-reduction algorithm, highlight reconstruction, Apple Photos tone mapping, profile look-table renderer, TIFF/PNG/JPEG loader, UI or React integration is included. The standard GPU path performs no noise reduction. CPU fallback uses LibRaw's processing with optional denoising disabled; library-required corrections may still apply.

## Layout

- `src/index.ts` composes source lifetimes and exposes the public decoder.
- `src/types.ts` describes pixels, calibration and development options.
- `src/decode/` owns worker messaging and the WASM bindings.
- `src/develop/` owns GPU resources and the development shader.
- `native/pixels.cpp` prepares LibRaw samples and packs Bayer pixels.
- `native/calibration.cpp` reads camera profiles and calculates white balance.
- `native/bridge.cpp` exposes the C functions used by the worker; `raw.h` defines their shared native session.
- `native/build.py` builds dependencies and links the native sources.
- `tests/fixtures/generate.py` generates synthetic sensor images with known calibration.

The SDK bundles to flat `dist/index.js` and `dist/worker.js` entry points beside `libraw.js` and `libraw.wasm`. Source folders do not change the public imports or asset URLs.

## Development

```sh
# Activate Emscripten 6.0.9 first; CMake and Python 3 are required.
bun install
bun run build
bun run test:gpu
bun run test:browser
```

`build` compiles the native WASM, then the TypeScript SDK and declarations. All generated browser ESM, worker, WASM and declarations go into `dist/`, which is ignored by Git. The repository contains sources and build configuration; distributed packages include the generated artifacts. The package has no runtime dependency on vgpu; it is used only for GPU tests.

Activate Emscripten **6.0.9**, install CMake and Python 3, then run `bun run build`. Unchanged native builds are skipped; use `bun run build:sdk` for TypeScript-only iteration. `native/build.py` downloads checksum-pinned LibRaw **0.22.2** and DNG SDK **1.7.1 build 2724**, builds the bundled JPEG XL dependencies, and caches dependency objects under `.cache/native`. `RAW_WEBGPU_CACHE` overrides that location. The SDK patch only guards disabled XMP metadata blocks. Neither OpenLight nor another consuming app needs to run this build.

Format TypeScript with `bun run check`. For native and fixture changes, use `clang-format -i native/*.cpp native/*.h` and `ruff format native/build.py tests/fixtures/generate.py`. The repository includes the C++ formatting configuration.

The SDK/shader source is MIT. Bundled native dependencies retain their own licenses; see `NOTICE` and `THIRD_PARTY_LICENSES.txt`. The native source and pinned build recipe accompany the package.

## Verified files

The package's browser tests cover all four Bayer phases, an odd ActiveArea crop, linear JPEG XL, X-Trans CPU fallback, absolute WB, exact As Shot restoration, invalid input and cancellation. GPU pixel tests cover the published MHC impulse weights, channel black levels, orientation, color matrices, HDR and radial correction.

Local-only checks also loaded public iPhone XS, iPhone 12 Pro and iPhone 16 Pro Max DNG samples, changed WB, and restored the exact initial pixels. XS used the Bayer GPU path; 12 Pro and 16 Pro Max used linear camera RGB. The real files are not bundled as fixtures. A real iPhone JPEG XL file has not been verified; JPEG XL coverage is synthetic.

After checking out this package beside OpenLight, run `bun install && bun run build && bun link`, then `bun link --save raw-webgpu` in OpenLight. Run `bun run build` after source changes; cached native dependencies are reused. A package release has not been published yet.
