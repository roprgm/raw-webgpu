import { chromium, expect } from "@playwright/test";

// Run against a dev server or deployment to cover worker and WASM loading.
const browser = await chromium.launch({
	channel: "chromium",
	args:
		process.platform === "linux"
			? ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"]
			: [],
});
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await page.goto(process.env.WEB_URL ?? "http://127.0.0.1:5173");
	const input = page.getByRole("button", { name: "Open a RAW photo" });
	const message = page.getByRole("status");
	await expect(message).toHaveText("Drop a RAW photo here or click to open");
	await expect(input).toBeEnabled();
	await input.setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("Not a RAW photo"),
	});
	await expect(message).toHaveText(
		"Could not load this file. Try a camera RAW or DNG.",
	);
	await input.setInputFiles(`${import.meta.dir}/fixtures/bayer.dng`);
	await expect(input).toBeEnabled({ timeout: 15000 });
	await expect(page.locator("canvas")).toHaveAttribute("width", "96");
	await expect(message).toBeEmpty();
	expect(errors).toEqual([]);
} finally {
	await browser.close();
}
