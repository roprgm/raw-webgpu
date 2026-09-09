# raw-webgpu

Load camera RAW, DNG and TIFF files into WebGPU textures. Keep Bayer and X-Trans samples on the GPU and develop them into linear Rec.2020 images, with adjustable white balance and exposure, without decoding the file again.

A small TypeScript API wraps LibRaw, Adobe DNG SDK and libjxl compiled into one WASM module. Native libraries handle file formats and decompression in workers; WebGPU handles supported CFA demosaic and color processing. The built package includes its WASM and workers. Consumers supply a `GPUDevice` and do not need a C++ toolchain or a rendering framework. A Bun command-line example uses `vgpu/node` to run the same decoder without a browser.

This package is under development and has not been published yet. TIFF support is experimental; coverage and measured performance are documented below.

## Features

| Capability | Current implementation |
| --- | --- |
| Camera RAW | LibRaw identification, decoding and camera calibration; conventional three-color Bayer stays single-channel on GPU. |
| DNG and iPhone | Integer Bayer and 16-bit linear DNG, including lossless JPEG and JPEG XL. Tested with real iPhone DNG/ProRAW files. |
| Bayer demosaic | Malvar–He–Cutler (MHC) on WebGPU, supporting all four Bayer phases and active-area offsets. |
| X-Trans | Single-channel GPU source with a 6×6 CFA. A pattern-driven shader reconstructs camera RGB once and caches it for fast WB edits; see quality and memory trade-offs below. |
| Compatibility preparation | LibRaw handles special sensor geometry, including Fuji Super CCD and Sigma X3F. DNG SDK applies mandatory DNG corrections before GPU color processing. |
| White balance | Absolute temperature in Kelvin and Adobe SDK tint coordinates; exact as-shot restoration. Small CPU calibration requests return gains and a matrix, without transferring pixels again. |
| GPU development | Black-level normalization, WB gains, CFA demosaic, radial vignette correction, camera color conversion, exposure and orientation. |
| Output | Linear Rec.2020/D65 `rgba16float`, preserving HDR values above 1.0. |
| TIFF | RGB/gray integer and floating-point images, common compression, matrix/TRC ICC profiles and alpha; see coverage below. |
| Resource ownership | Reusable sources and development passes, explicit disposal, shared GPU pipelines per decoder. |

X-Trans reconstruction is independent of white balance. Loading creates an additional `rgba16float` camera-RGB cache; later WB and exposure edits only read that cache and apply gains and a matrix. The original mosaic remains available in `source.texture`. For a 16 MP image, this uses about 32 MB for the mosaic plus 128 MB for the cache, excluding caller-owned outputs. Bayer retains its existing MHC path because its cross-channel corrections do not commute with per-channel WB gains.

### CPU and GPU responsibilities

```text
Blob
  │
  ├─ Worker / WASM
  │    LibRaw: identify camera, decode RAW, extract calibration
  │    DNG SDK + libjxl: DNG/TIFF decoding, including JPEG XL
  │    CPU preparation and linearization where required
  │    Special layouts: LibRaw CPU preparation
  │    Mandatory DNG corrections: SDK stage 2/3 preparation
  │
  ├─ GPU source
  │    Bayer / X-Trans: r16uint mosaic + repeating CFA
  │    X-Trans: one-time GPU reconstruction → rgba16float camera-RGB cache
  │    Linear / library-prepared RGB: rgba16uint or float bits in rgba32uint
  │
  └─ WebGPU development → rgba16float, linear Rec.2020/D65
       normalization → WB → CFA demosaic → radial correction
       → color transform → exposure, with orientation applied
```

The source contains library-prepared samples and calibration, not necessarily untouched sensor bytes. Linear DNG already contains color pixels and needs no demosaic. LibRaw delegates JPEG XL DNG decoding to the DNG SDK, which uses libjxl; these are not separate competing JPEG XL decoders.

Eligible uncompressed files avoid the native decoded-image allocation and return copy:

