/** Column-major 3x3 matrix as nine numbers, the layout of WGSL mat3x3f. */
export type Mat3 = readonly number[];

/** The product a·b, so b applies first. */
export function multiplyMat3(a: Mat3, b: Mat3): number[] {
	const result: number[] = [];
	for (let column = 0; column < 3; column++) {
		const [x, y, z] = b.slice(column * 3, column * 3 + 3);
		for (let row = 0; row < 3; row++) {
			result.push(a[row] * x + a[3 + row] * y + a[6 + row] * z);
		}
	}
	return result;
}
