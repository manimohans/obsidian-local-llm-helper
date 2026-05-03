import { requestUrl } from "obsidian";

/**
 * OpenAI-compatible embeddings client.
 * Works with any server that implements the OpenAI /v1/embeddings endpoint:
 * - Ollama (http://localhost:11434)
 * - LM Studio (http://localhost:1234)
 * - vLLM
 * - OpenAI
 * - Any other OpenAI-compatible server
 *
 * Calls the endpoint directly via Obsidian's requestUrl (no CORS issues) and
 * explicitly requests `encoding_format: "float"`. This avoids a bug where the
 * `openai` SDK defaults to base64 encoding and blindly decodes the response,
 * which produces all-zero vectors against servers that ignore that parameter
 * (observed on LM Studio with bge-m3 / Qwen3 embedding models).
 */

interface OpenAIEmbeddingsOptions {
	batchSize?: number;
	stripNewLines?: boolean;
	timeoutMs?: number;
}

interface EmbeddingResponseItem {
	object: string;
	index: number;
	embedding: number[];
}

interface EmbeddingResponse {
	object: string;
	data: EmbeddingResponseItem[];
	model: string;
	usage?: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIEmbeddings {
	private apiKey: string;
	private modelName: string;
	private baseURL: string;
	private batchSize: number;
	private stripNewLines: boolean;
	private timeoutMs: number;

	constructor(
		apiKey: string = "not-needed",
		modelName: string,
		baseURL: string,
		options: OpenAIEmbeddingsOptions = {}
	) {
		this.apiKey = apiKey || "not-needed";
		this.modelName = modelName;
		this.baseURL = baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1`;
		this.batchSize = options.batchSize ?? 96;
		this.stripNewLines = options.stripNewLines ?? true;
		this.timeoutMs = options.timeoutMs ?? 60_000;

		console.log(
			`OpenAI-compatible Embeddings initialized - URL: ${this.baseURL}, Model: ${modelName}`
		);
	}

	async embedDocuments(documents: string[]): Promise<number[][]> {
		if (documents.length === 0) return [];

		console.log(`Embedding ${documents.length} documents...`);
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

		console.log(`Successfully embedded ${documents.length} documents`);
		return result;
	}

	async embedQuery(text: string): Promise<number[]> {
		console.log(`Embedding query...`);
		const input = this.stripNewLines ? text.replace(/\n/g, " ") : text;
		const vectors = await this.callEmbeddingsAPI([input]);
		console.log(`Successfully embedded query`);
		return vectors[0];
	}

	private async callEmbeddingsAPI(inputs: string[]): Promise<number[][]> {
		const url = `${this.baseURL}/embeddings`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.apiKey && this.apiKey !== "not-needed") {
			headers["Authorization"] = `Bearer ${this.apiKey}`;
		}

		const body = JSON.stringify({
			model: this.modelName,
			input: inputs,
			encoding_format: "float",
		});

		let response;
		try {
			response = await requestUrl({
				url,
				method: "POST",
				headers,
				body,
				throw: false,
			});
		} catch (error) {
			throw this.createHelpfulError(error);
		}

		if (response.status < 200 || response.status >= 300) {
			const snippet =
				typeof response.text === "string"
					? response.text.slice(0, 300)
					: "";
			throw this.createHelpfulError(
				new Error(`HTTP ${response.status}: ${snippet}`)
			);
		}

		let data: EmbeddingResponse;
		try {
			data = response.json as EmbeddingResponse;
		} catch (error) {
			throw new Error(
				`Failed to parse embeddings response as JSON: ${String(error)}`
			);
		}

		if (!data || !Array.isArray(data.data)) {
			throw new Error(
				`Unexpected embeddings response shape — missing "data" array.`
			);
		}
		if (data.data.length !== inputs.length) {
			throw new Error(
				`Embeddings response size mismatch: requested ${inputs.length}, got ${data.data.length}`
			);
		}

		// Servers may return results out of order; sort by index if present.
		const sorted = data.data
			.slice()
			.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

		const vectors = sorted.map((item, i) => {
			const vec = item.embedding;
			if (!Array.isArray(vec) || vec.length === 0) {
				throw new Error(
					`Embedding at index ${i} is missing or malformed in server response.`
				);
			}
			return vec;
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

	private createHelpfulError(error: any): Error {
		const msg = error?.message || String(error);

		if (
			msg.includes("ECONNREFUSED") ||
			msg.includes("ENOTFOUND") ||
			msg.includes("Failed to fetch") ||
			msg.includes("net::ERR")
		) {
			return new Error(
				`Cannot connect to server. Please ensure your LLM server is running.`
			);
		}

		if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
			return new Error(
				`Embeddings endpoint not found. Please ensure:\n` +
					`• Your server supports /v1/embeddings\n` +
					`• An embedding model is loaded (e.g., nomic-embed-text, mxbai-embed-large)`
			);
		}

		if (
			msg.includes("400") ||
			msg.includes("Bad Request") ||
			msg.toLowerCase().includes("model")
		) {
			return new Error(
				`Embeddings request failed. Please ensure:\n` +
					`• An embedding model is loaded (not a chat model)\n` +
					`• For Ollama: ollama pull nomic-embed-text\n` +
					`• The model name in settings matches the loaded model`
			);
		}

		return error instanceof Error ? error : new Error(msg);
	}
}
