import { OpenAIEmbeddings as OEmbed } from "@langchain/openai";

export class OpenAIEmbeddings extends OEmbed {
	constructor(openAIApiKey: string = "lm-studio", modelName: string, baseURL: string = "http://127.0.0.1:1234") {
		// Ensure LM Studio uses the correct default port if not specified
		const studioUrl = baseURL.includes(':') ? baseURL : 
			baseURL.replace('localhost', 'localhost:1234').replace('127.0.0.1', '127.0.0.1:1234');
		
		super({
			openAIApiKey,
			modelName,
			configuration: { baseURL: `${studioUrl}/v1` }
		});
		
		console.log(`OpenAI/LM Studio Embeddings initialized with URL: ${studioUrl}/v1, Model: ${modelName}`);
	}

	async embedDocuments(documents: string[]): Promise<number[][]> {
		console.log(`Embedding ${documents.length} documents with OpenAI-compatible provider`);
		try {
			const embeddings = await super.embedDocuments(documents);
			console.log(`Successfully embedded ${documents.length} documents`);
			return embeddings;
		} catch (error) {
			console.error('Error in OpenAI-compatible embedDocuments:', error);
			throw this.createHelpfulError(error);
		}
	}

	async embedQuery(text: string): Promise<number[]> {
		console.log(`Embedding query with OpenAI-compatible provider`);
		try {
			const embedding = await super.embedQuery(text);
			console.log(`Successfully embedded query`);
			return embedding;
		} catch (error) {
			console.error('Error in OpenAI-compatible embedQuery:', error);
			throw this.createHelpfulError(error);
		}
	}

	private createHelpfulError(error: any): Error {
		const msg = error.message || String(error);

		if (msg.includes('ECONNREFUSED') || msg.includes('Failed to fetch')) {
			return new Error(`Cannot connect to server. Please ensure your server is running at the configured address.`);
		}

		if (msg.includes('OPTIONS') || msg.includes('Unexpected endpoint') || msg.includes('405')) {
			return new Error(
				`Embeddings endpoint not supported. Please ensure:\n` +
				`• Your server supports the /v1/embeddings endpoint\n` +
				`• An embedding model is loaded (chat models cannot generate embeddings)`
			);
		}

		if (msg.includes('404') || msg.includes('not found')) {
			return new Error(
				`Embeddings endpoint not found. Please ensure:\n` +
				`• Your server is running and supports /v1/embeddings\n` +
				`• An embedding model is loaded`
			);
		}

		if (msg.includes('400') || msg.includes('Bad Request')) {
			return new Error(
				`Embeddings request failed. The model may not support embeddings.\n` +
				`Please ensure an embedding model is loaded (e.g., text-embedding-ada-002, nomic-embed-text).`
			);
		}

		return error;
	}
}
