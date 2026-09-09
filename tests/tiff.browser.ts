import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dir, "..");
const fixtureRoot = `${root}/tests/fixtures/tiff`;
const benchmark = process.argv.includes("--benchmark");
// Benchmarks compare against the sibling OpenLight loader and its larger sample files.
const openlight = resolve(process.env.OPENLIGHT ?? `${root}/../openlight`);
if (benchmark && !(await Bun.file(`${openlight}/package.json`).exists())) {
	throw Error(
		`Benchmark needs an OpenLight checkout; set OPENLIGHT (looked in ${openlight}).`,
	);
}
const beforeDist =
	process.env.BEFORE_DIST ?? `${root}/.cache/before-direct/dist`;
const compareBefore =
	benchmark && (await Bun.file(`${beforeDist}/index.js`).exists());
const folder = benchmark ? `${openlight}/public/debug` : fixtureRoot;
const names = [...new Bun.Glob("*.tif").scanSync(folder)].sort();
const paths = new Map<string, string>();
for (const name of names) {
	paths.set(`/files/${name}`, `${folder}/${name}`);
}
for (const name of ["index.js", "tiff-worker.js", "libraw.js", "libraw.wasm"]) {
	paths.set(`/dist/${name}`, `${root}/dist/${name}`);
}
paths.set("/reference.json", `${fixtureRoot}/reference.json`);
if (compareBefore) {
	for (const name of [
		"index.js",
		"tiff-worker.js",
		"libraw.js",
		"libraw.wasm",
	]) {
		paths.set(`/before/${name}`, `${beforeDist}/${name}`);
	}
}

