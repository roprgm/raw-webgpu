let compiled: Promise<WebAssembly.Module> | undefined;

async function compile() {
	const response = await fetch(new URL("./libraw.wasm", import.meta.url));
	if (!response.ok) {
		throw Error("Could not load the native decoder.");
	}
	// Streaming compilation lets the browser cache the compiled code, but requires the wasm MIME type.
	const type = response.headers.get("content-type")?.split(";")[0].trim();
	if (type === "application/wasm" && "compileStreaming" in WebAssembly) {
		return WebAssembly.compileStreaming(response);
	}
	return WebAssembly.compile(await response.arrayBuffer());
}

/** Compiles the native decoder once per page; each worker instantiates the shared module. */
export function compileDecoder() {
	compiled ??= compile().catch((error) => {
		compiled = undefined;
		throw error;
	});
	return compiled;
}
