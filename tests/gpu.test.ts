import { expect, test } from "bun:test";
import { frame, type Gpu, init, target } from "vgpu/node";
import { createGpuSource, createPipeline } from "../src/develop/gpu";
import type { RawPixels } from "../src/types";

async function createRawUpload(gpu: Gpu, pixels: RawPixels) {
	const source = createGpuSource(
		gpu.gpu,
		pixels,
		await createPipeline(gpu.gpu),
	);
	return {
		createPass() {
			const output = target(gpu, { size: source.size, format: "rgba16float" });
			const pass = source.createDevelopPass();
			return {
				output,
				render(
					_frame: unknown,
					calibration: { gains: number[]; matrix: number[] },
				) {
					pass.render({ destination: output.color.gpu, calibration });
				},
				dispose() {
					pass.dispose();
					output.color.dispose();
				},
			};
		},
		dispose: source.dispose,
	};
}

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];

test.skipIf(!process.env.GPU)(
	"Bayer reconstruction follows the published MHC filters on spatial detail",
	async () => {
		const gpu = await init();
		const data = new Uint16Array(8 * 8);
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				data[y * 8 + x] = 1024;
			}
		}
		// Add a red impulse of 1/4 to uniform gray. Expected weights come from Fig. 2.
		data[2 * 8 + 2] = 2048;
		const upload = await createRawUpload(gpu, {
			data,
			size: [8, 8],
			demosaic: "gpu",
			cfa: [0, 1, 3, 2],
			black: [0, 0, 0, 0],
			white: 4096,
			flip: 0,
			vignette: Array(9).fill(0),
		});
		const pass = upload.createPass();
		try {
			frame(gpu, (f) => pass.render(f, { gains: [1, 1, 1], matrix: identity }));
			const result = await pass.output.readFloats();
			for (const [x, y, red, green, blue] of [
				[2, 2, 0.5, 0.375, 0.4375],
				[3, 2, 0.375, 0.25, 0.25],
				[3, 3, 0.3125, 0.25, 0.25],
				[4, 2, 0.25, 0.21875, 0.203125],
			]) {
				const offset = (y * 8 + x) * 4;
				expect(Array.from(result.subarray(offset, offset + 3))).toEqual([
					red,
					green,
					blue,
				]);
			}
		} finally {
			pass.dispose();
			upload.dispose();
			gpu.dispose();
		}
	},
);

function sensor(
	cfa: number[] | null,
	size: [number, number] = [8, 6],
): RawPixels {
	const black = [64, 128, 256, 512];
	const count = size[0] * size[1] * (cfa ? 1 : 4);
	// A loader may return a view into the original file, after its header.
	const data = new Uint16Array(new ArrayBuffer(count * 2 + 16), 16, count);
	for (let y = 0; y < size[1]; y++) {
		for (let x = 0; x < size[0]; x++) {
			for (const c of cfa ? [cfa[(y % 2) * 2 + (x % 2)]] : [0, 1, 2]) {
				data[cfa ? y * size[0] + x : (y * size[0] + x) * 4 + c] =
					black[c] + [0.5, 0.25, 0.125, 0.25][c] * (4096 - black[c]);
			}
		}
	}
	return {
		size,
		demosaic: cfa ? "gpu" : "none",
		data,
		cfa,
		black,
		white: 4096,
		flip: 0,
		vignette: Array(9).fill(0),
	};
}