- **TIFF:** one strip, interleaved byte-aligned 8/16/32-bit samples, no predictor; half-float requiring expansion uses the normal decoding path. WebGPU interprets byte order and converts color.
- **DNG:** unsigned 16-bit little-endian Bayer, one strip, full active area without crop or margins, no linearization table and no stage-1/2 opcodes. Libraries still identify the file, validate its layout and supply calibration.

Both paths still copy the input into WASM for metadata parsing. Other layouts and compressed images use native decoding. Standard uncropped Bayer DNG also avoids LibRaw's sparse four-channel image allocation where possible.

## Usage

### RAW and DNG

```ts
import { createRawDecoder } from "raw-webgpu";

const decoder = createRawDecoder(device); // Your existing GPUDevice.
const source = await decoder.load(file); // A File or Blob.
const destination = device.createTexture({
  size: source.size,
  format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
const pass = source.createDevelopPass();

// Develop using the initial white balance.
pass.render({ destination, calibration: source.calibration });

// Reuse the GPU source; this does not decode the image again.
const calibration = await source.calibrate({ temperature: 5500, tint: 10 });
pass.render({ destination, calibration, exposure: 1 }); // +1 stop.

// When the image is no longer needed:
source.dispose(); // Also disposes its passes and closes its worker.
destination.destroy();
decoder.dispose();
```

A loaded source exposes:

| Member | Meaning |
| --- | --- |
| `texture` | Source-owned `r16uint` mosaic, `rgba16uint` camera RGB, or `rgba32uint` holding float32 camera RGB bits. |
| `metadata` | Sensor size, row-major `cfa` and square `cfaSize` of 2 or 6, `sampleFormat`, `whiteBalanceOrigin`, LibRaw orientation bitmask, black/white levels, radial vignette calibration and `demosaic: "gpu" \| "cpu" \| "none"`. |
| `size` | Oriented output dimensions. |
| `asShot` | Initial temperature and tint. `metadata.whiteBalanceOrigin` distinguishes camera as-shot from a daylight fallback. |
| `calibration` | Initial white-balance gains and a column-major camera-to-linear-Rec.2020/D65 matrix, applied after the gains. |
| `calibrate(balance?)` | Returns calibration for a new white point; omit the argument to restore the initial white point. |
| `createDevelopPass()` | Creates reusable uniforms and a `render({ destination, calibration, exposure?, encoder? })` method. |
| `dispose()` | Releases the source texture, retained worker and all its passes. |

Create separate passes for independently controlled previews or exports. A pass can also be released early with `pass.dispose()`. Without an external encoder, `render()` submits immediately. With an external encoder, render each pass at most once before submitting that encoder: uniform writes are queue operations, not snapshots in the encoder.

The caller owns the device, destination textures and external encoders. `decoder.dispose()` closes loaded and pending sources without destroying the device. Loading resolves after queuing the upload; subsequent work on the same GPU queue is ordered after it. Use `await device.queue.onSubmittedWorkDone()` when measuring completion.

### TIFF

```ts
import { decodeTiff } from "raw-webgpu";

const image = await decodeTiff(device, file);
// image.texture: linear Rec.2020 rgba16float, oriented, straight alpha.
// image.size: [width, height]. Use the texture in your renderer.
image.dispose(); // When no longer needed.
```

TIFF uses a fresh worker, then GPU transfer curves, color conversion, alpha handling and orientation. It reads the first IFD. Floating-point samples are treated as linear; missing or unsupported ICC profiles fall back to sRGB. TIFF sources do not expose camera white-balance calibration.

### Convert a RAW file to PNG with Bun

This example uses `vgpu/node` for a real GPU device and `pngjs` for encoding. Install those in your script's project with `bun add vgpu pngjs`, alongside the built `raw-webgpu` package. Save the snippet as `convert.ts` and run `bun convert.ts`.

