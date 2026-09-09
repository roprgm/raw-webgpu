export type WhiteBalance = { temperature: number; tint: number };

/** Column-major camera RGB to linear Rec.2020/D65, after applying gains. */
export type Calibration = { gains: number[]; matrix: number[] };

export type RawMetadata = {
	/** Sensor dimensions before applying the LibRaw orientation bitmask. */
	size: [number, number];
	/** LibRaw orientation bitmask: 4 transposes, 2 mirrors vertically, 1 mirrors horizontally. */
	flip: number;
	/** Row-major repeating CFA: R=0, G=1 or 3, B=2; null means camera RGB. */
	cfa: number[] | null;
	/** Square CFA side length; defaults to 2 for Bayer. */
	cfaSize?: number;
	/** Black level per CFA color index, in sensor units. */
	black: number[];
	/** Saturation level, in sensor units. */
	white: number;
	/** Five radial coefficients, two origin coordinates, two coordinate scales. */
	vignette: number[];
	demosaic: "gpu" | "cpu" | "none";
	/** Float samples are already normalized by the DNG SDK. */
	sampleFormat?: "uint16" | "float32";
	whiteBalanceOrigin?: "as-shot" | "daylight";
};

/** One uint16 sample per mosaic pixel; four uint16 or float32 samples for camera RGB. */
export type RawPixels = RawMetadata & {
	data: Uint16Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
};

export type RawReply = {
	/** Present only when the request opened a file. */
	image?: RawPixels;
	calibration: Calibration;
	asShot: WhiteBalance;
};

export type LoadOptions = {
	/** Aborting rejects a pending load with the signal's reason; a loaded source is unaffected. */
	signal?: AbortSignal;
};

export type DevelopOptions = {
	destination: GPUTexture;
	calibration: Calibration;
	/** Exposure in stops, default zero. */
	exposure?: number;
	/** If omitted, submit immediately on the consumer's device. */
	encoder?: GPUCommandEncoder;
};
