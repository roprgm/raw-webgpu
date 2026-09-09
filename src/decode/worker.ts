import type { RawPixels, RawReply, WhiteBalance } from "../types";
import createLibRaw from "./libraw.js";

const decoder = fetch(new URL("./libraw.wasm", import.meta.url))
	.then((response) => {
		if (!response.ok) {
			throw Error("Could not load the RAW decoder.");
		}
		return response.arrayBuffer();
	})
	.then((wasmBinary) => createLibRaw({ wasmBinary }));
let source = 0;
let asShot: WhiteBalance;

self.onmessage = async ({
	data: { id, value },
}: MessageEvent<{
	id: number;
	value: Blob | WhiteBalance;
}>) => {
	try {
		const raw = await decoder;
		let image: RawPixels | undefined;
		let temperature = 0;
		let tint = 0;
		if (value instanceof Blob) {
			const bytes = new Uint8Array(await value.arrayBuffer());
			const pointer = raw._malloc(bytes.length);
			if (!pointer) {
				throw Error("Not enough memory to open this RAW image.");
			}
			try {
				raw.HEAPU8.set(bytes, pointer);
				source = raw._raw_open(pointer, bytes.length);
				if (!source) {
					throw Error(raw.UTF8ToString(raw._raw_error()));
				}
				const width = raw._raw_width(source);
				const height = raw._raw_height(source);
				const pixels = raw._raw_pixels(source) / 2;
				const mosaic = Boolean(raw._raw_mosaic(source));
				const demosaic = raw._raw_cpu_demosaic(source) ? "cpu" : "none";
				const black = raw._raw_black(source) / 8;
				const cfa = raw._raw_cfa(source) / 4;
				const vignette = raw._raw_vignette(source) / 8;
				image = {
					size: [width, height],
					demosaic: mosaic ? "gpu" : demosaic,
					data: raw.HEAPU16.slice(
						pixels,
						pixels + width * height * (mosaic ? 1 : 4),
					),
					black: Array.from(raw.HEAPF64.subarray(black, black + 4)),
					white: raw._raw_white(source),
					flip: raw._raw_flip(source),
					vignette: Array.from(raw.HEAPF64.subarray(vignette, vignette + 9)),
					cfa: mosaic ? Array.from(raw.HEAPU32.subarray(cfa, cfa + 4)) : null,
				};
				asShot = {
					temperature: raw._raw_temperature(source),
					tint: raw._raw_tint(source),
				};
				raw._raw_free_pixels(source);
			} finally {
				raw._free(pointer);
			}
		} else if (
			value.temperature !== asShot.temperature ||
			value.tint !== asShot.tint
		) {
			temperature = value.temperature;
			tint = value.tint;
		}
		const pointer = raw._raw_calibration(source, temperature, tint);
		if (!pointer) {
			throw Error(raw.UTF8ToString(raw._raw_error()));
		}
		const values = raw.HEAPF64.subarray(pointer / 8, pointer / 8 + 12);
		const reply: RawReply = {
			image,
			asShot,
			calibration: {
				gains: Array.from(values.subarray(0, 3)),
				// Native rows become WGSL columns; the GPU pass supplies uniform padding.
				matrix: [
					values[3],
					values[6],
					values[9],
					values[4],
					values[7],
					values[10],
					values[5],
					values[8],
					values[11],
				],
			},
		};
		self.postMessage(
			{ id, ...reply },
			{ transfer: image ? [image.data.buffer] : [] },
		);
	} catch (error) {
		self.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
