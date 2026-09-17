import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { ObserveParams } from "./contract.ts";
import type { LookImage } from "./outline.ts";

// Well above the current 1600px visual capture limit, but bound codec allocation.
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function resolveObservationOutputPath(params: ObserveParams, cwd: string): string | undefined {
	if (params.outputPath === undefined) return undefined;
	if (params.mode !== "visual") throw new Error('observe_ui.outputPath requires explicit mode: "visual".');
	if (typeof params.outputPath !== "string") throw new Error("observe_ui.outputPath must be a non-empty file path.");
	const destination = params.outputPath.replace(/^@/, "");
	if (!destination.trim() || destination.includes("\0")) throw new Error("observe_ui.outputPath must be a non-empty file path without null bytes.");
	return path.resolve(cwd, destination);
}

function checkDimensions(width: number, height: number): void {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
		throw new Error("Observation image dimensions are invalid or exceed the 16 megapixel limit.");
	}
}

function observationPng(image: LookImage | undefined): Buffer {
	if (!image?.jpegBase64) throw new Error("The observed root did not provide an image to save.");
	checkDimensions(image.width, image.height);
	if (image.jpegBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Observation image exceeds the 32 MiB encoded-image limit.");
	const bytes = Buffer.from(image.jpegBase64, "base64");
	if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== image.jpegBase64) throw new Error("Observation image contains invalid base64 data.");
	let decoded: { width: number; height: number; data: Buffer };
	if (image.mimeType === "image/png") {
		if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
			throw new Error("Observation image is not a valid PNG.");
		}
		checkDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
		// Native screenshots are non-interlaced. pngjs's interlaced sync decoder
		// inflates without an output bound, so do not feed it interlaced payloads.
		if (bytes[28] !== 0) throw new Error("Interlaced observation PNGs are not supported.");
		decoded = PNG.sync.read(bytes, { checkCRC: true });
	} else {
		decoded = jpeg.decode(bytes, { tolerantDecoding: false, maxResolutionInMP: 16, maxMemoryUsageInMB: 256 });
	}
	if (decoded.width !== image.width || decoded.height !== image.height) throw new Error("Observation image dimensions do not match the captured state.");
	if (image.mimeType === "image/png") return bytes;
	const png = new PNG({ width: decoded.width, height: decoded.height });
	png.data = decoded.data;
	return PNG.sync.write(png);
}

/** Save only; never alter the look's image or expose its bytes in tool output. */
export async function saveObservationImage(image: LookImage | undefined, outputPath: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	let png: Buffer;
	try {
		png = observationPng(image);
	} catch (error) {
		throw new Error(`Cannot save observation PNG: ${error instanceof Error ? error.message : String(error)}`);
	}
	await withFileMutationQueue(outputPath, async () => {
		signal?.throwIfAborted();
		await mkdir(path.dirname(outputPath), { recursive: true });
		signal?.throwIfAborted();
		await writeFile(outputPath, png, { signal });
	});
}
