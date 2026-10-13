import { describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
vi.mock("obsidian", () => ({ Notice: class {}, TFile: class {} }));
import { RAGManager } from "../src/rag";

function harness() {
	// Exercise the real orchestration with deterministic extraction and persistence.
	const good = { path: "good.md" } as TFile;
	const bad = { path: "bad.pdf" } as TFile;
	const manager = Object.create(RAGManager.prototype) as RAGManager;
	const dependencies = {
		initialize: vi.fn().mockResolvedValue(undefined),
		waitForVaultReady: vi.fn().mockResolvedValue(undefined),
		getIndexableFiles: vi.fn(() => [good, bad]),
		getFilesToProcess: vi.fn().mockResolvedValue({ toIndex: [good, bad], toRemove: [], unchanged: [] }),
		indexFile: vi.fn().mockResolvedValue(undefined),
		saveEmbeddings: vi.fn().mockResolvedValue(undefined),
		fileIndex: new Map(),
	};
	Object.assign(manager, dependencies);
	return { manager, dependencies };
}

describe("indexing completion status", () => {
	it("reports failed sources after persisting successful work, while progress reaches completion", async () => {
		const { manager, dependencies } = harness();
		dependencies.indexFile.mockRejectedValueOnce(new Error("Embedding server unavailable"));
		const progress = vi.fn();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(manager.indexNotes(progress)).rejects.toThrow("1 failed source. Successful sources were saved.");
		expect(dependencies.indexFile).toHaveBeenCalledTimes(2);
		expect(dependencies.saveEmbeddings).toHaveBeenCalledOnce();
		expect(progress).toHaveBeenLastCalledWith(1);
	});

	it("succeeds when every source indexes", async () => {
		const { manager, dependencies } = harness();
		await expect(manager.indexNotes(vi.fn())).resolves.toBeUndefined();
		expect(dependencies.saveEmbeddings).toHaveBeenCalledOnce();
	});
});
