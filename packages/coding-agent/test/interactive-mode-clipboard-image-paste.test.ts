import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
}));

vi.mock("../src/utils/clipboard-image.js", () => ({
	readClipboardImage: mocks.readClipboardImage,
	extensionForImageMimeType: (mimeType: string) => {
		switch (mimeType) {
			case "image/png":
				return "png";
			case "image/jpeg":
				return "jpg";
			default:
				return null;
		}
	},
}));

type ClipboardPasteThis = {
	settingsManager: { getImageStoragePath: () => string };
	editor: { insertTextAtCursor?: (text: string) => void };
	ui: { requestRender: () => void };
	showWarning: (message: string) => void;
};

type InteractiveModePrototypeWithClipboardPaste = {
	handleClipboardImagePaste(this: ClipboardPasteThis): Promise<void>;
};

function callHandleClipboardImagePaste(context: ClipboardPasteThis): Promise<void> {
	const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeWithClipboardPaste;
	return prototype.handleClipboardImagePaste.call(context);
}

function createContext(storageDir: string): ClipboardPasteThis {
	return {
		settingsManager: { getImageStoragePath: vi.fn(() => storageDir) },
		editor: { insertTextAtCursor: vi.fn() },
		ui: { requestRender: vi.fn() },
		showWarning: vi.fn(),
	};
}

describe("InteractiveMode.handleClipboardImagePaste", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-clipboard-paste-"));
		mocks.readClipboardImage.mockReset();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("writes clipboard images to the configured storage directory and inserts the path", async () => {
		const context = createContext(testDir);
		mocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });

		await callHandleClipboardImagePaste(context);

		const files = readdirSync(testDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^pi-clipboard-.+\.png$/);
		const filePath = join(testDir, files[0]);
		expect(Array.from(readFileSync(filePath))).toEqual([1, 2, 3]);
		expect(context.editor.insertTextAtCursor).toHaveBeenCalledWith(filePath);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	test("warns instead of creating a missing configured storage directory", async () => {
		const missingDir = join(testDir, "missing");
		const context = createContext(missingDir);
		mocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });

		await callHandleClipboardImagePaste(context);

		expect(existsSync(missingDir)).toBe(false);
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith(
			`Clipboard image storage directory does not exist: ${missingDir}`,
		);
	});

	test("warns when the configured storage path is not a directory", async () => {
		const filePath = join(testDir, "not-a-directory");
		writeFileSync(filePath, "");
		const context = createContext(filePath);
		mocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });

		await callHandleClipboardImagePaste(context);

		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith(`Clipboard image storage path is not a directory: ${filePath}`);
	});

	test("silently ignores clipboard read errors", async () => {
		const context = createContext(testDir);
		mocks.readClipboardImage.mockRejectedValue(new Error("clipboard denied"));

		await callHandleClipboardImagePaste(context);

		expect(readdirSync(testDir)).toEqual([]);
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(context.showWarning).not.toHaveBeenCalled();
	});
});
