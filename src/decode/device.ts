const signals = new WeakMap<GPUDevice, AbortSignal>();

/** One device-lost subscription; individual loads remove their abort listeners. */
export function deviceSignal(device: GPUDevice) {
	let signal = signals.get(device);
	if (!signal) {
		const controller = new AbortController();
		void device.lost.then(() =>
			controller.abort(Error("WebGPU device was lost.")),
		);
		signal = controller.signal;
		signals.set(device, signal);
	}
	return signal;
}
