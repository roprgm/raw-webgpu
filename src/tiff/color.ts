import { type Mat3, multiplyMat3 } from "../math";

type Curve = (encoded: number) => number;
type Profile = { colorants: Mat3; curves: [Curve, Curve, Curve] };

const tableSize = 1024;
const d50 = [0.9642, 1, 0.8249] as const;
const identity: Curve = (v) => v;

/** XYZ (D50, the ICC connection space) to linear RGB with D65 white, Bradford-adapted. Column-major. */
// biome-ignore format: keep the matrix columns readable
const xyzToRec2020: Mat3 = [
	1.6472945, -0.6826024, 0.0296711,
	-0.3935777, 1.6475829, -0.0629319,
	-0.2359823, 0.0128128, 1.253617,
];

/** What untagged samples mean: sRGB colorants adapted to D50, and the sRGB curve. */
const srgbCurve: Curve = (v) =>
	v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgb: Profile = {
	// biome-ignore format: keep the matrix columns readable
	colorants: [
		0.4361, 0.2225, 0.0139,
		0.3851, 0.7169, 0.0971,
		0.1431, 0.0606, 0.7141,
	],
	curves: [srgbCurve, srgbCurve, srgbCurve],
};

/**
 * Reads a matrix/TRC profile: RGB colorants and a curve per channel, or a single curve for gray.
 * Unsupported lookup-table profiles and malformed profiles are not accepted.
 */
export function readProfile(bytes: Uint8Array): Profile | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// Four-character signature, and ICC s15Fixed16 numbers.
	const text = (at: number) =>
		String.fromCharCode(...bytes.subarray(at, at + 4));
	const fixed = (at: number) => view.getInt32(at) / 65536;
	if (bytes.length < 132 || text(36) !== "acsp") {
		return;
	}

	// The tag table follows the 128-byte header: a count, then 12-byte entries of signature, offset, size.
	const tags = new Map<string, { at: number; size: number }>();
	if (view.getUint32(128) > (bytes.length - 132) / 12) {
		return;
	}
	for (let i = 0, count = view.getUint32(128); i < count; i++) {
		const at = view.getUint32(136 + i * 12);
		const size = view.getUint32(140 + i * 12);
		if (at < 128 || size < 8 || at > bytes.length - size) {
			return;
		}
		tags.set(text(132 + i * 12), { at, size });
	}

	if ([...tags.keys()].some((name) => /^(A2B|B2A|D2B|B2D)/.test(name))) {
		return;
	}

	const xyz = (name: string) => {
		const tag = tags.get(name);
		if (!tag || tag.size < 20 || text(tag.at) !== "XYZ ") {
			return;
		}
		return [fixed(tag.at + 8), fixed(tag.at + 12), fixed(tag.at + 16)] as const;
	};

	const curve = (name: string): Curve | undefined => {
		const tag = tags.get(name);
		if (!tag || tag.size < 12) {
			return;
		}
		const { at, size } = tag;
		if (text(at) === "curv") {
			// A count of 0 is identity, 1 is a gamma in 8.8 fixed point, more is a table of 16-bit values.
			const count = view.getUint32(at + 8);
			if (count > (size - 12) / 2) {
				return;
			}
			const entry = (i: number) =>
				view.getUint16(at + 12 + 2 * Math.min(i, count - 1)) / 65535;
			if (count === 0) {
				return identity;
			}
			if (count === 1) {
				const gamma = view.getUint16(at + 12) / 256;
				return (x) => x ** gamma;
			}
			return (x) => {
				const position = x * (count - 1);
				const low = Math.floor(position);
				return entry(low) + (entry(low + 1) - entry(low)) * (position - low);
			};
		}
		if (text(at) === "para") {
			// Parametric kinds 0 to 4 take 1, 3, 4, 5, or 7 parameters: gamma, then a, b, c, d, e, f.
			const kind = view.getUint16(at + 8);
			const count = [1, 3, 4, 5, 7][kind];
			if (!count || count > (size - 12) / 4) {
				return;
			}
			const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from(
				{ length: count },
				(_, i) => fixed(at + 12 + i * 4),
			);
			if (kind === 0) {
				return (x) => x ** g;
			}
			if (kind <= 2) {
				return (x) => (x >= -b / a ? (a * x + b) ** g + c : c);
			}
			return (x) => (x >= d ? (a * x + b) ** g + e : c * x + f);
		}
	};

	try {
		if (text(16) === "GRAY") {
			const k = curve("kTRC");
			return (
				k && {
					colorants: [...d50, 0, 0, 0, 0, 0, 0],
					curves: [k, k, k],
				}
			);
		}
		const [r, g, b] = [xyz("rXYZ"), xyz("gXYZ"), xyz("bXYZ")];
		const [rc, gc, bc] = [curve("rTRC"), curve("gTRC"), curve("bTRC")];
		if (text(16) !== "RGB " || !r || !g || !b || !rc || !gc || !bc) {
			return;
		}
		return {
			colorants: [...r, ...g, ...b],
			curves: [rc, gc, bc],
		};
	} catch {
		return;
	}
}

/** Three curves sampled over 0..1 into one table, one channel after another. */
const sampleCurves = (curves: Profile["curves"]) =>
	Float32Array.from({ length: 3 * tableSize }, (_, i) =>
		curves[Math.floor(i / tableSize)]((i % tableSize) / (tableSize - 1)),
	);

/** ICC curves and camera-independent conversion into linear Rec.2020. */
export function tiffColor(icc: Uint8Array | undefined, linear: boolean) {
	const profile = icc ? readProfile(icc) : srgb;
	if (!profile) {
		throw Error("Unsupported or malformed TIFF ICC profile.");
	}
	const table = sampleCurves(
		linear ? [identity, identity, identity] : profile.curves,
	);
	// Invalid curves must not produce a plausible image with the wrong colors.
	if (!table.every(Number.isFinite)) {
		throw Error("Malformed TIFF ICC transfer curve.");
	}
	return {
		table,
		matrix: multiplyMat3(xyzToRec2020, profile.colorants),
	};
}