```ts
import { PNG } from "pngjs";
import { init, target } from "vgpu/node";
import { createRawDecoder } from "raw-webgpu";

function srgb(value: number) {
  const x = Math.max(0, Math.min(1, value));
  return Math.round(255 * (
    x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  ));
}

const gpu = await init();
const decoder = createRawDecoder(gpu.gpu);
try {
  const source = await decoder.load(Bun.file("photo.dng"));
  const output = target(gpu, { size: source.size, format: "rgba16float" });
  try {
    source.createDevelopPass().render({
      destination: output.color.gpu,
      calibration: source.calibration,
    });

    const pixels = await output.readFloats();
    const image = new PNG({ width: source.size[0], height: source.size[1] });
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = pixels.subarray(i, i + 3);
      // Linear Rec.2020 → linear sRGB → encoded sRGB.
      image.data[i] = srgb(1.660491 * r - 0.587641 * g - 0.072850 * b);
      image.data[i + 1] = srgb(-0.124550 * r + 1.132900 * g - 0.008349 * b);
      image.data[i + 2] = srgb(-0.018151 * r - 0.100579 * g + 1.118730 * b);
      image.data[i + 3] = 255;
    }
    await Bun.write("photo.png", PNG.sync.write(image));
  } finally {
    output.color.dispose();
  }
} finally {
  decoder.dispose();
  gpu.dispose();
}
```

For JPEG, install `jpeg-js`, import its `encode` function and replace the final write with `await Bun.write("photo.jpg", encode(image, 95).data)`. For BMP, use `bmp-js` instead and call `image.data.swap32()` before encoding because it expects ABGR bytes rather than RGBA.

Bun supplies the worker and local file-fetch APIs; Chromium is not required. Plain Node.js is not supported by this snippet. A working GPU backend is required; `vgpu/mock` cannot execute the development shader.

The example uses the initial white balance, develops on GPU, then reads back and converts color on CPU. Output is 8-bit SDR/sRGB with clipping and no photographic tone curve. File encoding belongs to the consuming application; the library does not include image encoders or a conversion helper.

## Interactive white balance

Measured in Chromium 151 on Apple M4 Pro, at full 16 MP resolution. Medians cover ten updates after two warmups; GPU time ends after queue completion.

| File | Repeating demosaic on every WB edit | Cached camera RGB |
| --- | ---: | ---: |
| Fuji X-Pro1 | 127.0 ms | 0.9 ms |
| Fuji X-T10 | 163.2 ms | 1.7 ms |

Calibration requests took about 0.1 ms and opened no RAW files during these updates. The cache adds float16 rounding: 64 probes at three white balances differed from the uncached calculation by at most 0.00098 in linear RGB. These GPU-stage timings fit an 8.33 ms frame budget on this machine; they do not guarantee the frame rate of a complete application.

## Coverage and limitations

RAW support depends on the compiled libraries and available camera calibration. The GPU handles 2×2 Bayer and 6×6 X-Trans mosaics. LibRaw prepares special geometries or black calibration that cannot use that path. Mandatory DNG corrections use the SDK's original-file stage 2/3 processing, including linearization, GainMap and MapTable; prepared RGB stays floating-point until GPU output. Optional corrections outside the fast path may be skipped. These CPU-prepared sources cannot expose pre-demosaic edits.

When LibRaw has no usable as-shot multipliers, the decoder uses its daylight calibration and reports `whiteBalanceOrigin: "daylight"`. This permits manual white balance but does not reproduce the camera's selected white point. This affects the tested Sony A7R II, Mamiya ZD and Sigma DP2 Quattro samples. Sigma color should be treated as experimental. Floating-point RAW input, baked camera white balance, non-three-color sensors and missing camera profiles still have limitations; the package does not promise every LibRaw camera or iPhone capture mode.

X-Trans uses normalized spatial interpolation over a 7×7 neighborhood, weighted by inverse fourth-power distance, while preserving each measured color sample. It is much faster than our previous single-threaded LibRaw Markesteijn three-pass path, but is a different, simpler algorithm. Fine detail is softer and false-color/aliasing behavior differs. The comparison images and timings below measure that trade-off; this is not a claim of Markesteijn-equivalent quality. Bayer retains the existing MHC shader.

### Planned X-Trans quality improvement

