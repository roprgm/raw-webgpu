import { plugin } from "bun";

await plugin({
	name: "wgsl",
	setup(build) {
		build.onLoad({ filter: /\.wgsl$/ }, async ({ path }) => ({
			contents: `export default ${JSON.stringify(await Bun.file(path).text())}`,
			loader: "js",
		}));
	},
});
