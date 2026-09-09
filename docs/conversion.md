# Convert a RAW file to PNG with Bun

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
