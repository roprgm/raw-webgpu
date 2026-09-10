import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const root = `${import.meta.dir}/..`;
const dist = process.env.PACKAGE_DIST ?? join(root, "dist");
const fixtures = [
	"bayer.dng",
	"linear-jxl.dng",
	"xtrans.dng",
	"bayer-bggr.dng",
	"bayer-grbg.dng",
	"bayer-gbrg.dng",
	"bayer-cropped.dng",
	"corrected.dng",
];
const paths = new Map<string, string>();
for (const name of fixtures) {
	paths.set(`/fixtures/${name}`, join(root, "tests/fixtures", name));
}
for (const file of new Bun.Glob("**/*").scanSync({
	cwd: dist,
	onlyFiles: true,
})) {
	paths.set(`/dist/${file}`, join(dist, file));
}
if (process.env.RAW_IPHONE_FIXTURES) {
	for (const [name, path] of Object.entries(
		JSON.parse(process.env.RAW_IPHONE_FIXTURES) as Record<string, string>,
	)) {
		paths.set(`/fixtures/${name}`, path);
		fixtures.push(name);
	}
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/") {
			return new Response("<!doctype html><title>raw-webgpu tests</title>", {
				headers: { "Content-Type": "text/html" },
			});
		}
		const file = paths.get(path);
		return file
			? new Response(Bun.file(file))
			: new Response("Not found", { status: 404 });
	},
});
const browser = await chromium.launch({
	channel: "chromium",
	args:
		process.platform === "linux"
			? ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"]
			: [],
});
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page
		.context()
		.route("**/*", (route) =>
			new URL(route.request().url()).origin === server.url.origin
				? route.continue()
				: route.abort(),
		);
	await page.goto(server.url.href);
	const results = await page.evaluate(async (names) => {
		// @ts-expect-error The test server provides the built ESM package.
		const { createRawDecoder } = await import("/dist/index.js");
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) {
			throw Error("WebGPU is unavailable");
		}
		const device = await adapter.requestDevice();
		const gpuErrors: string[] = [];
		device.addEventListener("uncapturederror", (e) =>
			gpuErrors.push(e.error.message),
		);
		const decoder = createRawDecoder(device);
		function half(h: number) {
			const sign = h & 32768 ? -1 : 1,
				exponent = (h >> 10) & 31,
				mantissa = h & 1023;
			return (
				sign *
				(exponent === 0
					? (2 ** -14 * mantissa) / 1024
					: 2 ** (exponent - 15) * (1 + mantissa / 1024))
			);
		}
		async function center(texture: GPUTexture) {
			const buffer = device.createBuffer({
				size: 256,
				usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
			});
			const encoder = device.createCommandEncoder();
			encoder.copyTextureToBuffer(
				{ texture, origin: [texture.width >> 1, texture.height >> 1] },
				{ buffer, bytesPerRow: 256 },
				[1, 1],
			);
			device.queue.submit([encoder.finish()]);
			await buffer.mapAsync(GPUMapMode.READ);
			const value = Array.from(
				new Uint16Array(buffer.getMappedRange()).slice(0, 4),
				half,
			);
			buffer.unmap();
			buffer.destroy();
			return value;
		}
		const output = [];
		for (const name of names) {
			const file = await (await fetch(`/fixtures/${name}`)).blob();
			const source = await decoder.load(file).catch((error: Error) => {
				throw Error(`${name}: ${error.message}`);
			});
			const destination = device.createTexture({
				size: source.size,
				format: "rgba16float",
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
			});
			const pass = source.createDevelopPass();
			pass.render({ destination, calibration: source.calibration });
			const before = await center(destination);
			pass.render({
				destination,
				calibration: await source.calibrate({ temperature: 4000, tint: 20 }),
			});
			const edited = await center(destination);
			pass.render({ destination, calibration: await source.calibrate() });
			const restored = await center(destination);
			output.push({
				name,
				size: source.size,
				format: source.texture.format,
				demosaic: source.metadata.demosaic,
				before,
				edited,
				restored,
			});
			pass.dispose();
			source.dispose();
			source.dispose();
			destination.destroy();
		}
		const bad = await decoder.load(new Blob(["not a raw file"])).then(
			() => false,
			() => true,
		);
		const bayer = await (await fetch("/fixtures/bayer.dng")).blob();
		const controller = new AbortController();
		const abortable = decoder.load(bayer, { signal: controller.signal }).then(
			() => "resolved",
			(error: Error) => error.name,
		);
		controller.abort();
		const aborted = (await abortable) === "AbortError";
		const pending = decoder.load(bayer).then(
			() => false,
			() => true,
		);
		decoder.dispose();
		const cancelled = await pending;
		device.destroy();
		return { output, bad, aborted, cancelled, gpuErrors };
	}, fixtures);
	await Bun.write(
		".cache/browser-results.json",
		JSON.stringify(results, null, 2),
	);
	expect(results.gpuErrors).toEqual([]);
	expect(errors).toEqual([]);
	expect(results.bad).toBe(true);
	expect(results.cancelled).toBe(true);
	for (const result of results.output) {
		expect(result.restored).toEqual(result.before);
		expect(result.edited).not.toEqual(result.before);
		if (!result.name.startsWith("iphone")) {
			for (const [index, expected] of [
				0.401443, 0.265858, 0.14215, 1,
			].entries()) {
				expect(
					Math.abs(
						result.before[index] -
							expected *
								(result.name === "corrected.dng" && index < 3 ? 0.5 : 1),
					),
					result.name,
				).toBeLessThan(0.002);
			}
		}
		if (result.name === "corrected.dng") {
			expect(result.format).toBe("rgba32uint");
			expect(result.demosaic).toBe("cpu");
			continue;
		}
		expect(result.format).toBe(
			result.name.startsWith("bayer") ||
				result.name === "xtrans.dng" ||
				result.name === "iphone-xs.dng"
				? "r16uint"
				: "rgba16uint",
		);
		if (result.name === "xtrans.dng") {
			expect(result.demosaic).toBe("gpu");
		}
	}
	console.log(JSON.stringify(results, null, 2));
} finally {
	await browser.close();
	server.stop();
}
