import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	TFile: class {},
	Vault: class {},
}));

const calls: string[] = [];
const getDocument = vi.fn((options: Record<string, unknown>) => {
	calls.push("getDocument");
	getDocument.lastOptions = options;
	return {
		promise: Promise.resolve({ numPages: 0 }),
		destroy: async () => undefined,
	};
}) as ReturnType<typeof vi.fn> & { lastOptions?: Record<string, unknown> };

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument }));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => {
	calls.push("worker");
	return { WorkerMessageHandler: class {} };
});

import { AttachmentExtractor, ensurePdfWorker } from "../src/attachmentExtractor";

const settings = {
	indexPdfAttachments: true,
	ocrImageAttachments: false,
	ocrScannedPdfAttachments: false,
};

function extractorFor(bytes: Uint8Array) {
	const vault = {
		adapter: { readBinary: async () => bytes.buffer },
	} as never;
	return new AttachmentExtractor(vault, settings);
}

const pdfFile = { path: "Docs/handbook.pdf", extension: "pdf" } as never;

describe("PDF worker registration", () => {
	beforeEach(() => {
		calls.length = 0;
	});

	it("registers the pdf.js worker before getDocument is called", async () => {
		await extractorFor(new Uint8Array([1, 2, 3])).extractAttachment(pdfFile);

		expect(calls).toEqual(["worker", "getDocument"]);
	});

	it("passes only options pdf.js v5 still supports", async () => {
		await extractorFor(new Uint8Array([1, 2, 3])).extractAttachment(pdfFile);

		// disableWorker and isEvalSupported were removed in pdf.js v5; passing them is
		// silently ignored, which is how the workerSrc crash went unnoticed.
		expect(Object.keys(getDocument.lastOptions ?? {}).sort()).toEqual([
			"data",
			"disableFontFace",
			"useSystemFonts",
			"useWorkerFetch",
		]);
	});

	it("resolves without touching GlobalWorkerOptions.workerSrc", async () => {
		await expect(ensurePdfWorker()).resolves.toBeUndefined();
	});
});