The current X-Trans shader uses fixed spatial weights. It averages nearby samples of each missing color without adapting to edge direction or local texture, which can blur fine structures. Preserving the measured channel at each pixel does not preserve detail in the two reconstructed channels. The previous Markesteijn algorithm used more elaborate reconstruction; the loading speedup includes this reduction in algorithm complexity, not just a move to GPU.

Replace this interpolation with a higher-quality GPU demosaic that preserves fine detail and controls false color and aliasing. Compare full-resolution crops against the retained Markesteijn outputs, including fine textures and diagonal edges, and measure both loading and WB interaction costs. Keep reconstruction on GPU. Revisit the camera-RGB cache if the replacement depends on white balance: the current cache is valid because this interpolation operates independently on each color with fixed weights.

Browser tests cover all four Bayer phases, an odd active-area crop, linear JPEG XL, X-Trans GPU reconstruction, mandatory GainMap correction, absolute white balance, exact as-shot restoration, invalid input and cancellation. GPU tests check MHC impulse weights, black levels, orientation, color matrices, HDR, float input, CFA phase and radial correction. Local real-file checks include iPhone XS, 12 Pro, 16 Pro Max and a JPEG XL DNG identified as iPhone 17 Pro; these files are not distributed as fixtures.

TIFF verification against an external 21-file reference suite decoded **17 fixtures successfully and explicitly rejected four**.

| TIFF feature | Status |
| --- | --- |
| RGB/gray 8/16-bit, packed 12-bit, float16/32 | Verified |
| Little/big endian, strips, tiles, planar layout, BigTIFF | Verified |
| Uncompressed, LZW, Deflate, PackBits | Verified |
| Matrix/TRC ICC profiles, associated alpha | Verified |
| Bilevel, palette, float64, YCbCr JPEG fixture | Rejected |

There is no noise-reduction algorithm in the GPU path. Optional CPU denoising is disabled, although library-required corrections may still apply. Highlight reconstruction, Apple Photos tone reproduction, profile look-table rendering, PNG/JPEG loading and UI integration are outside the current API. Images must fit the device's texture limits. Browser use requires WebGPU, WASM SIMD and WASM exception handling. The Bun example uses a native GPU backend. There is no CPU rendering fallback.

## Benchmarks

The [30-camera RAW benchmark](RAW-BENCHMARK.md) includes per-file timings, compatibility results, X-Trans quality limitations and WB measurements. All 30 samples converted in Chromium and Bun. In Chromium, X-Pro1 loading changed from 7,582 to 240 ms and X-T10 from 7,030 to 211 ms, including the camera-RGB cache. These compare different demosaic algorithms.

The earlier SIMD and TIFF measurements below used a 1,796,148-byte WASM, SHA-256 `682e986587a070fbd0b02d7d0f9f5855d0cfc9226a80aa637cf95b83b62c0807`. Times are local macOS ARM64/Chromium measurements, not cross-device guarantees. They measure loading through completed GPU output, not interactive adjustment frame rates.

### RAW: complete loading and development

Five measured runs after one warmup, alternating builds, with an in-memory Blob, a fresh source/worker per load and the same GPU device. Timing includes decoding, upload and development, ending after GPU queue completion; input download, device setup and validation readback are excluded. Values are medians from the [JPEG XL comparison](JPEG-XL-BENCHMARK.md).

| Input | Before SIMD optimization | SIMD benchmark build |
| --- | ---: | ---: |
| 12 MP Bayer DNG, uncompressed | 32.6 ms | **33.2 ms** |
| 12 MP Bayer DNG, lossless JPEG | 194.3 ms | **192.0 ms** |
| 12 MP linear DNG, JPEG XL | 1,218.0 ms | **1,127.4 ms** |
| Real iPhone DNG, JPEG XL | 1,029.0 ms | **943.2 ms** |
| Sony ARW | 370.7 ms | **374.9 ms** |

JPEG XL improves by about 7–8% in this full-pipeline comparison. Small changes in the other rows are measurement variation. The baseline is an earlier raw-webgpu build, **not libraw-wasm**. Three GPU pixel probes match exactly between builds. Bayer and linear DNG process different numbers of channels, so these rows are not a codec-only comparison.

