import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { Value } from "typebox/value";
import extension from "../extensions/computer-use.ts";
import { executeAct, executeFind, executeObserve, executeSearchUi, shutdownComputerUseSession } from "../src/bridge.ts";
import { CdpTab } from "../src/cdp.ts";
import { resolveObservationOutputPath, saveObservationImage } from "../src/observation-image.ts";
import { parseLookResponse } from "../src/outline.ts";
import { applyOutputEnvelope, clearStoredOutputs } from "../src/output.ts";
import { currentPlatformBackend } from "../src/platform/index.ts";

const directory = await mkdtemp(path.join(os.tmpdir(), "pi-cu-image-test-"));
const ctx = { cwd: directory, hasUI: false };
const originalBackend = { ...currentPlatformBackend };
const originalFetch = globalThis.fetch;
const originalConnect = CdpTab.connect;
const originalBrowserUse = process.env.PI_COMPUTER_USE_BROWSER_USE;
const originalCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
const png = new PNG({ width: 4, height: 3 });
for (let i = 0; i < png.data.length; i += 4) png.data.set([80, 130, 210, 255], i);
const pngBytes = PNG.sync.write(png);
const jpegBytes = jpeg.encode(png, 80).data;
const imageFor = (bytes, mimeType) => ({ jpegBase64: bytes.toString("base64"), mimeType, width: 4, height: 3 });
const pngImage = imageFor(pngBytes, "image/png");
const jpegImage = imageFor(jpegBytes, "image/jpeg");
const params = (outputPath) => ({ mode: "visual", outputPath });
const invoke = (tool, args, context = ctx, signal) => tool("test", args, signal, undefined, context);
const textOf = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const imageCount = (result) => result.content.filter((part) => part.type === "image").length;
const absent = async (file) => assert.rejects(readFile(file), { code: "ENOENT" });

