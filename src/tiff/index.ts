import { compileDecoder } from "../decode/module";
import type { LoadOptions } from "../types";
import { type TiffPixels, uploadTiff } from "./upload";

/** Decode TIFF into an owned linear Rec.2020 RGBA16F texture, with straight alpha. */
export async function decodeTiff(
	device: GPUDevice,
	file: Blob,
	{ signal }: LoadOptions = {},
) {
	if (signal?.aborted) {
		throw signal.reason;
	}
	const worker = new Worker(new URL("./tiff-worker.js", import.meta.url), {
		type: "module",
	});
	const aborted = Promise.withResolvers<never>();
	const abort = () => aborted.reject(signal?.reason);
	signal?.addEventListener("abort", abort);
	try {
		const module = await Promise.race([compileDecoder(), aborted.promise]);
		const decoded = new Promise<TiffPixels>((resolve, reject) => {
			worker.onmessage = ({ data }) => {
				if (data.error) {
					reject(Error(data.error));
				} else {
					resolve(data);
				}
			};
			worker.onerror = (event) => {
				event.preventDefault();
				reject(Error(event.message || "TIFF decoding worker failed."));
			};
			worker.onmessageerror = () =>
				reject(Error("Could not read TIFF worker response."));
			worker.postMessage({ file, module });
		});
		const pixels = await Promise.race([decoded, aborted.promise]);
		return await uploadTiff(device, pixels);
	} finally {
		signal?.removeEventListener("abort", abort);
		worker.terminate();
	}
}
