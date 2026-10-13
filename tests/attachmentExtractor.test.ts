import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, Vault } from "obsidian";

vi.mock("obsidian", () => ({ TFile: class {}, Vault: class {} }));
const mocks = vi.hoisted(() => ({
	calls: [] as string[],
	workerHandler: {},
	destroy: vi.fn(),
	destroyWorker: vi.fn(),
	getPage: vi.fn(),
	getDocument: vi.fn(),
	createWorker: vi.fn(),
	recognize: vi.fn(),
	terminate: vi.fn(),
}));
const host = globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler: unknown } };
vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => {
	mocks.calls.push("import");
	host.pdfjsWorker = { WorkerMessageHandler: mocks.workerHandler };
	return host.pdfjsWorker;
});
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
	getDocument: mocks.getDocument,
	PDFWorker: class {
		constructor() {
			expect(host.pdfjsWorker?.WorkerMessageHandler).toBe(mocks.workerHandler);
			mocks.calls.push("worker");
		}
		destroy = mocks.destroyWorker;
	},
}));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker }));
import { AttachmentExtractor } from "../src/attachmentExtractor";
const settings = { indexPdfAttachments: true, ocrImageAttachments: false, ocrScannedPdfAttachments: false };
const pdfFile = { path: "Docs/handbook.pdf", extension: "pdf" } as TFile;
const createExtractor = () => new AttachmentExtractor({
	adapter: { readBinary: async () => new Uint8Array([1, 2, 3]).buffer },
} as unknown as Vault, settings);

describe("PDF worker registration and extraction", () => {
	beforeEach(() => {
		mocks.calls.length = 0;
		delete host.pdfjsWorker;
		mocks.destroy.mockResolvedValue(undefined);
		mocks.getPage.mockResolvedValue({ getTextContent: async () => ({ items: [
			{ str: "A long enough PDF paragraph for indexing.\u0000 More text." }, { type: "beginMarkedContent" },
		] }) });
		mocks.getDocument.mockImplementation(() => {
			mocks.calls.push("getDocument");
			return { promise: Promise.resolve({ numPages: 1, getPage: mocks.getPage }), destroy: mocks.destroy };
		});
	});

	it("registers its worker before loading a PDF and preserves Obsidian's existing handler", async () => {
		const obsidianHandler = { WorkerMessageHandler: { version: "host" } };
		host.pdfjsWorker = obsidianHandler;
		const chunks = await createExtractor().extractAttachment(pdfFile);
		expect(mocks.calls).toEqual(["import", "worker", "getDocument"]);
		expect(host.pdfjsWorker).toBe(obsidianHandler);
		expect(chunks).toEqual([{ text: "A long enough PDF paragraph for indexing. More text.", pageNumber: 1, sourceType: "pdf", extractionMethod: "pdf-text" }]);
		expect(mocks.destroy).toHaveBeenCalledOnce();
		expect(mocks.destroyWorker).toHaveBeenCalledOnce();
	});

	it("works repeatedly on a cold host without leaving a global registration", async () => {
		await createExtractor().extractAttachment(pdfFile);
		await createExtractor().extractAttachment(pdfFile);
		expect(host).not.toHaveProperty("pdfjsWorker");
		expect(mocks.getDocument).toHaveBeenCalledTimes(2);
	});

	it("passes supported options with an explicit local worker", async () => {
		await createExtractor().extractAttachment(pdfFile);
		expect(Object.keys(mocks.getDocument.mock.calls[0][0]).sort()).toEqual([
			"data", "disableFontFace", "useSystemFonts", "useWorkerFetch", "worker",
		]);
	});

	it("destroys the loading task and worker when extraction fails", async () => {
		mocks.getPage.mockRejectedValueOnce(new Error("Broken PDF page"));
		await expect(createExtractor().extractAttachment(pdfFile)).rejects.toThrow("Broken PDF page");
		expect(mocks.destroy).toHaveBeenCalledOnce();
		expect(mocks.destroyWorker).toHaveBeenCalledOnce();
	});

	it("destroys the worker when getDocument throws", async () => {
		mocks.getDocument.mockImplementationOnce(() => { throw new Error("Invalid document"); });
		await expect(createExtractor().extractAttachment(pdfFile)).rejects.toThrow("Invalid document");
		expect(mocks.destroyWorker).toHaveBeenCalledOnce();
	});

	it("does not load PDFs when attachment indexing is disabled", async () => {
		const extractor = createExtractor();
		extractor.updateSettings({ ...settings, indexPdfAttachments: false });
		expect(await extractor.extractAttachment(pdfFile)).toEqual([]);
		expect(mocks.getDocument).not.toHaveBeenCalled();
	});
	it("reports a failed OCR page instead of marking a partially extracted PDF as complete", async () => {
		const extractor = createExtractor(); extractor.updateSettings({ ...settings, ocrScannedPdfAttachments: true });
		mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage: mocks.getPage }), destroy: mocks.destroy });
		mocks.getPage.mockResolvedValueOnce({ getTextContent: async () => ({ items: [{ str: "A full first page with sufficient searchable text." }] }) })
			.mockResolvedValueOnce({ getTextContent: async () => ({ items: [] }), getViewport: () => { throw new Error("Render failed"); } });
		await expect(extractor.extractAttachment(pdfFile)).rejects.toThrow("page 2");
		expect(mocks.destroyWorker).toHaveBeenCalledOnce();
	});
	it("retries OCR worker initialization after a failed download", async () => {
		const extractor = createExtractor(); extractor.updateSettings({ ...settings, ocrImageAttachments: true });
		const image = { path: "scan.png", extension: "png" } as TFile;
		mocks.recognize.mockResolvedValue({ data: { text: "Recovered image text" } });
		mocks.createWorker.mockRejectedValueOnce(new Error("Download failed")).mockResolvedValueOnce({ recognize: mocks.recognize, terminate: mocks.terminate });
		await expect(extractor.extractAttachment(image)).rejects.toThrow("Download failed");
		expect(await extractor.extractAttachment(image)).toEqual([{ text: "Recovered image text", sourceType: "image", extractionMethod: "image-ocr" }]);
		expect(mocks.createWorker).toHaveBeenCalledTimes(2);
		await extractor.dispose(); expect(mocks.terminate).toHaveBeenCalledOnce();
	});
	it("does not create an OCR worker after the extractor is disposed", async () => {
		const extractor = createExtractor(); extractor.updateSettings({ ...settings, ocrImageAttachments: true });
		await extractor.dispose();
		await expect(extractor.extractAttachment({ path: "scan.png", extension: "png" } as TFile)).rejects.toThrow("unloaded");
		expect(mocks.createWorker).not.toHaveBeenCalled();
	});

});
