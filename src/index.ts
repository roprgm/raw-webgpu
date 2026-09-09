/// <reference types="@webgpu/types" preserve="true" />

import { createSession } from "./decode/session";
import { createGpuSource, createPipeline } from "./develop/gpu";

export type {
	Calibration,
	DevelopOptions,
	RawMetadata,
	WhiteBalance,
} from "./types";

/** Reuses a pipeline on the consumer's device. Each load owns an independent worker and source. */
export function createRawDecoder(device: GPUDevice) {
	let pipeline: ReturnType<typeof createPipeline> | undefined;
	const sources = new Set<() => void>();
	let closed = false;
	function dispose() {
		closed = true;
		for (const close of sources) {
			close();
		}
	}
	void device.lost.then(dispose);
	return {
		async load(file: Blob) {
			if (closed) {
				throw Error("RAW decoder is closed.");
			}
			const session = createSession();
			let upload: ReturnType<typeof createGpuSource> | undefined;
			let disposed = false;
			function close() {
				disposed = true;
				upload?.dispose();
				session.dispose();
				sources.delete(close);
			}
			sources.add(close);
			try {
				pipeline ??= createPipeline(device);
				const [reply, gpuPipeline] = await Promise.all([
					session.request(file),
					pipeline,
				]);
				if (disposed) {
					throw Error("RAW source is closed.");
				}
				if (!reply.image) {
					throw Error("RAW decoder returned no sensor samples.");
				}
				if (
					reply.image.size.some(
						(value) => value > device.limits.maxTextureDimension2D,
					)
				) {
					throw Error("RAW image exceeds this device's texture size limit.");
				}
				upload = createGpuSource(device, reply.image, gpuPipeline);
				return {
					...upload,
					asShot: reply.asShot,
					calibration: reply.calibration,
					async calibrate(balance = reply.asShot) {
						if (disposed) {
							throw Error("RAW source is closed.");
						}
						if (
							!Number.isFinite(balance.temperature) ||
							balance.temperature <= 0 ||
							!Number.isFinite(balance.tint)
						) {
							throw Error(
								"White balance needs a positive temperature and a finite tint.",
							);
						}
						return (await session.request(balance)).calibration;
					},
					dispose: close,
				};
			} catch (error) {
				close();
				throw error;
			}
		},
		dispose,
	};
}

export type RawDecoder = ReturnType<typeof createRawDecoder>;
export type RawSource = Awaited<ReturnType<RawDecoder["load"]>>;
