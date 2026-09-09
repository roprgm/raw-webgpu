import type { DevelopOptions, RawMetadata, RawPixels } from "../types";
import shader from "./develop.wgsl";

export async function createPipeline(device: GPUDevice) {
	const module = device.createShaderModule({ code: shader });
	function create(entryPoint: string) {
		return device.createRenderPipelineAsync({
			layout: "auto",
			vertex: { module, entryPoint: "vs_main" },
			fragment: { module, entryPoint, targets: [{ format: "rgba16float" }] },
			primitive: { topology: "triangle-list" },
		});
	}
	const [sensor, camera] = await Promise.all([
		create("fs_main"),
		create("fs_camera"),
	]);
	return { sensor, camera };
}

function createUniform(device: GPUDevice, data: ArrayBuffer) {
	const buffer = device.createBuffer({
		size: data.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(buffer, 0, data);
	return buffer;
}

/** Matches the WGSL Sensor struct: black vec4f, pattern size vec4u, then white, flip, mosaic and floating. */
function createSensorUniform(device: GPUDevice, metadata: RawMetadata) {
	const data = new ArrayBuffer(48);
	const floats = new Float32Array(data);
	const integers = new Uint32Array(data);
	floats.set(metadata.black);
	integers[4] = metadata.cfaSize ?? 2;
	floats[8] = metadata.white;
	integers[9] = metadata.flip;
	integers[10] = Number(metadata.cfa !== null);
	integers[11] = Number(metadata.sampleFormat === "float32");
	return createUniform(device, data);
}

/** Matches the WGSL Vignette struct: four coefficients, origin, step, then the fifth coefficient. */
function createVignetteUniform(device: GPUDevice, metadata: RawMetadata) {
	const data = new Float32Array(12);
	data.set(metadata.vignette.slice(0, 4));
	data.set(metadata.vignette.slice(5, 9), 4);
	data[8] = metadata.vignette[4];
	return createUniform(device, data.buffer);
}

/** Owns the sensor texture and immutable uniforms; each pass owns its calibration buffer. */
export function createGpuSource(
	device: GPUDevice,
	pixels: RawPixels,
	pipeline: Awaited<ReturnType<typeof createPipeline>>,
) {
	const { data, ...metadata } = pixels;
	const mosaic = metadata.cfa !== null;
	// Transposing orientations swap the output dimensions.
	const size: [number, number] =
		metadata.flip & 4 ? [metadata.size[1], metadata.size[0]] : metadata.size;

	const floating = metadata.sampleFormat === "float32";
	const integerFormat = mosaic ? "r16uint" : "rgba16uint";
	const format: GPUTextureFormat = floating ? "rgba32uint" : integerFormat;
	const texture = device.createTexture({
		size: metadata.size,
		format,
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.COPY_SRC |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});
	const uniforms: GPUBuffer[] = [];
	const passes = new Set<() => void>();
	let cameraTexture: GPUTexture | undefined;
	let closed = false;

	function dispose() {
		if (closed) {
			return;
		}
		closed = true;
		for (const close of passes) {
			close();
		}
		for (const buffer of uniforms) {
			buffer.destroy();
		}
		texture.destroy();
		cameraTexture?.destroy();
	}

	function createPass(
		renderPipeline: GPURenderPipeline,
		entries: GPUBindGroupEntry[],
	) {
		if (closed) {
			throw Error("RAW source is closed.");
		}
		// Matches the WGSL Calibration struct: gains vec3f, exposure f32, then mat3x3f
		// with each column padded to four floats.
		const calibrationData = new Float32Array(16);
		const calibrationBuffer = createUniform(device, calibrationData.buffer);
		const group = device.createBindGroup({
			layout: renderPipeline.getBindGroupLayout(0),
			entries: [
				...entries,
				{ binding: 2, resource: { buffer: calibrationBuffer } },
			],
		});
		let disposed = false;

		function close() {
			disposed = true;
			calibrationBuffer.destroy();
			passes.delete(close);
		}
		passes.add(close);

		return {
			render(options: DevelopOptions) {
				if (disposed || closed) {
					throw Error("RAW development pass is closed.");
				}
				const { destination, calibration, exposure = 0 } = options;
				if (
					destination.format !== "rgba16float" ||
					destination.width !== size[0] ||
					destination.height !== size[1]
				) {
					throw Error(
						"RAW destination must be an rgba16float texture matching the oriented source size.",
					);
				}

				calibrationData.set(calibration.gains);
				calibrationData[3] = 2 ** exposure;
				for (let column = 0; column < 3; column++) {
					calibrationData.set(
						calibration.matrix.slice(column * 3, column * 3 + 3),
						4 + column * 4,
					);
				}
				device.queue.writeBuffer(calibrationBuffer, 0, calibrationData);

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
				pass.setPipeline(renderPipeline);
				pass.setBindGroup(0, group);
				pass.draw(3);
				pass.end();
				if (!options.encoder) {
					device.queue.submit([encoder.finish()]);
				}
			},
			dispose: close,
		};
	}

	try {
		if (data.byteLength > device.limits.maxBufferSize) {
			// Initialize on GPU: Dawn's lazy initialization can otherwise stage the entire texture.
			const encoder = device.createCommandEncoder();
			encoder
				.beginRenderPass({
					colorAttachments: [
						{ view: texture.createView(), loadOp: "clear", storeOp: "store" },
					],
				})
				.end();
			device.queue.submit([encoder.finish()]);
		}
		const bytesPerPixel = data.BYTES_PER_ELEMENT * (mosaic ? 1 : 4);
		const bytesPerRow = metadata.size[0] * bytesPerPixel;
		// writeTexture needs a staging buffer. Large float images can exceed the device limit.
		const rowsPerUpload = Math.floor(
			device.limits.maxBufferSize / (Math.ceil(bytesPerRow / 256) * 256),
		);
		for (let y = 0; y < metadata.size[1]; y += rowsPerUpload) {
			const height = Math.min(rowsPerUpload, metadata.size[1] - y);
			device.queue.writeTexture(
				{ texture, origin: [0, y] },
				data.buffer,
				{ offset: data.byteOffset + y * bytesPerRow, bytesPerRow },
				[metadata.size[0], height],
			);
		}
		const sensor = createSensorUniform(device, metadata);
		uniforms.push(sensor);
		const pattern = new Uint32Array(36);
		pattern.set(metadata.cfa ?? []);
		const patternBuffer = createUniform(device, pattern.buffer);
		uniforms.push(patternBuffer);
		const vignette = createVignetteUniform(device, metadata);
		uniforms.push(vignette);
		const sensorEntries: GPUBindGroupEntry[] = [
			{ binding: 0, resource: texture.createView() },
			{ binding: 1, resource: { buffer: sensor } },
			{ binding: 3, resource: { buffer: vignette } },
			{ binding: 4, resource: { buffer: patternBuffer } },
		];
		if (mosaic && (metadata.cfaSize ?? 2) > 2) {
			// This interpolation treats each color independently, so WB commutes with demosaic.
			// Cache camera RGB once; retain the original mosaic for sensor-level consumers.
			cameraTexture = device.createTexture({
				size,
				format: "rgba16float",
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
			const prepare = createPass(pipeline.sensor, sensorEntries);
			prepare.render({
				destination: cameraTexture,
				calibration: {
					gains: [1, 1, 1],
					matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
				},
			});
			prepare.dispose();
		}

		return {
			texture,
			metadata,
			size,
			createDevelopPass() {
				if (cameraTexture) {
					return createPass(pipeline.camera, [
						{ binding: 5, resource: cameraTexture.createView() },
					]);
				}
				return createPass(pipeline.sensor, sensorEntries);
			},
			dispose,
		};
	} catch (error) {
		dispose();
		throw error;
	}
}
