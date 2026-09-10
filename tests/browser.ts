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
	channel: process.env.BROWSER_CHANNEL ?? "chromium",
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
		const resources = new Set<{ destroy(): void }>();
		function track<T extends { destroy(): void }>(resource: T) {
			resources.add(resource);
			const destroy = resource.destroy.bind(resource);
			resource.destroy = () => {
				resources.delete(resource);
				destroy();
			};
			return resource;
		}
		const createTexture = device.createTexture.bind(device);
		const createBuffer = device.createBuffer.bind(device);
		device.createTexture = (options) => track(createTexture(options));
		device.createBuffer = (options) => track(createBuffer(options));
		const workers = new Set<Worker>();
		const NativeWorker = Worker;
		globalThis.Worker = class extends NativeWorker {
			constructor(...args: ConstructorParameters<typeof Worker>) {
				super(...args);
				workers.add(this);
			}
			terminate() {
				workers.delete(this);
				super.terminate();
			}
		};
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
		// Independent sources and an abort after loading must not invalidate each other.
		const loadedController = new AbortController();
		const [first, second] = await Promise.all([
			decoder.load(bayer, { signal: loadedController.signal }),
			decoder.load(bayer),
		]);
		loadedController.abort();
		const [changed, unchanged] = await Promise.all([
			first.calibrate({ temperature: 4000, tint: 20 }),
			second.calibrate(),
		]);
		const independent =
			JSON.stringify(unchanged) === JSON.stringify(second.calibration) &&
			JSON.stringify(changed) !== JSON.stringify(unchanged);
		const calibrating = first.calibrate().then(
			() => false,
			() => true,
		);
		first.dispose();
		const closedCalibration = await calibrating;
		await second.calibrate();
		const pending = decoder.load(bayer).then(
			() => false,
			() => true,
		);
		decoder.dispose();
		const cancelled = await pending;
		const cleaned = resources.size === 0 && workers.size === 0;
		const afterDispose = await decoder.load(bayer).then(
			() => false,
			() => true,
		);
		const limitedDevice = await (
			await navigator.gpu.requestAdapter()
		)?.requestDevice();
		if (!limitedDevice) {
			throw Error("No device for limit checks");
		}
		// Simulate a lower advertised limit; this is not a physical low-memory device.
		Object.defineProperty(limitedDevice.limits, "maxTextureDimension2D", {
			value: 64,
		});
		const limitedDecoder = createRawDecoder(limitedDevice);
		const sizeLimit = await limitedDecoder.load(bayer).then(
			(source) => {
				source.dispose();
				return false;
			},
			(error: Error) => error.message.includes("texture size limit"),
		);
		limitedDecoder.dispose();
		limitedDevice.destroy();
		const lostDecoder = createRawDecoder(device);
		await lostDecoder.load(bayer);
		const lostPending = lostDecoder.load(bayer).then(
			() => false,
			() => true,
		);
		device.destroy();
		await device.lost;
		const deviceLost = await lostPending;
		const lostCleaned = resources.size === 0 && workers.size === 0;
		return {
			output,
			bad,
			aborted,
			cancelled,
			independent,
			closedCalibration,
			afterDispose,
			cleaned,
			deviceLost,
			lostCleaned,
			sizeLimit,
			gpuErrors,
		};
	}, fixtures);
	await Bun.write(
		".cache/browser-results.json",
		JSON.stringify(results, null, 2),
	);
	expect(results.gpuErrors).toEqual([]);
	expect(errors).toEqual([]);
	expect(results.bad).toBe(true);
	expect(results.cancelled).toBe(true);
	expect(results.aborted).toBe(true);
	for (const name of [
		"independent",
		"closedCalibration",
		"afterDispose",
		"cleaned",
		"deviceLost",
		"lostCleaned",
		"sizeLimit",
	] as const) {
		expect(results[name], name).toBe(true);
	}
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