try {
	// Actual registered schema, not just a source-string assertion.
	const tools = [];
	extension({ registerTool: (tool) => tools.push(tool), registerCommand() {}, on() {} });
	const schema = tools.find((tool) => tool.name === "observe_ui").parameters;
	assert(Value.Check(schema, params("capture.png")));
	assert(Value.Check(schema, {}));
	assert(!Value.Check(schema, params("")));
	assert(!Value.Check(schema, params(1)));

	assert.notEqual(directory, process.cwd());
	assert.equal(resolveObservationOutputPath(params("@nested/画面 image.png"), directory), path.join(directory, "nested/画面 image.png"));
	assert.equal(resolveObservationOutputPath(params(path.join(directory, "absolute.png")), "/unused"), path.join(directory, "absolute.png"));
	assert.equal(resolveObservationOutputPath({}, directory), undefined);
	for (const mode of [undefined, "semantic", "fused"]) assert.throws(() => resolveObservationOutputPath({ mode, outputPath: "x" }, directory), /explicit mode/);
	for (const outputPath of ["", " ", "@", "\0", 42, null]) assert.throws(() => resolveObservationOutputPath(params(outputPath), directory), /file path/);

	const savedPath = resolveObservationOutputPath(params("nested/画面 image.png"), directory);
	await saveObservationImage(jpegImage, savedPath);
	const decoded = PNG.sync.read(await readFile(savedPath));
	assert.equal(decoded.width, 4);
	assert.equal(decoded.height, 3);
	assert.deepEqual(decoded.data, jpeg.decode(jpegBytes, { tolerantDecoding: false }).data);
	await saveObservationImage(pngImage, savedPath);
	assert.deepEqual(await readFile(savedPath), pngBytes, "existing PNG should be validated and preserved byte-for-byte");
	assert.deepEqual(pngImage, imageFor(pngBytes, "image/png"), "writer mutated the source image");
	await saveObservationImage({ ...jpegImage, mimeType: undefined }, savedPath);
	assert.deepEqual(PNG.sync.read(await readFile(savedPath)).data, decoded.data, "legacy JPEG MIME default changed");

	// Conversion must fail before truncating an existing destination.
	const original = await readFile(savedPath);
	const badPng = Buffer.from(pngBytes);
	badPng[29] ^= 1; // IHDR CRC
	const hugePng = Buffer.from(pngBytes);
	hugePng.writeUInt32BE(0xffffffff, 16);
	const interlaced = Buffer.from(pngBytes);
	interlaced[28] = 1;
	for (const image of [undefined, { ...pngImage, jpegBase64: "!" }, { ...pngImage, jpegBase64: "" }, imageFor(Buffer.from("invalid"), "image/jpeg"), imageFor(badPng, "image/png"), imageFor(hugePng, "image/png"), imageFor(interlaced, "image/png"), { ...pngImage, width: 5 }, { ...pngImage, width: 0 }, { ...pngImage, width: 16_000_001 }]) {
		await assert.rejects(saveObservationImage(image, savedPath), /Cannot save observation PNG/);
		assert.deepEqual(await readFile(savedPath), original);
	}
	await assert.rejects(saveObservationImage(pngImage, directory), /EISDIR|EPERM/);
	await writeFile(path.join(directory, "parent-file"), "not a directory");
	await assert.rejects(saveObservationImage(pngImage, path.join(directory, "parent-file", "capture.png")), /ENOTDIR|EEXIST/);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(saveObservationImage(pngImage, path.join(directory, "cancelled", "image.png"), abort.signal), /abort/i);
	await absent(path.join(directory, "cancelled", "image.png"));

	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		const locked = path.join(directory, "locked");
		await mkdir(locked, { mode: 0o500 });
		try {
			await assert.rejects(saveObservationImage(pngImage, path.join(locked, "image.png")), /EACCES|EPERM/);
		} finally {
			await chmod(locked, 0o700);
		}
	} else {
		console.log("SKIP POSIX permission-denied fixture (Windows or root)");
	}

	// A held Pi mutation blocks this writer, including cancellation while queued.
	let release;
	let entered;
	const enteredPromise = new Promise((resolve) => { entered = resolve; });
	const barrier = new Promise((resolve) => { release = resolve; });
	const held = withFileMutationQueue(savedPath, async () => { entered(); await barrier; });
	await enteredPromise;
	const queuedAbort = new AbortController();
	const pending = assert.rejects(saveObservationImage(pngImage, savedPath, queuedAbort.signal), /abort/i);
	await saveObservationImage(pngImage, path.join(directory, "parallel.png"));
	assert.deepEqual(await readFile(savedPath), original, "writer bypassed Pi's file mutation queue");
	queuedAbort.abort();
	release();
	await Promise.all([held, pending]);
	assert.deepEqual(await readFile(savedPath), original);
	await Promise.all(Array.from({ length: 12 }, (_, i) => saveObservationImage(i % 2 ? pngImage : jpegImage, savedPath)));
	assert.equal(PNG.sync.read(await readFile(savedPath)).width, 4);
	if (process.platform !== "win32") {
		const alias = path.join(directory, "alias.png");
		await symlink(savedPath, alias);
		await Promise.all([saveObservationImage(pngImage, savedPath), saveObservationImage(jpegImage, alias)]);
		assert.equal(PNG.sync.read(await readFile(savedPath)).height, 3);
	}

	// Public executor integration: only the OS boundary is stubbed.
	let captureImage = jpegImage;
	let lookNumber = 0;
	let readyChecks = 0;
	let denseOutline = false;
	let lastRequest;
	let lastAction;
	const root = { kind: "window", windowRef: "native:1", windowId: 1, pid: 123, appName: "Fixture", title: "Settings", framePoints: { x: 0, y: 0, w: 4, h: 3 }, scaleFactor: 1, zOrder: 0, isFocused: true, isMain: true, isOnscreen: true, isMinimized: false, isModal: false };
	Object.assign(currentPlatformBackend, {
		ensureReady: async (_ctx, state) => { readyChecks++; return state; },
		listApps: async () => [{ appName: "Fixture", pid: 123 }],
		listRoots: async () => [root],
		getFrontmost: async () => ({ appName: "Fixture", pid: 123, windowId: 1 }),
		isBrowserApp: () => false,
		isChromeFamilyApp: () => false,
		act: async (request) => { lastAction = request; return { outcome: "worked", performed: { delivery: "hid" } }; },
		actBatch: undefined,
		shutdown: async () => {},
		observe: async (request) => {
			lastRequest = request;
			return parseLookResponse({
				lookId: `look-${++lookNumber}`, capturedAt: Date.now() / 1000,
				window: { windowId: 1, framePoints: root.framePoints, scaleFactor: 1, isModal: false },
				image: request.includeImage ? captureImage : undefined,
				outline: { ref: "window", role: "AXWindow", title: "Settings", children: [
					{ ref: "save", role: "AXButton", title: "Save", canPress: true, rect: { x: 0, y: 0, w: 2, h: 2 } },
					...(denseOutline ? [{ ref: "cancel", role: "AXButton", title: "Cancel" }, { ref: "close", role: "AXButton", title: "Close" }] : []),
				] },
				readText: { requested: request.readText, executed: request.readText === "always" }, timings: {},
			});
		},
	});
	process.env.PI_COMPUTER_USE_BROWSER_USE = "false";
	const found = await invoke(executeFind, {});
	const rootRef = found.details.windows[0].windowRef;
	const saved = await invoke(executeObserve, { root: rootRef, ...params("executor/result.png") });
	assert.equal(saved.details.outputPath, path.join(directory, "executor/result.png"));
	assert.equal(imageCount(saved), 0);
	assert(textOf(saved).startsWith("Saved PNG to "));
	assert(!textOf(saved).includes("attached for"));
	assert(saved.details.capture.stateId);
	assert(saved.details.outline);
	assert.equal(saved.details.capture.width, 4);
	assert.equal(lastRequest.maxDimension, 1600);
	assert.equal(lastRequest.readText, "always");
	assert.equal(lastRequest.includeImage, true);
	assert(!JSON.stringify(saved).includes(jpegImage.jpegBase64));
	assert.equal(PNG.sync.read(await readFile(saved.details.outputPath)).height, 3);
	const query = await invoke(executeSearchUi, { stateId: saved.details.capture.stateId, text: "Save" });
	assert(query.details.matches.length > 0);
	const acted = await invoke(executeAct, { stateId: saved.details.capture.stateId, actions: [{ action: "moveMouse", x: 1, y: 1 }] });
	assert.equal(lastAction.action, "moveMouse", "saved state's internal image was lost before coordinate action");
	assert.equal(imageCount(acted), 1, "save policy leaked into a successor tool");
	assert.equal(acted.details.outputPath, undefined);

	const truncated = applyOutputEnvelope("observe_ui", { ...saved, content: [{ type: "text", text: textOf(saved) + "\n" + "x".repeat(60_000) }] });
	assert(textOf(truncated).startsWith("Saved PNG to "));
	assert(textOf(truncated).includes("output truncated"));
	assert.equal(imageCount(truncated), 0);
	assert.equal(truncated.details.outputPath, saved.details.outputPath);
	clearStoredOutputs();
	assert.equal(PNG.sync.read(await readFile(saved.details.outputPath)).width, 4);

	for (const mode of ["semantic", "fused", "visual", undefined]) {
		const result = await invoke(executeObserve, { mode });
		assert.equal(result.details.outputPath, undefined);
		assert.equal(imageCount(result), mode === "semantic" ? 0 : 1);
	}
	denseOutline = true;
	assert.equal(imageCount(await invoke(executeObserve, { mode: "fused" })), 0, "dense fused observation should still omit its image");
	assert.equal(imageCount(await invoke(executeObserve, { mode: "visual" })), 1);
	denseOutline = false;
	const noExtension = await invoke(executeObserve, params("exact-destination"));
	assert.equal(noExtension.details.outputPath, path.join(directory, "exact-destination"));
	assert.equal(PNG.sync.read(await readFile(noExtension.details.outputPath)).width, 4);
	const countBeforeInvalid = lookNumber;
	const readyBeforeInvalid = readyChecks;
	for (const mode of [undefined, "fused", "semantic"]) await assert.rejects(invoke(executeObserve, { mode, outputPath: "invalid.png" }), /explicit mode/);
	await assert.rejects(invoke(executeObserve, params("")), /file path/);
	assert.equal(lookNumber, countBeforeInvalid, "invalid arguments caused a capture");
	assert.equal(readyChecks, readyBeforeInvalid, "invalid arguments triggered readiness or permission probes");
	await absent(path.join(directory, "invalid.png"));
	captureImage = undefined;
	await assert.rejects(invoke(executeObserve, params("missing.png")), /did not provide an image/);
	captureImage = { ...pngImage, jpegBase64: "bad" };
	await assert.rejects(invoke(executeObserve, params("corrupt.png")), /invalid base64/);
	captureImage = pngImage;
	await assert.rejects(invoke(executeObserve, params(directory)), /EISDIR|EPERM/);
	await assert.rejects(invoke(executeObserve, params("aborted.png"), ctx, abort.signal), /abort/i);
	for (const name of ["missing.png", "corrupt.png", "aborted.png"]) await absent(path.join(directory, name));

	const [a, b] = await Promise.all([
		invoke(executeObserve, params("same.png"), { ...ctx, cwd: path.join(directory, "a") }),
		invoke(executeObserve, params("same.png"), { ...ctx, cwd: path.join(directory, "b") }),
	]);
	assert.notEqual(a.details.outputPath, b.details.outputPath);
	for (const result of [a, b]) assert.deepEqual(await readFile(result.details.outputPath), pngBytes);

	// Managed-browser observation still works without a path; saving is rejected
	// before connecting to CDP, rather than silently producing a text-only success.
	process.env.PI_COMPUTER_USE_BROWSER_USE = "true";
	process.env.PI_COMPUTER_USE_CDP_PORT = "12345";
	globalThis.fetch = async () => new Response(JSON.stringify([{ id: "fixture", type: "page", title: "Browser fixture", url: "https://example.test", webSocketDebuggerUrl: "ws://127.0.0.1:12345/devtools/page/fixture" }]));
	let connections = 0;
	CdpTab.connect = async () => {
		connections++;
		return { evaluate: async () => "Browser fixture", accessibilityTree: async () => [], close() {} };
	};
	const browserRoots = await invoke(executeFind, { kind: "browser_page" });
	const browserRef = browserRoots.details.windows[0].windowRef;
	await assert.rejects(invoke(executeObserve, { root: browserRef, ...params("browser.png") }), /not supported for browser_page/);
	assert.equal(connections, 0);
	const browser = await invoke(executeObserve, { root: browserRef, mode: "visual" });
	assert.equal(browser.details.kind, "browser_page");
	assert.equal(imageCount(browser), 0);
	assert.equal(browser.details.outputPath, undefined);
	assert.equal(connections, 1);
	await absent(path.join(directory, "browser.png"));
	await shutdownComputerUseSession();
	assert.equal(PNG.sync.read(await readFile(saved.details.outputPath)).height, 3, "session cleanup deleted caller-selected output");
	console.log("PASS observation PNG writer, public schema/executors, errors, queues, state, compatibility, and cleanup");
} finally {
	await shutdownComputerUseSession();
	Object.assign(currentPlatformBackend, originalBackend);
	globalThis.fetch = originalFetch;
	CdpTab.connect = originalConnect;
	if (originalBrowserUse === undefined) delete process.env.PI_COMPUTER_USE_BROWSER_USE;
	else process.env.PI_COMPUTER_USE_BROWSER_USE = originalBrowserUse;
	if (originalCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
	else process.env.PI_COMPUTER_USE_CDP_PORT = originalCdpPort;
	await rm(directory, { recursive: true, force: true });
}
