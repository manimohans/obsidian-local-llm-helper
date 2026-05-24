import { TFile, Vault } from "obsidian";

export type IndexedSourceType = "markdown" | "pdf" | "image";
export type ExtractionMethod = "markdown" | "pdf-text" | "pdf-ocr" | "image-ocr";

export interface AttachmentIndexingSettings {
	indexPdfAttachments: boolean;
	ocrImageAttachments: boolean;
	ocrScannedPdfAttachments: boolean;
}

export interface ExtractedAttachmentChunk {
	text: string;
	pageNumber?: number;
	sourceType: IndexedSourceType;
	extractionMethod: ExtractionMethod;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const PDF_TEXT_MIN_LENGTH = 30;

type OCRWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;

export class AttachmentExtractor {
	private ocrWorkerPromise: Promise<OCRWorker> | null = null;

	constructor(private vault: Vault, private settings: AttachmentIndexingSettings) {}

	updateSettings(settings: AttachmentIndexingSettings): void {
		this.settings = settings;
	}

	async dispose(): Promise<void> {
		if (!this.ocrWorkerPromise) {
			return;
		}
		try {
			const worker = await this.ocrWorkerPromise;
			await worker.terminate();
		} catch (error) {
			console.warn("Failed to terminate OCR worker cleanly:", error);
		} finally {
			this.ocrWorkerPromise = null;
		}
	}

	isSupportedAttachment(file: TFile): boolean {
		return this.isPdf(file) || this.isImage(file);
	}

	async extractAttachment(file: TFile): Promise<ExtractedAttachmentChunk[]> {
		if (this.isPdf(file)) {
			if (!this.settings.indexPdfAttachments) {
				return [];
			}
			return this.extractPdf(file);
		}

		if (this.isImage(file)) {
			if (!this.settings.ocrImageAttachments) {
				return [];
			}
			const text = await this.runImageOCR(await this.readFileBlob(file));
			return text
				? [{ text, sourceType: "image", extractionMethod: "image-ocr" }]
				: [];
		}

		return [];
	}

	private isPdf(file: TFile): boolean {
		return file.extension.toLowerCase() === "pdf";
	}

	private isImage(file: TFile): boolean {
		return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
	}

	private async extractPdf(file: TFile): Promise<ExtractedAttachmentChunk[]> {
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const data = new Uint8Array(await this.vault.adapter.readBinary(file.path));
		const loadingTask = pdfjs.getDocument({
			data,
			useSystemFonts: true,
			isEvalSupported: false,
			useWorkerFetch: false,
			disableFontFace: true,
			disableWorker: true,
		} as never);
		const pdf = await loadingTask.promise;
		const chunks: ExtractedAttachmentChunk[] = [];

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const textContent = await page.getTextContent();
			const extractedText = (textContent.items as Array<{ str?: string }>)
				.map((item) => item?.str || "")
				.join(" ");
			const normalizedText = this.normalizeText(extractedText);

			if (normalizedText.length >= PDF_TEXT_MIN_LENGTH) {
				chunks.push({
					text: normalizedText,
					pageNumber,
					sourceType: "pdf",
					extractionMethod: "pdf-text",
				});
				continue;
			}

			if (!this.settings.ocrScannedPdfAttachments) {
				continue;
			}

			try {
				const pageBlob = await this.renderPdfPageToBlob(page);
				const ocrText = await this.runImageOCR(pageBlob);
				if (ocrText) {
					chunks.push({
						text: ocrText,
						pageNumber,
						sourceType: "pdf",
						extractionMethod: "pdf-ocr",
					});
				}
			} catch (error) {
				console.warn(`Skipping OCR for PDF page ${pageNumber} in ${file.path}:`, error);
			}
		}

		await loadingTask.destroy();
		return chunks;
	}

	private async renderPdfPageToBlob(page: any): Promise<Blob> {
		const viewport = page.getViewport({ scale: 1.5 });
		const canvas = document.createElement("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Canvas context unavailable for PDF OCR rendering.");
		}

		await page.render({ canvasContext: context, canvas, viewport }).promise;

		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((nextBlob) => resolve(nextBlob), "image/png");
		});
		if (!blob) {
			throw new Error("Failed to render PDF page to OCR image.");
		}
		return blob;
	}

	private async readFileBlob(file: TFile): Promise<Blob> {
		const buffer = await this.vault.adapter.readBinary(file.path);
		return new Blob([buffer], { type: this.getMimeType(file) });
	}

	private getMimeType(file: TFile): string {
		switch (file.extension.toLowerCase()) {
			case "png":
				return "image/png";
			case "jpg":
			case "jpeg":
				return "image/jpeg";
			case "webp":
				return "image/webp";
			case "gif":
				return "image/gif";
			case "bmp":
				return "image/bmp";
			case "pdf":
				return "application/pdf";
			default:
				return "application/octet-stream";
		}
	}

	private async runImageOCR(blob: Blob): Promise<string> {
		const worker = await this.getOrCreateOCRWorker();
		const objectUrl = URL.createObjectURL(blob);
		try {
			const result = await worker.recognize(objectUrl);
			return this.normalizeText(result.data.text || "");
		} finally {
			URL.revokeObjectURL(objectUrl);
		}
	}

	private async getOrCreateOCRWorker(): Promise<OCRWorker> {
		if (!this.ocrWorkerPromise) {
			this.ocrWorkerPromise = (async () => {
				const { createWorker } = await import("tesseract.js");
				return createWorker("eng");
			})();
		}

		return this.ocrWorkerPromise;
	}

	private normalizeText(text: string): string {
		return text
			.replace(/\u0000/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}
