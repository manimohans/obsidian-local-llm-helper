import { OpenAIEmbeddings as OEmbed } from "@langchain/openai";

export class OpenAIEmbeddings extends OEmbed {
	constructor(openAIApiKey: string = "lm-studio", modelName: string, baseURL: string = "http://127.0.0.1:1234") {
		super({
			openAIApiKey,
			modelName,
			configuration: { baseURL: `${baseURL}/v1` }
		});
	}

	async embedDocuments(documents: string[]): Promise<number[][]> {
		console.log(`Embedding ${documents.length} documents`);
		try {
			const embeddings = await super.embedDocuments(documents);
			console.log(`Successfully embedded ${documents.length} documents`);
			return embeddings;
		} catch (error) {
			console.error('Error in embedDocuments:', error);
			throw error;
		}
	}
}
