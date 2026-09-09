type LibRaw = {
	HEAPU8: Uint8Array;
	HEAPU16: Uint16Array;
	HEAPU32: Uint32Array;
	HEAPF64: Float64Array;
	UTF8ToString(pointer: number): string;
	_malloc(size: number): number;
	_free(pointer: number): void;
	_raw_open(pointer: number, size: number): number;
	_raw_calibration(source: number, temperature: number, tint: number): number;
	_raw_black(source: number): number;
	_raw_white(source: number): number;
	_raw_cfa(source: number): number;
	_raw_flip(source: number): number;
	_raw_mosaic(source: number): number;
	_raw_cpu_demosaic(source: number): number;
	_raw_vignette(source: number): number;
	_raw_width(source: number): number;
	_raw_height(source: number): number;
	_raw_pixels(source: number): number;
	_raw_free_pixels(source: number): void;
	_raw_temperature(source: number): number;
	_raw_tint(source: number): number;
	_raw_error(): number;
	_raw_close(source: number): void;
};
export default function createLibRaw(options: {
	wasmBinary: ArrayBuffer;
}): Promise<LibRaw>;
