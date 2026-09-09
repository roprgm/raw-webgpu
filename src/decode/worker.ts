import type { RawPixels, RawReply, WhiteBalance } from "../types";
import { instantiateDecoder } from "./instantiate";

const module = Promise.withResolvers<WebAssembly.Module>();
const decoder = module.promise.then(instantiateDecoder);

// The worker keeps one open file so later white balance requests skip decoding.
let source = 0;
let asShot: WhiteBalance;

type Request = { id: number; value: Blob | WhiteBalance };

self.onmessage = async ({
	data,
}: MessageEvent<Request | { module: WebAssembly.Module }>) => {
	if ("module" in data) {
		module.resolve(data.module);
		return;
	}
	const { id, value } = data;
	try {
		const raw = await decoder;
		let image: RawPixels | undefined;
		// A zero temperature asks the native side for the exact as-shot white point,
		// so re-requesting the as-shot values restores the camera neutral without a Kelvin round trip.
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
				if (source) {
					raw._raw_close(source);
					source = 0;
				}
				source = raw._raw_open(pointer, bytes.length);
				if (!source) {
					throw Error(raw.UTF8ToString(raw._raw_error()));
				}
				const width = raw._raw_width(source);
				const height = raw._raw_height(source);
				const mosaic = Boolean(raw._raw_mosaic(source));
				const demosaic = raw._raw_cpu_demosaic(source) ? "cpu" : "none";
				// When the file already holds a plain 16-bit mosaic, the samples come straight from it.
				const originalOffset = raw._raw_original_offset(source);

				// Native pointers are byte offsets; divide by the element size to index a heap view.
				const floating = Boolean(raw._raw_float(source));
				const pixelPointer = raw._raw_pixels(source);
				const Samples = floating ? Float32Array : Uint16Array;
				const sampleCount = width * height * (mosaic ? 1 : 4);
				const blackIndex = raw._raw_black(source) / 8;
				const cfaIndex = raw._raw_cfa(source) / 4;
				const cfaSize = raw._raw_cfa_size(source);
				const vignetteIndex = raw._raw_vignette(source) / 8;

				image = {
					size: [width, height],
					sampleFormat: floating ? "float32" : "uint16",
					whiteBalanceOrigin: raw._raw_daylight_balance(source)
						? "daylight"
						: "as-shot",
					demosaic: mosaic ? "gpu" : demosaic,
					data: originalOffset
						? new Uint16Array(bytes.buffer, originalOffset, width * height)
						: new Samples(
								raw.HEAPU8.slice(
									pixelPointer,
									pixelPointer + sampleCount * Samples.BYTES_PER_ELEMENT,
								).buffer,
							),
					black: Array.from(raw.HEAPF64.subarray(blackIndex, blackIndex + 4)),
					white: raw._raw_white(source),
					flip: raw._raw_flip(source),
					vignette: Array.from(
						raw.HEAPF64.subarray(vignetteIndex, vignetteIndex + 9),
					),
					cfaSize,
					cfa: mosaic
						? Array.from(
								raw.HEAPU32.subarray(cfaIndex, cfaIndex + cfaSize * cfaSize),
							)
						: null,
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
		// Three gains, then a row-major 3x3 matrix.
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
