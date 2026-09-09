const result = await Bun.build({
	entrypoints: [
		"src/index.ts",
		"src/decode/worker.ts",
		"src/decode/tiff-worker.ts",
	],
	outdir: "dist",
	naming: "[name].[ext]",
	target: "browser",
	loader: { ".wgsl": "text" },
	external: ["./src/decode/libraw.js"],
});
if (!result.success) {
	throw new AggregateError(result.logs, "SDK build failed");
}
