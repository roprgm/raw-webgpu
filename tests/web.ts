import { chromium, expect } from "@playwright/test";

// Run against the actual Vite server so local-package WASM access is covered.
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
	await expect(input).toBeEnabled();
	await input.setInputFiles(`${import.meta.dir}/fixtures/bayer.dng`);
	await expect(input).toBeEnabled({ timeout: 15000 });
	await expect(page.locator("canvas")).toHaveAttribute("width", "96");
	expect(errors).toEqual([]);
} finally {
	await browser.close();
}
