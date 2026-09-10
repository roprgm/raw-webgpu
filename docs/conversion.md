# Convert a RAW file to PNG with Bun

This example uses `vgpu/node` for a real GPU device and `pngjs` for encoding. Install those in your script's project with `bun add vgpu pngjs`, alongside the built `raw-webgpu` package. Save the snippet as `convert.ts` and run `bun convert.ts`.

```ts
import { PNG } from "pngjs";
import { init, target } from "vgpu/node";
import { createRawDecoder } from "raw-webgpu";

const gpu = await init();
const decoder = createRawDecoder(gpu.gpu);
try {
  const source = await decoder.load(Bun.file("photo.dng"));
  const output = target(gpu, { size: source.size, format: "rgba8unorm" });
  try {
    source.createDevelopPass({ outputColorSpace: "srgb", format: "rgba8unorm" }).render({
      destination: output.color.gpu,
      calibration: source.calibration,
    });

    const image = new PNG({ width: source.size[0], height: source.size[1] });
    image.data.set(await output.read());
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

The example uses the initial white balance, develops and converts to sRGB on GPU, then reads back the encoded bytes. Output is 8-bit SDR/sRGB with clipping and no photographic tone curve. File encoding belongs to the consuming application; the library does not include image encoders or a conversion helper.
