import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient } from "../src/llmClient";
import { OpenAIEmbeddings } from "../src/openAIEmbeddings";

function createClient(embed: ReturnType<typeof vi.fn>): OpenAICompatibleClient {
	return { embed } as unknown as OpenAICompatibleClient;
}

describe("OpenAIEmbeddings", () => {
	it("batches documents and strips newlines before delegating", async () => {
		const embed = vi.fn(async ({ inputs }: { inputs: string[] }) =>
			inputs.map((_input, index) => [index + 1, 1]));
		const embeddings = new OpenAIEmbeddings(createClient(embed), "embed-model");
		const documents = Array.from({ length: 200 }, (_, index) => `line ${index}\ncontinued`);

		const vectors = await embeddings.embedDocuments(documents);

		expect(vectors).toHaveLength(200);
		expect(embed).toHaveBeenCalledTimes(3);
		expect(embed.mock.calls.map(([request]) => request.inputs.length)).toEqual([96, 96, 8]);
		expect(embed.mock.calls[0][0]).toMatchObject({
			model: "embed-model",
			inputs: expect.arrayContaining(["line 0 continued"]),
		});
	});

	it("supports query embedding and optional newline preservation", async () => {
		const embed = vi.fn(async () => [[1, 2]]);
		const embeddings = new OpenAIEmbeddings(createClient(embed), "embed-model", {
			stripNewLines: false,
		});

		await expect(embeddings.embedQuery("line one\nline two")).resolves.toEqual([1, 2]);
		expect(embed).toHaveBeenCalledWith({
			model: "embed-model",
			inputs: ["line one\nline two"],
		});
	});

	it("does not call the client for an empty document set", async () => {
		const embed = vi.fn();
		const embeddings = new OpenAIEmbeddings(createClient(embed), "embed-model");

		await expect(embeddings.embedDocuments([])).resolves.toEqual([]);
		expect(embed).not.toHaveBeenCalled();
	});

	it("rejects inconsistent vector dimensions", async () => {
		const embed = vi.fn(async () => [[1, 2], [1]]);
		const embeddings = new OpenAIEmbeddings(createClient(embed), "embed-model");

		await expect(embeddings.embedDocuments(["a", "b"]))
			.rejects.toThrow("Inconsistent embedding dimensions");
	});

	it("rejects all-zero vectors", async () => {
		const embed = vi.fn(async () => [[0, 0, 0]]);
		const embeddings = new OpenAIEmbeddings(createClient(embed), "embed-model");

		await expect(embeddings.embedQuery("query")).rejects.toThrow("all-zero vector");
	});
});
