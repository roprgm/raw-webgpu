/** Emscripten module for the native sources; pointers are byte offsets into the heap views. */
export type LibRaw = {
	HEAPU8: Uint8Array;
	HEAPU16: Uint16Array;
	HEAPU32: Uint32Array;
	HEAPF64: Float64Array;
	UTF8ToString(pointer: number): string;
	_malloc(size: number): number;
	_free(pointer: number): void;

	// native/bridge.cpp
	_raw_open(pointer: number, size: number): number;
	_raw_error(): number;
	_raw_calibration(source: number, temperature: number, tint: number): number;
	_raw_width(source: number): number;
	_raw_height(source: number): number;
	_raw_flip(source: number): number;
	_raw_mosaic(source: number): number;
	_raw_float(source: number): number;
	_raw_daylight_balance(source: number): number;
	_raw_cpu_demosaic(source: number): number;
	_raw_cfa(source: number): number;
	_raw_cfa_size(source: number): number;
	_raw_black(source: number): number;
	_raw_white(source: number): number;
	_raw_vignette(source: number): number;
	_raw_original_offset(source: number): number;
	_raw_pixels(source: number): number;
	_raw_free_pixels(source: number): void;
	_raw_temperature(source: number): number;
	_raw_tint(source: number): number;
	_raw_close(source: number): void;

	// native/tiff.cpp
	tiffBytes?: Uint8Array;
	_tiff_open(size: number, browserDeflate: boolean): number;
	_tiff_error(): number;
	_tiff_metadata(source: number): number;
	_tiff_big_endian(source: number): number;
	_tiff_strips(source: number): number;
	_tiff_strip_count(source: number): number;
	_tiff_predict(source: number, pointer: number): void;
	_tiff_pixels(source: number): number;
	_tiff_profile(source: number): number;
	_tiff_profile_size(source: number): number;
	_tiff_close(source: number): void;
};

export default function createLibRaw(options: {
	/** Emscripten calls this instead of fetching; call `ready` once the instance exists. */
	instantiateWasm(
		imports: WebAssembly.Imports,
		ready: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
	): object;
}): Promise<LibRaw>;
