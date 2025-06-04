import { requestUrl } from 'obsidian';

export class OllamaEmbeddings {
	private baseUrl: string;
	private model: string;

	constructor(baseUrl: string, model: string) {
		// Ensure Ollama uses the correct default port if not specified
		this.baseUrl = baseUrl.includes(':') ? baseUrl : 
			baseUrl.replace('localhost', 'localhost:11434').replace('127.0.0.1', '127.0.0.1:11434');
		this.model = model;
		
		console.log(`Ollama Embeddings initialized with URL: ${this.baseUrl}, Model: ${this.model}`);
	}

	async checkModelAvailability(): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/api/tags`,
				method: 'GET'
			});

			if (response.status === 200) {
				const result = response.json;
				const availableModels = result.models?.map((m: any) => m.name) || [];
				const isAvailable = availableModels.some((name: string) => 
					name === this.model || name === `${this.model}:latest`
				);
				
				if (!isAvailable) {
					console.warn(`Model ${this.model} not found. Available models:`, availableModels);
					return false;
				}
				
				return true;
			}
		} catch (error) {
			console.warn('Could not check model availability:', error);
		}
		
		return false;
	}

	async embedDocuments(documents: string[]): Promise<number[][]> {
		console.log(`Embedding ${documents.length} documents with Ollama`);
		try {
			const embeddings: number[][] = [];
			
			// Process documents one by one to avoid overwhelming the server
			for (const doc of documents) {
				const embedding = await this.embedQuery(doc);
				embeddings.push(embedding);
			}
			
			console.log(`Successfully embedded ${documents.length} documents`);
			return embeddings;
		} catch (error) {
			console.error('Error in Ollama embedDocuments:', error);
			throw error;
		}
	}

	async embedQuery(text: string): Promise<number[]> {
		console.log(`Embedding query with Ollama: "${text.substring(0, 50)}..."`);
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/api/embeddings`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: this.model,
					prompt: text
				})
			});

			if (response.status !== 200) {
				throw new Error(`Ollama API returned ${response.status}: ${response.text || 'Unknown error'}`);
			}

			const result = response.json;
			
			if (!result.embedding || !Array.isArray(result.embedding)) {
				throw new Error(`Invalid response from Ollama: ${JSON.stringify(result)}`);
			}

			console.log(`Successfully embedded query (${result.embedding.length} dimensions)`);
			return result.embedding;
		} catch (error) {
			console.error('Error in Ollama embedQuery:', error);
			
			// Provide helpful error messages
			if (error.message?.includes('400') || error.message?.includes('not found')) {
				// Check what models are available
				try {
					const isAvailable = await this.checkModelAvailability();
					if (!isAvailable) {
						throw new Error(`Model "${this.model}" not found in Ollama. Please install it with: ollama pull ${this.model}`);
					}
				} catch (checkError) {
					// If we can't check, provide generic message
					throw new Error(`Model "${this.model}" not available. Please ensure it's installed: ollama pull ${this.model}`);
				}
				throw new Error(`Bad request to Ollama: ${error.message}`);
			} else if (error.message?.includes('404')) {
				throw new Error(`Ollama server not found. Please ensure Ollama is running on ${this.baseUrl}`);
			} else if (error.message?.includes('ECONNREFUSED')) {
				throw new Error(`Cannot connect to Ollama server at ${this.baseUrl}. Please ensure Ollama is running.`);
			}
			
			throw error;
		}
	}
}
