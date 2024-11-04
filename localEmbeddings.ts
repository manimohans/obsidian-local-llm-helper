import { OllamaEmbeddings } from "@langchain/ollama";

export class LocalEmbeddings extends OllamaEmbeddings {
    constructor(baseUrl: string, model: string) {
        super({
            baseUrl,
            model,
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