test.skipIf(!process.env.GPU)(
	"RAW GPU development preserves CFA phase, black levels, matrix color, HDR and orientation",
	async () => {
		const gpu = await init();
		try {
			for (const cfa of [
				null,
				[0, 1, 3, 2],
				[1, 0, 2, 3],
				[3, 2, 0, 1],
				[2, 3, 1, 0],
			]) {
				const pixels = sensor(cfa);
				const upload = await createRawUpload(gpu, pixels);
				const pass = upload.createPass();
				try {
					for (const gains of [
						[1, 1, 1],
						[4, 2, 1],
					]) {
						// Non-symmetric matrix also checks WGSL column ordering.
						const matrix = [1, 0, 0, 0.5, 1, 0, 0, 0, 2];
						frame(gpu, (f) => pass.render(f, { gains, matrix }));
						const result = await pass.output.readFloats();
						const expected = [
							0.5 * gains[0] + 0.125 * gains[1],
							0.25 * gains[1],
							0.25 * gains[2],
							1,
						];
						for (let i = 0; i < result.length; i++) {
							expect(Math.abs(result[i] - expected[i % 4])).toBeLessThan(0.002);
						}
					}
				} finally {
					pass.dispose();
					upload.dispose();
				}
			}
			for (let flip = 0; flip < 8; flip++) {
				const pixels = sensor(null, [3, 2]);
				pixels.flip = flip;
				pixels.black = [0, 0, 0, 0];
				for (let i = 0; i < 6; i++) pixels.data[i * 4] = (i + 1) * 512;
				const upload = await createRawUpload(gpu, pixels);
				const pass = upload.createPass();
				try {
					frame(gpu, (f) =>
						pass.render(f, { gains: [1, 1, 1], matrix: identity }),
					);
					const result = await pass.output.readFloats();
					const orders = [
						[1, 2, 3, 4, 5, 6],
						[3, 2, 1, 6, 5, 4],
						[4, 5, 6, 1, 2, 3],
						[6, 5, 4, 3, 2, 1],
						[1, 4, 2, 5, 3, 6],
						[3, 6, 2, 5, 1, 4],
						[4, 1, 5, 2, 6, 3],
						[6, 3, 5, 2, 4, 1],
					];
					expect(pass.output.size).toEqual(flip & 4 ? [2, 3] : [3, 2]);
					expect(Array.from(result.filter((_, i) => i % 4 === 0))).toEqual(
						orders[flip].map((value) => value / 8),
					);
				} finally {
					pass.dispose();
					upload.dispose();
				}
			}
			// A DNG radial correction 1 + r² doubles the corner, without clipping HDR.
			const pixels = sensor(null, [2, 2]);
			pixels.vignette = [1, 0, 0, 0, 0, -1, -1, 1, 1];
			const upload = await createRawUpload(gpu, pixels);
			const pass = upload.createPass();
			try {
				frame(gpu, (f) =>
					pass.render(f, { gains: [2, 1, 1], matrix: identity }),
				);
				const result = await pass.output.readFloats();
				expect(result[0]).toBe(1.5);
				expect(result[1]).toBe(0.375);
			} finally {
				pass.dispose();
				upload.dispose();
			}
		} finally {
			gpu.dispose();
		}
	},
);

test.skipIf(!process.env.GPU)(
	"SDK float camera RGB preserves HDR and GPU white balance",
	async () => {
		const gpu = await init();
		const upload = await createRawUpload(gpu, {
			data: new Float32Array([2, 0.5, 0.25, 0]),
			size: [1, 1],
			cfa: null,
			black: [0, 0, 0, 0],
			white: 1,
			flip: 0,
			vignette: Array(9).fill(0),
			demosaic: "cpu",
			sampleFormat: "float32",
		});
		const pass = upload.createPass();
		try {
			for (const gains of [
				[1, 1, 1],
				[2, 1, 4],
			]) {
				pass.render(null, { gains, matrix: identity });
				expect(Array.from(await pass.output.readFloats())).toEqual([
					2 * gains[0],
					0.5,
					0.25 * gains[2],
					1,
				]);
			}
		} finally {
			pass.dispose();
			upload.dispose();
			gpu.dispose();
		}
	},
);

test.skipIf(!process.env.GPU)(
	"6x6 CFA reconstruction preserves sensor channels, phase and edges",
	async () => {
		const gpu = await init();
		const pattern = [
			1, 0, 1, 1, 2, 1, 2, 1, 2, 0, 1, 0, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 1, 0,
			1, 0, 2, 1, 2, 1, 2, 1, 1, 0, 1,
		];
		try {
			for (let shift = 0; shift < 6; shift++) {
				const cfa = pattern.map(
					(_, i) =>
						pattern[((Math.floor(i / 6) + shift) % 6) * 6 + ((i + shift) % 6)],
				);
				const data = new Uint16Array(18 * 18);
				for (let y = 0; y < 18; y++)
					for (let x = 0; x < 18; x++)
						data[y * 18 + x] = [2048, 1024, 512][cfa[(y % 6) * 6 + (x % 6)]];
				const upload = await createRawUpload(gpu, {
					data,
					cfa,
					cfaSize: 6,
					size: [18, 18],
					black: [0, 0, 0, 0],
					white: 4096,
					flip: 0,
					vignette: Array(9).fill(0),
					demosaic: "gpu",
				});
				const pass = upload.createPass();
				try {
					pass.render(null, { gains: [1, 2, 4], matrix: identity });
					const result = await pass.output.readFloats();
					for (let i = 0; i < result.length; i++)
						expect(Math.abs(result[i] - (i % 4 === 3 ? 1 : 0.5))).toBeLessThan(
							0.002,
						);
				} finally {
					pass.dispose();
					upload.dispose();
				}
			}
		} finally {
			gpu.dispose();
		}
	},
);
