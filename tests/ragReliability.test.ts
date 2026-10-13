import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin, TFile, Vault } from "obsidian";
import type { OLocalLLMSettings } from "../main";
import type { OpenAICompatibleClient } from "../src/llmClient";
vi.mock("obsidian", () => ({ Notice: class {}, TFile: class {} }));
import { AttachmentExtractor } from "../src/attachmentExtractor";
import { RAGManager } from "../src/rag";

const indexPath = "plugin/embeddings.json";
const original = "Original searchable text that is long enough to be included in the notes index.";
const replacement = "Replacement searchable text that is long enough to be included in the notes index.";
function setup() {
	const file = { path: "note.md", basename: "note", extension: "md", stat: { mtime: 10 } } as TFile;
	let files = [file];
	let content = original;
	const disk = new Map<string, string>();
	const adapter = {
		read: vi.fn(async (path: string) => { if (!disk.has(path)) throw new Error("Missing file"); return disk.get(path)!; }),
		exists: vi.fn(async (path: string) => disk.has(path)),
		write: vi.fn(async (path: string, value: string) => { disk.set(path, value); }),
		remove: vi.fn(async (path: string) => { disk.delete(path); }),
		rename: vi.fn(async (from: string, to: string) => { if (!disk.has(from)) throw new Error("Missing file"); disk.set(to, disk.get(from)!); disk.delete(from); }),
	};
	const vault = { adapter, getFiles: () => files, cachedRead: vi.fn(async () => content) };
	const settings = { providerType: "ollama", serverAddress: "http://localhost:11434", embeddingModelName: "test", ragTopK: 5,
		indexPdfAttachments: true, ocrImageAttachments: false, ocrScannedPdfAttachments: false } as OLocalLLMSettings;
	const client = { embed: vi.fn(async ({ inputs }: { inputs: string[] }) => inputs.map(() => [1, 0])) };
	const plugin = { app: { vault }, manifest: { dir: "plugin" } };
	const manager = new RAGManager(vault as unknown as Vault, settings, plugin as unknown as Plugin, client as unknown as OpenAICompatibleClient);
	vi.spyOn(manager, "waitForVaultReady").mockResolvedValue(undefined);
	return { manager, file, settings, disk, adapter, client, setFiles: (next: TFile[]) => { files = next; }, edit: (next: string, mtime = 20) => { content = next; file.stat.mtime = mtime; } };
}
const readContent = async (manager: RAGManager) => (await manager.getRelevantContext("query")).context;
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });

