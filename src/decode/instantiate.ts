import createLibRaw, { type LibRaw } from "./libraw.js";

/** Runs inside a worker: binds the Emscripten runtime to a module compiled on the main thread. */
export function instantiateDecoder(module: WebAssembly.Module) {
	return new Promise<LibRaw>((resolve, reject) => {
		createLibRaw({
			instantiateWasm(imports, ready) {
				WebAssembly.instantiate(module, imports).then(
					(instance) => ready(instance, module),
					reject,
				);
				return {};
			},
		}).then(resolve, reject);
	});
}
