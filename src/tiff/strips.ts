/** Preserve contiguous file bytes; otherwise assemble strips using the browser Deflate codec when needed. */
export async function readStrips(
	bytes: Uint8Array<ArrayBuffer>,
	strips: Uint32Array,
	byteLength: number,
	compressed: boolean,
) {
	if (!compressed) {
		let end = strips[0];
		let contiguous = true;
		for (let i = 0; i < strips.length; i += 3) {
			contiguous &&= strips[i] === end;
			end += strips[i + 2];
		}
		if (contiguous && end - strips[0] === byteLength) {
			return bytes.subarray(strips[0], end);
		}
	}
	const output = new Uint8Array(byteLength);
	let next = 0;
	let destination = 0;
	await Promise.all(
		Array.from({ length: Math.min(8, strips.length / 3) }, async () => {
			while (next < strips.length) {
				const [offset, length, expected] = strips.subarray(next, next + 3);
				const start = destination;
				next += 3;
				destination += expected;
				if (destination > byteLength) {
					throw Error("Invalid TIFF strip layout.");
				}
				if (!compressed) {
					output.set(bytes.subarray(offset, offset + expected), start);
					continue;
				}
				const stream = new Blob([bytes.subarray(offset, offset + length)])
					.stream()
					.pipeThrough(new DecompressionStream("deflate"));
				const reader = stream.getReader();
				let written = 0;
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) {
							break;
						}
						if (written + value.length > expected) {
							await reader.cancel();
							throw Error("TIFF strip exceeds its expected size.");
						}
						output.set(value, start + written);
						written += value.length;
					}
					if (written !== expected) {
						throw Error("Truncated TIFF strip.");
					}
				} finally {
					reader.releaseLock();
				}
			}
		}),
	);
	if (destination !== byteLength) {
		throw Error("Incomplete TIFF strip layout.");
	}
	return output;
}