if (benchmark) {
	const cache = `${root}/.cache/tiff-benchmark`;
	await Bun.write(
		`${cache}/reference.ts`,
		`export { init } from "${openlight}/node_modules/vgpu/dist/index.js"; export { uploadTiff } from "${openlight}/src/lib/tiff-gpu/upload.ts";`,
	);
	const worker = (
		await Bun.file(`${openlight}/src/lib/decode/tiff.worker.ts`).text()
	).replace(
		'"@/lib/tiff-gpu/prepare"',
		JSON.stringify(`${openlight}/src/lib/tiff-gpu/prepare.ts`),
	);
	await Bun.write(`${cache}/reference-worker.ts`, worker);
	const result = await Bun.build({
		entrypoints: [`${cache}/reference.ts`, `${cache}/reference-worker.ts`],
		outdir: cache,
		target: "browser",
		loader: { ".wgsl": "text" },
	});
	if (!result.success) {
		throw new AggregateError(result.logs);
	}
	paths.set("/reference.js", `${cache}/reference.js`);
	paths.set("/reference-worker.js", `${cache}/reference-worker.js`);
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = decodeURIComponent(new URL(request.url).pathname);
		if (path === "/") {
			return new Response("<!doctype html><title>TIFF verification</title>", {
				headers: { "Content-Type": "text/html" },
			});
		}
		const file = paths.get(path);
		return file
			? new Response(Bun.file(file))
			: new Response("Not found", { status: 404 });
	},
});
const browser = await chromium.launch({ channel: "chromium" });
try {
	const page = await browser.newPage();
	page.on("console", (message) => console.log(message.text()));
	await page.goto(server.url.href);
	const results = await page.evaluate(
		async ({ names, benchmark, compareBefore }) => {
			// @ts-expect-error Modules are served by the test harness.
			const { decodeTiff } = await import("/dist/index.js");
			// @ts-expect-error Optional frozen build for this direct-byte experiment.
			const before = compareBefore
				? await import("/before/index.js")
				: undefined;

			// @ts-expect-error The reference bundle exists only for benchmarks.
			const reference = benchmark ? await import("/reference.js") : undefined;
			const gpu = reference ? await reference.init() : undefined;
			const adapter = gpu ? undefined : await navigator.gpu.requestAdapter();
			const device: GPUDevice = gpu?.gpu ?? (await adapter?.requestDevice());
			if (!device) {
				throw Error("WebGPU is unavailable");
			}
			const errors: string[] = [];
			device.addEventListener("uncapturederror", (event) =>
				errors.push(event.error.message),
			);
			const fixtures = await (await fetch("/reference.json")).json();
			function half(value: number) {
				const exponent = (value >> 10) & 31;
				const mantissa = value & 1023;
				const sign = value & 32768 ? -1 : 1;
				if (exponent === 31) {
					return mantissa ? NaN : sign * Infinity;
				}
				return (
					sign *
					(exponent
						? 2 ** (exponent - 15) * (1 + mantissa / 1024)
						: (2 ** -14 * mantissa) / 1024)
				);
			}
			async function read(
				texture: GPUTexture,
				points: { x: number; y: number }[],
			) {
				const buffer = device.createBuffer({
					size: points.length * 256,
					usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
				});
				const encoder = device.createCommandEncoder();
				points.forEach(({ x, y }, index) => {
					encoder.copyTextureToBuffer(
						{ texture, origin: [x, y] },
						{ buffer, offset: index * 256, bytesPerRow: 256 },
						[1, 1],
					);
				});
				device.queue.submit([encoder.finish()]);
				await buffer.mapAsync(GPUMapMode.READ);
				const values = new Uint16Array(buffer.getMappedRange());
				const samples = points.map((_, i) =>
					[...values.slice(i * 128, i * 128 + 4)].map(half),
				);
				buffer.unmap();
				buffer.destroy();
				return samples;
			}
			async function previous(file: Blob) {
				const worker = new Worker("/reference-worker.js", { type: "module" });
				try {
					const prepared = await new Promise((resolve, reject) => {
						worker.onmessage = ({ data }) =>
							data.error ? reject(Error(data.error)) : resolve(data);
						worker.onerror = (event) => reject(Error(event.message));
						worker.postMessage(file);
					});
					const target = reference.uploadTiff(gpu, prepared);
					return {
						texture: target.color.gpu,
						size: target.size,
						dispose: () => target.color.dispose(),
					};
				} finally {
					worker.terminate();
				}
			}
			const results = [];
			for (const name of names) {
				const file = await (await fetch(`/files/${name}`)).blob();
				const expected = fixtures.find(
					(entry: { name: string }) => entry.name === name,
				);
				const rows = [];
				for (let run = 0; run < (benchmark ? 6 : 1); run++) {
					const order = compareBefore
						? ["tiff-gpu", "raw-webgpu-before", "raw-webgpu"]
						: ["tiff-gpu", "raw-webgpu"];
					const modes = benchmark
						? [
								...order.slice(run % order.length),
								...order.slice(0, run % order.length),
							]
						: ["raw-webgpu"];
					for (const mode of modes) {
						try {
							await device.queue.onSubmittedWorkDone();
							const start = performance.now();
							const loaders = {
								"raw-webgpu": () => decodeTiff(device, file),
								"raw-webgpu-before": () => before.decodeTiff(device, file),
								"tiff-gpu": () => previous(file),
							};
							const image = await loaders[mode as keyof typeof loaders]();
							await device.queue.onSubmittedWorkDone();
							const ms = performance.now() - start;
							const points = expected?.points ?? [
								{ x: 0, y: 0 },
								{
									x: Math.floor(image.size[0] / 2),
									y: Math.floor(image.size[1] / 2),
								},
								{ x: image.size[0] - 1, y: image.size[1] - 1 },
							];
							const samples = await read(image.texture, points);
							const maxError = expected
								? Math.max(
										...samples.flatMap((pixel, i) =>
											pixel.map((v, c) =>
												Math.abs(v - expected.points[i].rgba[c]),
											),
										),
									)
								: 0;
							rows.push({
								mode,
								run,
								ms,
								size: image.size,
								samples,
								maxError,
								tolerance: expected?.tolerance,
							});
							image.dispose();
						} catch (error) {
							rows.push({ mode, run, error: String(error) });
						}
					}
				}
				const result = { name, bytes: file.size, rows };
				results.push(result);
				console.log(JSON.stringify(result));
			}
			let aborted = false;
			if (!benchmark) {
				const controller = new AbortController();
				const file = await (await fetch(`/files/${names[0]}`)).blob();
				const pending = decodeTiff(device, file, { signal: controller.signal });
				controller.abort();
				aborted = await pending.then(
					() => false,
					(error: Error) => error.name === "AbortError",
				);
			}
			gpu?.dispose();
			if (!gpu) {
				device.destroy();
			}
			return { results, errors, aborted, userAgent: navigator.userAgent };
		},
		{ names, benchmark, compareBefore },
	);
	await Bun.write(
		`${root}/.cache/tiff-${benchmark ? "benchmark" : "fixtures"}.json`,
		JSON.stringify(results, null, 2),
	);
	if (results.errors.length) {
		throw Error(results.errors.join("\n"));
	}
	if (benchmark) {
		for (const result of results.results) {
			if (result.rows.some((row) => "error" in row)) {
				throw Error(`Benchmark failed to load ${result.name}`);
			}
			const before = result.rows.find((row) => row.mode === "tiff-gpu");
			const after = result.rows.find((row) => row.mode === "raw-webgpu");
			if (before && after && "samples" in before && "samples" in after) {
				const maxDifference = Math.max(
					...before.samples.flatMap((pixel, i) =>
						pixel.map((v, c) => Math.abs(v - after.samples[i][c])),
					),
				);
				if (!Number.isFinite(maxDifference) || maxDifference > 0.002) {
					throw Error(`Benchmark pixel mismatch: ${result.name}`);
				}
			}
		}
	}
	if (!benchmark) {
		if (!results.aborted) {
			throw Error("Aborting a TIFF decode did not reject with AbortError");
		}
		const unsupported = new Set([
			"bilevel.tif",
			"palette8.tif",
			"float64.tif",
			"rgb8-jpeg.tif",
		]);
		for (const result of results.results) {
			const failed = result.rows.some((row) => "error" in row);
			if (failed !== unsupported.has(result.name)) {
				throw Error(`Unexpected TIFF coverage: ${result.name}`);
			}
		}

		const failures = results.results.filter((result) =>
			result.rows.some(
				(row) =>
					"maxError" in row &&
					(!Number.isFinite(row.maxError) ||
						row.maxError > (row.tolerance ?? 0.001)),
			),
		);
		if (failures.length) {
			throw Error(
				`Pixel mismatches: ${failures.map((result) => result.name).join(", ")}`,
			);
		}
	}
} finally {
	await browser.close();
	server.stop();
}
