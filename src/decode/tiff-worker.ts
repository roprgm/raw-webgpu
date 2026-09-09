import { tiffColor } from "../tiff/color";
import { instantiateDecoder } from "./instantiate";

/** Decodes one TIFF per worker; see TiffPixels in ../tiff/upload.ts for the reply layout. */
self.onmessage = async ({
	data: { file, module },
}: MessageEvent<{ file: Blob; module: WebAssembly.Module }>) => {
	try {
		const raw = await instantiateDecoder(module);

		const bytes = new Uint8Array(await file.arrayBuffer());
		const pointer = raw._malloc(bytes.length);
		if (!pointer) {
			throw Error("Not enough memory to open TIFF.");
		}
		let source = 0;
		try {
			raw.HEAPU8.set(bytes, pointer);
			source = raw._tiff_open(pointer, bytes.length);
			if (!source) {
				throw Error(raw.UTF8ToString(raw._tiff_error()));
			}

			const metadataIndex = raw._tiff_metadata(source) / 4;
			const metadata = raw.HEAPU32.slice(metadataIndex, metadataIndex + 9);
			const [, height, , , bitsPerSample, , , , rowBytes] = metadata;
			const byteLength = height * rowBytes;

			// An uncompressed file lends a view of its own bytes; otherwise copy the decoded image out.
			const originalOffset = raw._tiff_original_offset(source);
			const pixelPointer = raw._tiff_pixels(source);
			const data = originalOffset
				? bytes.subarray(originalOffset, originalOffset + byteLength)
				: raw.HEAPU8.slice(pixelPointer, pixelPointer + byteLength);
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
			raw._free(pointer);
		}
	} catch (error) {
		self.postMessage({
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
