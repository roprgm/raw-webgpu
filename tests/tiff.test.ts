import { expect, test } from "bun:test";
import { readStrips } from "../src/tiff/strips";

test("TIFF strips reuse contiguous bytes and assemble scattered rows in order", async () => {
	const bytes = new Uint8Array([99, 1, 2, 3, 4, 99]);
	const contiguous = await readStrips(
		bytes,
		new Uint32Array([1, 2, 2, 3, 2, 2]),
		4,
		false,
	);
	expect(Array.from(contiguous)).toEqual([1, 2, 3, 4]);
	expect(contiguous.buffer).toBe(bytes.buffer);
	expect(
		Array.from(
			await readStrips(bytes, new Uint32Array([3, 2, 2, 1, 2, 2]), 4, false),
		),
	).toEqual([3, 4, 1, 2]);
});
