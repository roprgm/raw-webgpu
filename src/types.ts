export type WhiteBalance = { temperature: number; tint: number };
/** Column-major camera RGB to linear Rec.2020/D65, after applying gains. */
export type Calibration = { gains: number[]; matrix: number[] };
export type RawMetadata = {
	/** Sensor dimensions before applying the LibRaw orientation bitmask. */
	size: [number, number];
	flip: number;
	/** Active-area 2x2 CFA: R=0, G=1 or 3, B=2; null means camera RGB. */
	cfa: number[] | null;
	black: number[];
	white: number;
	/** Five radial coefficients, two origin coordinates, two coordinate scales. */
	vignette: number[];
	demosaic: "gpu" | "cpu" | "none";
};
export type RawPixels = RawMetadata & { data: Uint16Array<ArrayBuffer> };
export type RawReply = {
	image?: RawPixels;
	calibration: Calibration;
	asShot: WhiteBalance;
};
export type DevelopOptions = {
	destination: GPUTexture;
	calibration: Calibration;
	/** Exposure in stops, default zero. */
	exposure?: number;
	/** If omitted, submit immediately on the consumer's device. */
	encoder?: GPUCommandEncoder;
};
