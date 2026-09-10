import type { RawReply, WhiteBalance } from "../types";

/** Each source retains one native calibration session in its own worker. */
export function createSession(compiled: Promise<WebAssembly.Module>) {
	const worker = new Worker(new URL("./worker.js", import.meta.url), {
		type: "module",
	});
	const pending = new Map<number, PromiseWithResolvers<RawReply>>();
	let sequence = 0;
	let failure: Error | undefined;

	/** Once the worker fails or closes, every pending and future request rejects. */
	function dispose(error = Error("RAW source is closed.")) {
		failure = error;
		worker.terminate();
		for (const request of pending.values()) {
			request.reject(error);
		}
		pending.clear();
	}

	// The module arrives before any request; message order is guaranteed.
	compiled.then(
		(module) => {
			if (!failure) {
				worker.postMessage({ module });
			}
		},
		(error) => dispose(error instanceof Error ? error : Error(String(error))),
	);

	worker.onmessage = ({
		data,
	}: MessageEvent<{ id: number } & (RawReply | { error: string })>) => {
		const request = pending.get(data.id);
		pending.delete(data.id);
		if ("error" in data) {
			request?.reject(Error(data.error));
		} else {
			request?.resolve(data);
		}
	};
	worker.onerror = (event) => {
		event.preventDefault();
		dispose(Error(event.message || "RAW decoding worker failed."));
	};
	worker.onmessageerror = () =>
		dispose(Error("Could not read the RAW worker response."));

	return {
		/** A Blob opens a file; a white balance recalibrates the file already open. */
		request(value: Blob | WhiteBalance) {
			if (failure) {
				return Promise.reject(failure);
			}
			const id = ++sequence;
			const result = Promise.withResolvers<RawReply>();
			pending.set(id, result);
			try {
				worker.postMessage({ id, value });
			} catch (error) {
				pending.delete(id);
				result.reject(error);
			}
			return result.promise;
		},
		dispose,
	};
}
