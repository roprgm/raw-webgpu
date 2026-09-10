import shader from "./upload.wgsl";

export type TiffPixels = {
	/** Interleaved samples, one row after another, exactly as the file or the SDK laid them out. */
	data: Uint8Array;
	/**
	 * Eleven values from native/tiff.cpp: width, height, channels, bytes per sample,
	 * bits per sample (zero for float), orientation, photometric interpretation,
	 * extra-sample kind (1 for associated alpha), row bytes, compression, predictor.
	 */
	metadata: Uint32Array;
	/** Whether the samples still carry the file's big-endian byte order. */
	bigEndian: boolean;
	color: { table: Float32Array; matrix: number[] };
};

const pipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline>>();

function createFilledBuffer(
	device: GPUDevice,
	data: ArrayBufferView,
	usage: GPUBufferUsageFlags,
) {
	const result = device.createBuffer({
		size: Math.ceil(data.byteLength / 4) * 4,
		usage,
		mappedAtCreation: true,
	});
	try {
		new Uint8Array(result.getMappedRange()).set(
			new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		);
		result.unmap();
		return result;
	} catch (error) {
		result.destroy();
		throw error;
	}
}

/** Matches the WGSL Params struct: the nine metadata words, band placement, then the padded matrix. */
function createParams(pixels: TiffPixels, startRow: number, rows: number) {
	const params = new ArrayBuffer(96);
	const integers = new Uint32Array(params);
	integers.set(pixels.metadata.subarray(0, 9));
	integers[9] = startRow;
	integers[10] = rows;
	integers[11] = Number(pixels.bigEndian);
	const floats = new Float32Array(params);
	for (let column = 0; column < 3; column++) {
		floats.set(
			pixels.color.matrix.slice(column * 3, column * 3 + 3),
			12 + column * 4,
		);
	}
	return new Uint8Array(params);
}

export async function uploadTiff(
	device: GPUDevice,
	pixels: TiffPixels,
	signal?: AbortSignal,
) {
	const workgroupRows = Math.min(
		16,
		Math.floor(device.limits.maxComputeInvocationsPerWorkgroup / 16),
	);
	let pending = pipelines.get(device);
	if (!pending) {
		pending = device
			.createComputePipelineAsync({
				layout: "auto",
				compute: {
					module: device.createShaderModule({ code: shader }),
					entryPoint: "main",
					constants: { workgroupRows },
				},
			})
			.catch((error) => {
				pipelines.delete(device);
				throw error;
			});
		pipelines.set(device, pending);
	}
	const pipeline = await pending;
	signal?.throwIfAborted();

	const { data, metadata, color } = pixels;
	const [width, height, , , , orientation, , , rowBytes] = metadata;
	const size: [number, number] =
		orientation >= 5 ? [height, width] : [width, height];
	if (size.some((value) => value > device.limits.maxTextureDimension2D)) {
		throw Error("TIFF exceeds the device texture size limit.");
	}
	// Large images are converted in bands, each sized to fit one storage buffer.
	const rowsPerBand = Math.floor(
		Math.min(
			device.limits.maxStorageBufferBindingSize,
			device.limits.maxBufferSize,
		) / rowBytes,
	);
	if (!rowsPerBand) {
		throw Error("TIFF row exceeds the device buffer size limit.");
	}

	const texture = device.createTexture({
		size,
		format: "rgba16float",
		usage:
			GPUTextureUsage.STORAGE_BINDING |
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_SRC,
	});
	let curves: GPUBuffer | undefined;
	try {
		curves = createFilledBuffer(device, color.table, GPUBufferUsage.STORAGE);
		for (let y = 0; y < height; y += rowsPerBand) {
			const rows = Math.min(rowsPerBand, height - y);
			const source = createFilledBuffer(
				device,
				data.subarray(y * rowBytes, (y + rows) * rowBytes),
				GPUBufferUsage.STORAGE,
			);
			let params: GPUBuffer | undefined;
			try {
				params = createFilledBuffer(
					device,
					createParams(pixels, y, rows),
					GPUBufferUsage.UNIFORM,
				);
				const bindings = device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: { buffer: source } },
						{ binding: 1, resource: { buffer: curves } },
						{ binding: 2, resource: { buffer: params } },
						{ binding: 3, resource: texture.createView() },
					],
				});
				const encoder = device.createCommandEncoder();
				const pass = encoder.beginComputePass();
				pass.setPipeline(pipeline);
				pass.setBindGroup(0, bindings);
				pass.dispatchWorkgroups(
					Math.ceil(width / 16),
					Math.ceil(rows / workgroupRows),
				);
				pass.end();
				device.queue.submit([encoder.finish()]);
			} finally {
				// Submitted work keeps its own references; the band buffers can go right away.
				source.destroy();
				params?.destroy();
			}
		}
		return { texture, size, dispose: () => texture.destroy() };
	} catch (error) {
		texture.destroy();
		throw error;
	} finally {
		curves?.destroy();
	}
}
