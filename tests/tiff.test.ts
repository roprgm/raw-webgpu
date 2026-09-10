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

// The fixture has one embedded ICC profile; keep the original bytes as the valid case.
async function profileFixture() {
	const file = Buffer.from(
		await Bun.file(
			`${import.meta.dir}/fixtures/tiff/rgb16-prophoto.tif`,
		).arrayBuffer(),
	);
	const start = file.indexOf("acsp") - 36;
	return file.subarray(start, start + file.readUInt32BE(start));
}

test("TIFF profiles preserve valid color and reject unsupported or malformed embedded profiles", async () => {
	const { tiffColor } = await import("../src/tiff/color");
	const profile = await profileFixture();
	const untagged = tiffColor(undefined, false);
	expect(tiffColor(profile, false).matrix).not.toEqual(untagged.matrix);
	const unsupported = Buffer.from(profile);
	unsupported.write("CMYK", 16);
	const truncated = profile.subarray(0, 140);
	const badOffset = Buffer.from(profile);
	badOffset.writeUInt32BE(profile.length, 136);
	const shortTag = Buffer.from(profile);
	shortTag.writeUInt32BE(8, shortTag.indexOf("rXYZ", 132) + 8);
	const lut = Buffer.from(profile);
	lut.write("A2B0", 132);
	for (const invalid of [
		new Uint8Array(),
		unsupported,
		truncated,
		badOffset,
		shortTag,
		lut,
	]) {
		expect(() => tiffColor(invalid, false)).toThrow("ICC profile");
	}
});
