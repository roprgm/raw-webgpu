import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

// Install the actual tarball outside the workspace link, then test its public API and assets.
const root = resolve(import.meta.dir, "..");
const cache = join(root, ".cache/package");
await mkdir(cache, { recursive: true });
await $`bun pm pack --destination ${cache}`.cwd(root);
const { name, version } = await Bun.file(join(root, "package.json")).json();
const tarball = join(cache, `${name}-${version}.tgz`);
const consumer = await mkdtemp(join(tmpdir(), "raw-webgpu-consumer-"));
await Bun.write(
	join(consumer, "package.json"),
	JSON.stringify({
		private: true,
		type: "module",
		dependencies: { [name]: `file:${tarball}` },
		devDependencies: { typescript: "5.9.3", "@webgpu/types": "0.1.72" },
	}),
);
await $`bun install --ignore-scripts`.cwd(consumer);
await Bun.write(
	join(consumer, "index.ts"),
	`import { createRawDecoder, decodeTiff, type RawSource } from "raw-webgpu";
declare const device: GPUDevice;
export async function load(file: Blob) {
  const decoder = createRawDecoder(device);
  const source: RawSource = await decoder.load(file);
  const calibration = await source.calibrate({ temperature: 6500, tint: 0 });
  const pass = source.createDevelopPass({ outputColorSpace: "srgb", format: "bgra8unorm" });
  pass.dispose();
  source.dispose();
  decoder.dispose();
  const tiff = await decodeTiff(device, file);
  tiff.dispose();
  return calibration;
}
`,
);
await Bun.write(
	join(consumer, "tsconfig.json"),
	JSON.stringify({
		compilerOptions: {
			target: "ESNext",
			module: "ESNext",
			moduleResolution: "bundler",
			strict: true,
			noEmit: true,
			types: ["@webgpu/types"],
		},
		include: ["index.ts"],
	}),
);
await $`${join(consumer, "node_modules/.bin/tsc")} -p ${consumer}`;
const dist = join(consumer, "node_modules/raw-webgpu/dist");
for (const test of ["tests/browser.ts", "tests/tiff.browser.ts"]) {
	await $`bun ${test}`.cwd(root).env({ ...process.env, PACKAGE_DIST: dist });
}
console.log(`Verified ${tarball}`);
