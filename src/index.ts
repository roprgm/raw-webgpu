import { deviceSignal } from "./decode/device";
import { compileDecoder } from "./decode/module";
import { createSession } from "./decode/session";
import { createGpuSource, createPipeline } from "./develop/gpu";
import type { LoadOptions } from "./types";

export type {
	Calibration,
	DevelopOptions,
	DevelopPassOptions,
	LoadOptions,
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
		lost.removeEventListener("abort", dispose);
		for (const close of sources) {
			close();
		}
	}
	const lost = deviceSignal(device);
	lost.addEventListener("abort", dispose, { once: true });

	return {
		async load(file: Blob, { signal }: LoadOptions = {}) {
			if (closed || lost.aborted) {
				throw Error("RAW decoder is closed.");
			}
			if (signal?.aborted) {
				throw signal.reason;
			}
			const session = createSession(compileDecoder());
			let gpuSource: ReturnType<typeof createGpuSource> | undefined;
			let disposed = false;

			function close() {
				disposed = true;
				signal?.removeEventListener("abort", close);
				gpuSource?.dispose();
				session.dispose();
				sources.delete(close);
			}
			// Registering before decoding lets the decoder or the signal cancel a load still in flight.
			sources.add(close);
			signal?.addEventListener("abort", close);

			try {
				// A failed pipeline is not cached, so a later load can try again.
				pipeline ??= createPipeline(device).catch((error) => {
					pipeline = undefined;
					throw error;
				});
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
				gpuSource = createGpuSource(device, reply.image, gpuPipeline);
				// The signal covers loading only; from here the consumer disposes the source.
				signal?.removeEventListener("abort", close);

				return {
					...gpuSource,
					asShot: reply.asShot,
					calibration: reply.calibration,
					/** Gains and matrix for another white point; omit the argument to restore as-shot. */
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
				throw signal?.aborted ? signal.reason : error;
			}
		},
		dispose,
	};
}

export type RawDecoder = ReturnType<typeof createRawDecoder>;
export type RawSource = Awaited<ReturnType<RawDecoder["load"]>>;

export { decodeTiff } from "./tiff";
