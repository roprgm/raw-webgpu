import type { DevelopOptions, RawPixels } from "../types";
import shader from "./develop.wgsl";

export function createPipeline(device: GPUDevice) {
	const module = device.createShaderModule({ code: shader });
	return device.createRenderPipelineAsync({
		layout: "auto",
		vertex: { module, entryPoint: "vs_main" },
		fragment: {
			module,
			entryPoint: "fs_main",
			targets: [{ format: "rgba16float" }],
		},
		primitive: { topology: "triangle-list" },
	});
}

function uniform(device: GPUDevice, data: ArrayBuffer) {
	const buffer = device.createBuffer({
		size: data.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(buffer, 0, data);
	return buffer;
}

/** Owns the sensor texture and immutable uniforms; each pass owns its calibration buffer. */
export function createGpuSource(
	device: GPUDevice,
	pixels: RawPixels,
	pipeline: GPURenderPipeline,
) {
	const { data, ...metadata } = pixels;
	const size: [number, number] =
		metadata.flip & 4 ? [metadata.size[1], metadata.size[0]] : metadata.size;
	const texture = device.createTexture({
		size: metadata.size,
		format: metadata.cfa ? "r16uint" : "rgba16uint",
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.COPY_SRC,
	});
	const buffers: GPUBuffer[] = [];
	const passes = new Set<() => void>();
	let closed = false;
	function dispose() {
		if (closed) {
			return;
		}
		closed = true;
		for (const close of passes) {
			close();
		}
		for (const buffer of buffers) {
			buffer.destroy();
		}
		texture.destroy();
	}
	try {
		device.queue.writeTexture(
			{ texture },
			data,
			{ bytesPerRow: metadata.size[0] * (metadata.cfa ? 2 : 8) },
			metadata.size,
		);
		const sensor = new ArrayBuffer(48);
		const floats = new Float32Array(sensor),
			integers = new Uint32Array(sensor);
		floats.set(metadata.black);
		integers.set(metadata.cfa ?? [0, 0, 0, 0], 4);
		floats[8] = metadata.white;
		integers[9] = metadata.flip;
		integers[10] = Number(metadata.cfa !== null);
		buffers.push(uniform(device, sensor));
		const vignette = new Float32Array(12);
		vignette.set(metadata.vignette.slice(0, 4));
		vignette.set(metadata.vignette.slice(5, 9), 4);
		vignette[8] = metadata.vignette[4];
		buffers.push(uniform(device, vignette.buffer));
		return {
			texture,
			metadata,
			size,
			createDevelopPass() {
				if (closed) {
					throw Error("RAW source is closed.");
				}
				const values = new Float32Array(16);
				const calibration = uniform(device, values.buffer);
				const group = device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: texture.createView() },
						{ binding: 1, resource: { buffer: buffers[0] } },
						{ binding: 2, resource: { buffer: calibration } },
						{ binding: 3, resource: { buffer: buffers[1] } },
					],
				});
				let disposed = false;
				function close() {
					disposed = true;
					calibration.destroy();
					passes.delete(close);
				}
				passes.add(close);
				return {
					render(options: DevelopOptions) {
						if (disposed || closed) {
							throw Error("RAW development pass is closed.");
						}
						const { destination, calibration: color, exposure = 0 } = options;
						if (
							destination.format !== "rgba16float" ||
							destination.width !== size[0] ||
							destination.height !== size[1]
						) {
							throw Error(
								"RAW destination must be an rgba16float texture matching the oriented source size.",
							);
						}
						values.set(color.gains);
						values[3] = 2 ** exposure;
						for (let c = 0; c < 3; c++) {
							values.set(color.matrix.slice(c * 3, c * 3 + 3), 4 + c * 4);
						}
						device.queue.writeBuffer(calibration, 0, values);
						const encoder = options.encoder ?? device.createCommandEncoder();
						const pass = encoder.beginRenderPass({
							colorAttachments: [
								{
									view: destination.createView(),
									loadOp: "clear",
									storeOp: "store",
								},
							],
						});
						pass.setPipeline(pipeline);
						pass.setBindGroup(0, group);
						pass.draw(3);
						pass.end();
						if (!options.encoder) {
							device.queue.submit([encoder.finish()]);
						}
					},
					dispose: close,
				};
			},
			dispose,
		};
	} catch (error) {
		dispose();
		throw error;
	}
}
