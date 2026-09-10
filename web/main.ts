// biome-ignore-all lint/style/noNonNullAssertion: This example assumes WebGPU and the accompanying HTML.
import { createRawDecoder } from "raw-webgpu";
import "./style.css";

const canvas = document.querySelector("canvas")!;
const input = document.querySelector("input")!;
const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
const context = canvas.getContext("webgpu")!;
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format, alphaMode: "opaque" });
const decoder = createRawDecoder(device);

async function load(file?: File) {
	if (!file || input.disabled) return;
	input.disabled = true;
	try {
		const source = await decoder.load(file);
		try {
			canvas.width = source.size[0];
			canvas.height = source.size[1];
			source.createDevelopPass({ outputColorSpace: "srgb", format }).render({
				destination: context.getCurrentTexture(),
				calibration: source.calibration,
			});
		} finally {
			source.dispose();
		}
	} finally {
		input.disabled = false;
	}
}

input.disabled = false;
input.onchange = () => {
	load(input.files?.[0]);
	input.value = "";
};
window.ondragover = (event) => event.preventDefault();
window.ondrop = (event) => {
	event.preventDefault();
	load(event.dataTransfer?.files[0]);
};
