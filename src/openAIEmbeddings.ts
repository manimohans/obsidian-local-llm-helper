import { debugLog } from "./debug";
import { OpenAICompatibleClient } from "./llmClient";

/**
 * OpenAI-compatible embeddings client.
 * Works with any server that implements the OpenAI /v1/embeddings endpoint:
 * - Ollama (http://localhost:11434)
 * - LM Studio (http://localhost:1234)
 * - vLLM
 * - OpenAI
 * - Any other OpenAI-compatible server
 *
 * Uses the shared OpenAI-compatible client, which sends requests through
 * Obsidian's CORS-safe transport and requests `encoding_format: "float"`.
 * This avoids a bug where the
 * `openai` SDK defaults to base64 encoding and blindly decodes the response,
 * which produces all-zero vectors against servers that ignore that parameter
 * (observed on LM Studio with bge-m3 / Qwen3 embedding models).
 */

interface OpenAIEmbeddingsOptions {
	batchSize?: number;
	stripNewLines?: boolean;
}

export class OpenAIEmbeddings {
	private modelName: string;
	private batchSize: number;
	private stripNewLines: boolean;

	constructor(
		private client: OpenAICompatibleClient,
		modelName: string,
		options: OpenAIEmbeddingsOptions = {}
	) {
		this.modelName = modelName;
		this.batchSize = options.batchSize ?? 96;
		this.stripNewLines = options.stripNewLines ?? true;

		debugLog(
			`OpenAI-compatible Embeddings initialized - Model: ${modelName}`
		);
	}

	async embedDocuments(documents: string[]): Promise<number[][]> {
		if (documents.length === 0) return [];

		debugLog(`Embedding ${documents.length} documents...`);
		const inputs = this.stripNewLines
			? documents.map((t) => t.replace(/\n/g, " "))
			: documents.slice();

		const result: number[][] = new Array(inputs.length);
		for (let start = 0; start < inputs.length; start += this.batchSize) {
			const batch = inputs.slice(start, start + this.batchSize);
			const vectors = await this.callEmbeddingsAPI(batch);
			for (let j = 0; j < vectors.length; j++) {
				result[start + j] = vectors[j];
			}
		}

		debugLog(`Successfully embedded ${documents.length} documents`);
		return result;
	}

	async embedQuery(text: string): Promise<number[]> {
		debugLog(`Embedding query...`);
		const input = this.stripNewLines ? text.replace(/\n/g, " ") : text;
		const vectors = await this.callEmbeddingsAPI([input]);
		debugLog(`Successfully embedded query`);
		return vectors[0];
	}

	private async callEmbeddingsAPI(inputs: string[]): Promise<number[][]> {
		const vectors = await this.client.embed({
			model: this.modelName,
			inputs,
		});

		this.validateVectors(vectors);
		return vectors;
	}

	/**
	 * Detect the "all zeros" failure mode (symptom of encoding mismatch or a
	 * broken model load) and fail loudly rather than persisting a useless index.
	 */
	private validateVectors(vectors: number[][]): void {
		const expectedDim = vectors[0].length;
		for (let i = 0; i < vectors.length; i++) {
			const vec = vectors[i];

			if (vec.length !== expectedDim) {
				throw new Error(
					`Inconsistent embedding dimensions in response ` +
						`(expected ${expectedDim}, got ${vec.length} at index ${i}).`
				);
			}

			let allZero = true;
			for (let j = 0; j < vec.length; j++) {
				if (vec[j] !== 0) {
					allZero = false;
					break;
				}
			}
			if (allZero) {
				throw new Error(
					`Embeddings server returned an all-zero vector. This usually means:\n` +
						`• The embedding model is not actually loaded (some servers silently fall back)\n` +
						`• The server ignored encoding_format and returned malformed data\n` +
						`• The model name in settings does not match the loaded model\n` +
						`Try reloading the embedding model on the server and re-indexing.`
				);
			}
		}
	}

}
