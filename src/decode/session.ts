import type { RawReply, WhiteBalance } from "../types";

/** Each source retains one native calibration session in its own worker. */
export function createSession() {
	const worker = new Worker(new URL("./worker.js", import.meta.url), {
		type: "module",
	});
	const pending = new Map<
		number,
		ReturnType<typeof Promise.withResolvers<RawReply>>
	>();
	let sequence = 0;
	let failure: Error | undefined;
	function dispose(error = Error("RAW source is closed.")) {
		failure = error;
		worker.terminate();
		for (const request of pending.values()) {
			request.reject(error);
		}
		pending.clear();
	}
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
