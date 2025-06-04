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
		console.log(`Embedding ${documents.length} documents with OpenAI/LM Studio`);
		try {
			const embeddings = await super.embedDocuments(documents);
			console.log(`Successfully embedded ${documents.length} documents`);
			return embeddings;
		} catch (error) {
			console.error('Error in OpenAI/LM Studio embedDocuments:', error);
			
			// Provide helpful error messages
			if (error.message?.includes('404')) {
				throw new Error(`LM Studio server not found or model not loaded. Please ensure LM Studio is running and an embedding model is loaded.`);
			} else if (error.message?.includes('ECONNREFUSED')) {
				throw new Error(`Cannot connect to LM Studio server. Please ensure LM Studio is running on the configured address.`);
			}
			
			throw error;
		}
	}

	async embedQuery(text: string): Promise<number[]> {
		console.log(`Embedding query with OpenAI/LM Studio`);
		try {
			const embedding = await super.embedQuery(text);
			console.log(`Successfully embedded query`);
			return embedding;
		} catch (error) {
			console.error('Error in OpenAI/LM Studio embedQuery:', error);
			
			// Provide helpful error messages
			if (error.message?.includes('404')) {
				throw new Error(`LM Studio server not found or model not loaded. Please ensure LM Studio is running and an embedding model is loaded.`);
			} else if (error.message?.includes('ECONNREFUSED')) {
				throw new Error(`Cannot connect to LM Studio server. Please ensure LM Studio is running on the configured address.`);
			}
			
			throw error;
		}
	}
}