describe("index reliability", () => {
	it("removes the last deleted source from memory and storage", async () => {
		const h = setup(); await h.manager.indexNotes(vi.fn()); h.setFiles([]);
		await h.manager.indexNotes(vi.fn());
		expect(h.manager.getIndexedFilesCount()).toBe(0);
		expect(h.manager.getLoadedEmbeddingCount()).toBe(0);
		expect(JSON.parse(h.disk.get(indexPath)!).embeddings).toEqual([]);
	});
	it("removes stale text when a note becomes too short to index", async () => {
		const h = setup(); await h.manager.indexNotes(vi.fn()); h.edit("Empty");
		await h.manager.indexNotes(vi.fn());
		expect(h.manager.getLoadedEmbeddingCount()).toBe(0);
	});
	it("reindexes notes restored with older modification times", async () => {
		const h = setup(); await h.manager.indexNotes(vi.fn()); h.edit(replacement, 5);
		await h.manager.indexNotes(vi.fn()); expect(await readContent(h.manager)).toContain(replacement);
	});
	it("preserves a working source after an embedding failure and retries it later", async () => {
		const h = setup(); await h.manager.indexNotes(vi.fn()); h.edit(replacement);
		h.client.embed.mockRejectedValueOnce(new Error("Server offline"));
		await expect(h.manager.indexNotes(vi.fn())).rejects.toThrow("1 failed source");
		expect(await readContent(h.manager)).toContain(original);
		await h.manager.indexNotes(vi.fn()); expect(await readContent(h.manager)).toContain(replacement);
	});
	it("retries a failed save even if no source changed since the failed run", async () => {
		const h = setup(); h.adapter.write.mockRejectedValueOnce(new Error("Disk full"));
		await expect(h.manager.indexNotes(vi.fn())).rejects.toThrow("Disk full");
		await h.manager.indexNotes(vi.fn()); expect(h.disk.has(indexPath)).toBe(true);
	});
	it("rejects overlapping indexing and clearing without duplicating entries", async () => {
		const h = setup(); let finish!: (vectors: number[][]) => void;
		h.client.embed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const first = h.manager.indexNotes(vi.fn()); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		await expect(h.manager.indexNotes(vi.fn())).rejects.toThrow("already in progress");
		await expect(h.manager.clearStoredEmbeddings()).rejects.toThrow("in progress");
		finish([[1, 0]]); await first;
		expect(h.manager.getLoadedEmbeddingCount()).toBe(1);
	});
	it("does not mark text read before a file edit as the newest version", async () => {
		const h = setup(); let finish!: (vectors: number[][]) => void;
		h.client.embed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const run = h.manager.indexNotes(vi.fn()); const result = expect(run).rejects.toThrow("1 failed source");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function")); h.edit(replacement); finish([[1, 0]]); await result;
		await h.manager.indexNotes(vi.fn()); expect(await readContent(h.manager)).toContain(replacement);
	});
	it("does not mix vectors when embedding settings change during a request", async () => {
		const h = setup(); let finish!: (vectors: number[][]) => void;
		h.client.embed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const run = h.manager.indexNotes(vi.fn()); const result = expect(run).rejects.toThrow("settings changed");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		h.manager.updateSettings({ ...h.settings, embeddingModelName: "new-model" }); finish([[1, 0]]); await result;
		expect(h.manager.getLoadedEmbeddingCount()).toBe(0);
		await h.manager.indexNotes(vi.fn()); expect(h.manager.getLoadedEmbeddingCount()).toBe(1);
	});
	it("keeps progress monotonic and reaches completion only after saving", async () => {
		const h = setup(); const values: number[] = [];
		await h.manager.indexNotes(value => { values.push(value); if (value === 1) expect(h.disk.has(indexPath)).toBe(true); });
		expect(values).toEqual([...values].sort((a, b) => a - b)); expect(values[values.length - 1]).toBe(1);
	});
	it("preserves the last saved index when installing its replacement fails", async () => {
		const h = setup(); await h.manager.indexNotes(vi.fn()); const saved = h.disk.get(indexPath); h.edit(replacement);
		const rename = h.adapter.rename.getMockImplementation()!;
		h.adapter.rename.mockImplementation(async (from, to) => { if (from.endsWith(".tmp")) throw new Error("Rename failed"); return rename(from, to); });
		await expect(h.manager.indexNotes(vi.fn())).rejects.toThrow("Rename failed");
		expect(h.disk.get(indexPath)).toBe(saved);
		h.adapter.rename.mockImplementation(rename); await h.manager.indexNotes(vi.fn());
		expect(h.disk.get(indexPath)).toContain(replacement);
	});
	it("recovers the backup left by an interrupted index replacement", async () => {
		const h = setup(); await h.manager.indexNotes(vi.fn());
		const backup = h.disk.get(indexPath)!; await h.manager.clearStoredEmbeddings();
		h.disk.set(`${indexPath}.bak`, backup); await h.manager.loadEmbeddings();
		expect(await readContent(h.manager)).toContain(original);
		await h.manager.indexNotes(vi.fn()); expect(h.disk.get(indexPath)).toBeDefined();
	});
	it("reports a failed clear and keeps the working index available", async () => {
		const h = setup(); await h.manager.indexNotes(vi.fn());
		h.adapter.remove.mockRejectedValueOnce(new Error("Permission denied"));
		await expect(h.manager.clearStoredEmbeddings()).rejects.toThrow("Permission denied");
		expect(await readContent(h.manager)).toContain(original);
	});

	it("reextracts unchanged PDFs when OCR settings change, including after reloading storage", async () => {
		const h = setup(); h.file.path = "scan.pdf"; h.file.extension = "pdf";
		const extract = vi.spyOn(AttachmentExtractor.prototype, "extractAttachment").mockResolvedValue([{ text: original, sourceType: "pdf", extractionMethod: "pdf-text", pageNumber: 1 }]);
		await h.manager.indexNotes(vi.fn()); expect(extract).toHaveBeenCalledOnce();
		h.manager.updateSettings({ ...h.settings, ocrScannedPdfAttachments: true });
		await h.manager.loadEmbeddings(); await h.manager.indexNotes(vi.fn());
		expect(extract).toHaveBeenCalledTimes(2);
	});
	it("drops a disabled attachment even when it is the last eligible source", async () => {
		const h = setup(); h.file.path = "scan.pdf"; h.file.extension = "pdf";
		vi.spyOn(AttachmentExtractor.prototype, "extractAttachment").mockResolvedValue([{ text: original, sourceType: "pdf", extractionMethod: "pdf-text" }]);
		await h.manager.indexNotes(vi.fn()); h.manager.updateSettings({ ...h.settings, indexPdfAttachments: false });
		await h.manager.indexNotes(vi.fn()); expect(h.manager.getLoadedEmbeddingCount()).toBe(0);
		expect(JSON.parse(h.disk.get(indexPath)!).embeddings).toEqual([]);
	});
	it("does not commit a pending embedding after plugin unload", async () => {
		const h = setup(); let finish!: (vectors: number[][]) => void;
		h.client.embed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const run = h.manager.indexNotes(vi.fn()); const result = expect(run).rejects.toThrow("unloaded");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await h.manager.dispose(); finish([[1, 0]]); await result;
		expect(h.manager.getLoadedEmbeddingCount()).toBe(0); expect(h.disk.has(indexPath)).toBe(false);
	});

});
