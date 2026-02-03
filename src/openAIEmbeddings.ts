import { OpenAIEmbeddings as LangChainOpenAIEmbeddings } from "@langchain/openai";

/**
 * OpenAI-compatible embeddings client.
 * Works with any server that implements the OpenAI /v1/embeddings endpoint:
 * - Ollama (http://localhost:11434)
 * - LM Studio (http://localhost:1234)
 * - vLLM
 * - OpenAI
 * - Any other OpenAI-compatible server
 */
export class OpenAIEmbeddings extends LangChainOpenAIEmbeddings {
	constructor(apiKey: string = "not-needed", modelName: string, baseURL: string) {
		// Ensure baseURL ends with /v1 for OpenAI-compatible endpoint
		const normalizedURL = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`;

		super({
			openAIApiKey: apiKey,
			modelName,
			configuration: { baseURL: normalizedURL }
		});

		console.log(`OpenAI-compatible Embeddings initialized - URL: ${normalizedURL}, Model: ${modelName}`);
	}

	async embedDocuments(documents: string[]): Promise<number[][]> {
		console.log(`Embedding ${documents.length} documents...`);
		try {
			const embeddings = await super.embedDocuments(documents);
			console.log(`Successfully embedded ${documents.length} documents`);
			return embeddings;
		} catch (error) {
			console.error('Embeddings error:', error);
			throw this.createHelpfulError(error);
		}
	}

	async embedQuery(text: string): Promise<number[]> {
		console.log(`Embedding query...`);
		try {
			const embedding = await super.embedQuery(text);
			console.log(`Successfully embedded query`);
			return embedding;
		} catch (error) {
			console.error('Embeddings error:', error);
			throw this.createHelpfulError(error);
		}
	}

	private createHelpfulError(error: any): Error {
		const msg = error.message || String(error);

		if (msg.includes('ECONNREFUSED') || msg.includes('Failed to fetch')) {
			return new Error(
				`Cannot connect to server. Please ensure your LLM server is running.`
			);
		}

		if (msg.includes('404') || msg.includes('not found')) {
			return new Error(
				`Embeddings endpoint not found. Please ensure:\n` +
				`• Your server supports /v1/embeddings\n` +
				`• An embedding model is loaded (e.g., nomic-embed-text, mxbai-embed-large)`
			);
		}

		if (msg.includes('400') || msg.includes('Bad Request') || msg.includes('model')) {
			return new Error(
				`Embeddings request failed. Please ensure:\n` +
				`• An embedding model is loaded (not a chat model)\n` +
				`• For Ollama: ollama pull nomic-embed-text\n` +
				`• The model name in settings matches the loaded model`
			);
		}

		return error;
	}
}
