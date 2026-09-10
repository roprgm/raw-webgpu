import { tiffColor } from "../tiff/color";
import { readStrips } from "../tiff/strips";
import { instantiateDecoder } from "./instantiate";

/** Decodes one TIFF per worker; see TiffPixels in ../tiff/upload.ts for the reply layout. */
self.onmessage = async ({
	data: { file, module },
}: MessageEvent<{ file: Blob; module: WebAssembly.Module }>) => {
	try {
		const raw = await instantiateDecoder(module);

		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.length > 0xffffffff) {
			throw Error("TIFF files larger than 4 GiB are not supported.");
		}
		raw.tiffBytes = bytes;
		let source = 0;
		try {
			source = raw._tiff_open(
				bytes.length,
				typeof DecompressionStream !== "undefined",
			);
			if (!source) {
				throw Error(raw.UTF8ToString(raw._tiff_error()));
			}

			const metadataIndex = raw._tiff_metadata(source) / 4;
			const metadata = raw.HEAPU32.slice(metadataIndex, metadataIndex + 11);
			const [, height, , , bitsPerSample, , , , rowBytes] = metadata;
			const byteLength = height * rowBytes;

			const pixelPointer = raw._tiff_pixels(source);
			const stripCount = raw._tiff_strip_count(source);
			const stripIndex = raw._tiff_strips(source) / 4;
			const strips = raw.HEAPU32.slice(stripIndex, stripIndex + stripCount * 3);
			const data = stripCount
				? await readStrips(bytes, strips, byteLength, metadata[9] !== 1)
				: raw.HEAPU8.slice(pixelPointer, pixelPointer + byteLength);
			if (stripCount && metadata[10] !== 1) {
				const pointer = raw._malloc(data.length);
				if (!pointer) {
					throw Error("Not enough memory for TIFF prediction.");
				}
				try {
					raw.HEAPU8.set(data, pointer);
					raw._tiff_predict(source, pointer);
					data.set(raw.HEAPU8.subarray(pointer, pointer + data.length));
				} finally {
					raw._free(pointer);
				}
			}

			const bigEndian = Boolean(raw._tiff_big_endian(source));

			const profilePointer = raw._tiff_profile(source);
			const profileSize = raw._tiff_profile_size(source);
			const profile = profileSize
				? raw.HEAPU8.slice(profilePointer, profilePointer + profileSize)
				: undefined;
			// Float samples report zero bits and are already linear.
			const color = tiffColor(profile, bitsPerSample === 0);

			self.postMessage(
				{ data, metadata, color, bigEndian },
				{ transfer: [data.buffer, metadata.buffer, color.table.buffer] },
			);
		} finally {
			if (source) {
				raw._tiff_close(source);
			}
			raw.tiffBytes = undefined;
		}
	} catch (error) {
		self.postMessage({
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