### TIFF loading

Measured on September 9, 2026, in Chromium 151 on macOS ARM64. Each file was loaded six times, with the first run discarded. Medians include worker startup, decoding, upload and GPU completion. Files were already in memory; network transfer, device setup and pixel readback were excluded. Other loader builds participated in rotating order during the measurement.

| Input | Dimensions | File size | Compression | Load time |
| --- | --- | ---: | --- | ---: |
| RGB 16-bit panorama | 3423 × 4279 | 75.2 MB | Deflate, 84 strips | 461.6 ms |
| sRGB 16-bit | 3274 × 5821 | 114.4 MB | None, one strip | 88.8 ms |
| sRGB 8-bit | 3274 × 5821 | 57.2 MB | None, one strip | 61.0 ms |
| Rec.2020 16-bit | 3274 × 5821 | 114.4 MB | None, one strip | 78.7 ms |

The original-byte path reduces copying for eligible uncompressed TIFFs, but does not eliminate WASM initialization, metadata parsing or the initial input copy. Three pixel probes per file agreed with a reference loader within 0.002; this is a sampling check, not full-image equivalence. No WebGPU errors occurred.

The large photographic inputs are not distributed. These measurements describe the tested files and machine, not a reproducible cross-device performance guarantee. The [RAW benchmark notes](JPEG-XL-BENCHMARK.md) record fixture details and methodology for the RAW table.

### WASM download size

| Artifact | Bytes | Decimal size |
| --- | ---: | ---: |
| Current `libraw.wasm` | 1,814,296 | 1.81 MB |
| Gzip, level 9 | 724,709 | 725 KB |
| Brotli, quality 11 | 569,621 | 570 KB |

These figures cover the WASM only, excluding JavaScript and declarations. Compression sizes are measured locally; the server must serve the corresponding content encoding to achieve those transfer sizes. Current WASM SHA-256: `49987a468fc870f6500e5c661e22821f94ed207decb6d980d590260f7d1a072e`. The module uses SIMD and one CPU thread. JPEG XL decompression still runs in WASM, not on WebGPU.

Further reductions are measured in the [WASM size audit](WASM-SIZE-AUDIT.md). Those experimental builds are **not enabled** in the current package and are not the binaries timed above.

## Build and local development

Maintainers need Bun, Python 3, CMake and an activated **Emscripten 6.0.9** environment:

```sh
bun install
bun run build
bun link
```

Then, in the consuming app:

```sh
bun link --save raw-webgpu
```

`build` compiles the native dependencies and adapter, then bundles TypeScript and declarations. The recipe downloads checksum-pinned **LibRaw 0.22.2** and **DNG SDK 1.7.1 build 2724**, including **libjxl 0.11.2**. Objects are cached under `.cache/native`; `RAW_WEBGPU_CACHE` overrides the location. Unchanged native builds are skipped. Use `bun run build:sdk` for TypeScript-only changes.

Generated `index.js`, workers, `libraw.js`, `libraw.wasm` and declarations live in ignored `dist/`. The repository stores source and build configuration; built distributions include the artifacts, so consuming apps do not compile native code. There is no runtime dependency on vgpu; it is used for tests.

| Directory | Responsibility |
| --- | --- |
| `src/decode/` | Workers, native bindings and calibration requests |
| `src/develop/` | RAW GPU resources and development shader |
| `src/tiff/` | TIFF API, profile interpretation and GPU upload |
| `native/` | LibRaw/DNG SDK adapter and reproducible native build |
| `tests/` | Generated RAW fixtures, GPU/browser verification and export checks |

```sh
bun run check          # TypeScript formatting and lint
bun run test           # Browser-free tests
bun run test:gpu       # GPU pixel tests
bun run test:browser   # RAW browser integration
```

Native and fixture formatting use `clang-format` and `ruff format`. Run `bun run test:tiff` for the 21 bundled TIFF fixtures. Only `bun run benchmark:tiff` needs an external reference checkout and photographic inputs.

## License

The TypeScript SDK and shaders are MIT licensed. Bundled native dependencies retain their own licenses. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
