import { Document } from 'langchain/document';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { TFile, Vault, Plugin } from 'obsidian';
import { OpenAIEmbeddings } from './openAIEmbeddings';
import { ChatOpenAI } from "@langchain/openai";
import { createRetrievalChain } from "langchain/chains/retrieval";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { PromptTemplate } from "@langchain/core/prompts";
import { OLocalLLMSettings } from '../main';

interface StoredEmbedding {
	id: string;
	content: string;
	vector: number[];
	metadata: any;
}

interface EmbeddingData {
	embeddings: StoredEmbedding[];
	indexedFiles: string[];
	lastIndexed: number;
	version: string;
	settings: {
		provider: string;
		model: string;
		serverAddress: string;
	};
}

const CHUNK_SIZE = 1000;

export class RAGManager {
	private vectorStore: MemoryVectorStore;
	private embeddings: OpenAIEmbeddings;
	private indexedFiles: string[] = [];
	private provider: string;
	private isLoaded: boolean = false;

	constructor(
		private vault: Vault,
		private settings: OLocalLLMSettings,
		private plugin: Plugin
	) {
		this.provider = this.settings.providerType || 'ollama';

		// Initialize embeddings using unified OpenAI-compatible client
		// Works with Ollama, LM Studio, vLLM, OpenAI, and any OpenAI-compatible server
		this.embeddings = new OpenAIEmbeddings(
			this.settings.openAIApiKey || 'not-needed',
			this.settings.embeddingModelName,
			this.settings.serverAddress
		);

		this.vectorStore = new MemoryVectorStore(this.embeddings);
	}

	async initialize(): Promise<void> {
		if (this.isLoaded) return;
		
		console.log('🔄 RAGManager: Starting initialization...');
		console.log(`📁 RAGManager: Plugin settings path: ${this.plugin.manifest.dir}/data.json`);
		console.log(`📁 RAGManager: Embeddings path: ${this.plugin.manifest.dir}/embeddings.json`);
		
		try {
			await this.loadEmbeddings();
			this.isLoaded = true;
			console.log('✅ RAGManager initialized with persistent storage');
		} catch (error) {
			console.error('❌ Failed to load embeddings, starting fresh:', error);
			this.isLoaded = true;
		}
	}

	updateSettings(settings: OLocalLLMSettings): void {
		this.settings = settings;
		this.provider = settings.providerType || 'ollama';

		// Reinitialize embeddings with new settings (unified OpenAI-compatible client)
		this.embeddings = new OpenAIEmbeddings(
			settings.openAIApiKey || 'not-needed',
			settings.embeddingModelName,
			settings.serverAddress
		);

		// Update vector store with new embeddings
		this.vectorStore = new MemoryVectorStore(this.embeddings);

		console.log(`RAGManager settings updated - Server: ${settings.serverAddress}, Embedding Model: ${settings.embeddingModelName}`);
	}

	async getRAGResponse(query: string): Promise<{ response: string, sources: string[] }> {
		try {
			const docs = await this.vectorStore.similaritySearch(query, 4);
			if (docs.length === 0) throw new Error("No relevant documents found");

			// Initialize LLM using unified OpenAI-compatible client
			// Works with Ollama, LM Studio, vLLM, OpenAI, and any OpenAI-compatible server
			const baseURL = this.settings.serverAddress.endsWith('/v1')
				? this.settings.serverAddress
				: `${this.settings.serverAddress}/v1`;

			const llm = new ChatOpenAI({
				openAIApiKey: this.settings.openAIApiKey || 'not-needed',
				modelName: this.settings.llmModel,
				temperature: this.settings.temperature,
				configuration: {
					baseURL: baseURL,
				},
			});

			const promptTemplate = PromptTemplate.fromTemplate(
				`Answer the following question based on the context:\n\nContext: {context}\nQuestion: {input}\nAnswer:`
			);

			const documentChain = await createStuffDocumentsChain({ llm, prompt: promptTemplate });
			const retrievalChain = await createRetrievalChain({
				combineDocsChain: documentChain,
				retriever: this.vectorStore.asRetriever(4),
			});

			const result = await retrievalChain.invoke({ input: query });
			const sources = [...new Set(result.context.map((doc: Document) => doc.metadata.source))];

			return {
				response: result.answer as string,
				sources: sources
			};
		} catch (error) {
			console.error("RAG Error:", error);
			throw error;
		}
	}

	async indexNotes(progressCallback: (progress: number) => void): Promise<void> {
		await this.initialize();
		await this.waitForVaultReady();
		console.log("Starting indexing process...");

		const allFiles = this.vault.getFiles().filter(file => file.extension === 'md');
		console.log("All markdown files in vault:", allFiles.map(file => file.path));

		const totalFiles = allFiles.length;
		console.log(`Found ${totalFiles} markdown files to index.`);

		if (totalFiles > 0) {
			await this.processFiles(allFiles, progressCallback);
			
			// Save embeddings to persistent storage after indexing
			await this.saveEmbeddings();
		} else {
			console.log("No markdown files found in the vault. Please check your vault configuration.");
		}

		console.log(`Indexing complete. ${this.indexedFiles.length} files indexed.`);
	}

	private async processFiles(files: TFile[], progressCallback: (progress: number) => void): Promise<void> {
		this.indexedFiles = []; // Reset indexed files
		const totalFiles = files.length;
		let successfullyIndexed = 0;

		for (let i = 0; i < totalFiles; i++) {
			const file = files[i];
			try {
				console.log(`Processing file ${i + 1}/${totalFiles}: ${file.path}`);
				const content = await this.vault.cachedRead(file);
				console.log(`File content length: ${content.length} characters`);

				const chunks = this.splitIntoChunks(content, CHUNK_SIZE);
				console.log(`Split content into ${chunks.length} chunks`);

				for (let j = 0; j < chunks.length; j++) {
					const chunk = chunks[j];
					const doc = new Document({
						pageContent: chunk,
						metadata: { source: file.path, chunk: j },
					});

					await this.vectorStore.addDocuments([doc]);
				}

				this.indexedFiles.push(file.path);
				successfullyIndexed++;
				console.log(`Indexed file ${successfullyIndexed}/${totalFiles}: ${file.path}`);
			} catch (error) {
				console.error(`Error indexing file ${file.path}:`, error);
			}

			progressCallback((i + 1) / totalFiles);
		}

		console.log(`Successfully indexed ${successfullyIndexed} out of ${totalFiles} files.`);
	}

	private splitIntoChunks(content: string, chunkSize: number): string[] {
		const chunks: string[] = [];
		let currentChunk = '';

		content.split(/\s+/).forEach((word) => {
			if (currentChunk.length + word.length + 1 <= chunkSize) {
				currentChunk += (currentChunk ? ' ' : '') + word;
			} else {
				chunks.push(currentChunk);
				currentChunk = word;
			}
		});

		if (currentChunk) {
			chunks.push(currentChunk);
		}

		return chunks;
	}

	async findSimilarNotes(query: string): Promise<string> {
		try {
			const similarDocs = await this.vectorStore.similaritySearch(query, 5);
			console.log("Similar docs found:", similarDocs.length);

			if (similarDocs.length === 0) {
				return '';
			}

			const uniqueBacklinks = new Map<string, string>();

			similarDocs.forEach((doc, index) => {
				const backlink = `[[${doc.metadata.source}]]`;
				console.log(`Processing doc ${index + 1}:`, backlink);
				if (!uniqueBacklinks.has(backlink)) {
					const entry = `${backlink}: ${doc.pageContent.substring(0, 100)}...`;
					uniqueBacklinks.set(backlink, entry);
					console.log("Added unique backlink:", entry);
				} else {
					console.log("Duplicate backlink found:", backlink);
				}
			});

			console.log("Final unique backlinks:", Array.from(uniqueBacklinks.values()));
			return Array.from(uniqueBacklinks.values()).join('\n');
		} catch (error) {
			console.error('Error in findSimilarNotes:', error);
			return '';
		}
	}

	getIndexedFilesCount(): number {
		return this.indexedFiles.length;
	}

	isInitialized(): boolean {
		return this.isLoaded;
	}

	async saveEmbeddings(): Promise<void> {
		try {
			console.log('Saving embeddings to persistent storage...');
			
			// Extract embeddings from MemoryVectorStore
			const storedEmbeddings: StoredEmbedding[] = [];
			const vectorStoreData = (this.vectorStore as any).memoryVectors;
			
			if (vectorStoreData && Array.isArray(vectorStoreData)) {
				for (let i = 0; i < vectorStoreData.length; i++) {
					const item = vectorStoreData[i];
					storedEmbeddings.push({
						id: `${item.metadata?.source || 'unknown'}_${item.metadata?.chunk || i}`,
						content: item.content,
						vector: item.embedding,
						metadata: item.metadata
					});
				}
			}

			const embeddingData: EmbeddingData = {
				embeddings: storedEmbeddings,
				indexedFiles: this.indexedFiles,
				lastIndexed: Date.now(),
				version: '1.0',
				settings: {
					provider: this.provider,
					model: this.settings.embeddingModelName,
					serverAddress: this.settings.serverAddress
				}
			};

			// Save embeddings data separately from plugin settings
			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;
			await adapter.write(embeddingPath, JSON.stringify(embeddingData));
			console.log(`✅ Saved ${storedEmbeddings.length} embeddings to disk`);
		} catch (error) {
			console.error('Failed to save embeddings:', error);
		}
	}

	async loadEmbeddings(): Promise<void> {
		try {
			console.log('📂 RAGManager: Loading embeddings from persistent storage...');
			// Load embeddings data separately from plugin settings
			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;
			
			let data: EmbeddingData;
			try {
				const embeddingJson = await adapter.read(embeddingPath);
				data = JSON.parse(embeddingJson);
			} catch (fileError) {
				console.log('📂 RAGManager: No embeddings file found, starting fresh');
				return;
			}
			
			console.log('📊 RAGManager: Raw data check:', {
				dataExists: !!data,
				hasEmbeddings: data?.embeddings?.length || 0,
				hasIndexedFiles: data?.indexedFiles?.length || 0,
				lastIndexed: data?.lastIndexed ? new Date(data.lastIndexed).toLocaleString() : 'Never',
				settingsMatch: data?.settings ? {
					provider: data.settings.provider,
					model: data.settings.model,
					serverAddress: data.settings.serverAddress
				} : 'No settings'
			});
			
			if (!data || !data.embeddings) {
				console.log('🆕 RAGManager: No saved embeddings found, starting fresh');
				return;
			}

			// Check if settings have changed significantly
			if (this.shouldRebuildIndex(data.settings)) {
				console.log('⚙️ RAGManager: Settings changed, embeddings will be rebuilt on next index');
				console.log('Current vs Saved:', {
					current: { provider: this.provider, model: this.settings.embeddingModelName, server: this.settings.serverAddress },
					saved: data.settings
				});
				console.log('❌ RAGManager: NOT loading existing embeddings due to settings mismatch');
				return;
			}

			// Reconstruct MemoryVectorStore from saved data
			const documents: Document[] = [];
			
			for (const stored of data.embeddings) {
				const doc = new Document({
					pageContent: stored.content,
					metadata: stored.metadata
				});
				documents.push(doc);
			}

			if (documents.length > 0) {
				console.log(`🔄 RAGManager: Reconstructing vector store with ${documents.length} documents WITHOUT re-embedding...`);
				
				// Create new vector store WITHOUT calling addDocuments (which re-embeds)
				this.vectorStore = new MemoryVectorStore(this.embeddings);
				
				// Directly populate the internal vector storage with saved embeddings
				const memoryVectors = data.embeddings.map(stored => ({
					content: stored.content,
					embedding: stored.vector,
					metadata: stored.metadata
				}));
				
				// Set the internal memoryVectors directly
				(this.vectorStore as any).memoryVectors = memoryVectors;
				
				console.log(`✅ RAGManager: Restored ${memoryVectors.length} embeddings WITHOUT re-embedding`);
			}

			this.indexedFiles = data.indexedFiles || [];
			
			console.log(`✅ RAGManager: Successfully loaded ${data.embeddings.length} embeddings from disk`);
			console.log(`📁 RAGManager: ${this.indexedFiles.length} files were previously indexed`);
			console.log(`🗂️ RAGManager: Files: ${this.indexedFiles.slice(0, 3).join(', ')}${this.indexedFiles.length > 3 ? '...' : ''}`);
			
			// Show user-friendly message
			const lastIndexedDate = new Date(data.lastIndexed).toLocaleString();
			console.log(`🕒 RAGManager: Last indexed: ${lastIndexedDate}`);
			
		} catch (error) {
			console.error('Failed to load embeddings:', error);
			throw error;
		}
	}

	private shouldRebuildIndex(savedSettings: any): boolean {
		if (!savedSettings) {
			console.log('🔄 RAGManager: No saved settings, will rebuild');
			return true;
		}
		
		const currentSettings = {
			provider: this.provider,
			model: this.settings.embeddingModelName,
			serverAddress: this.settings.serverAddress
		};
		
		console.log('🔍 RAGManager: Comparing settings:');
		console.log('  Current:', currentSettings);
		console.log('  Saved:', savedSettings);
		
		// Check each comparison individually
		const providerChanged = savedSettings.provider !== this.provider;
		const modelChanged = savedSettings.model !== this.settings.embeddingModelName;
		const serverChanged = savedSettings.serverAddress !== this.settings.serverAddress;
		
		console.log(`🔍 RAGManager: Individual comparisons:`);
		console.log(`  Provider changed: ${providerChanged} (${savedSettings.provider} !== ${this.provider})`);
		console.log(`  Model changed: ${modelChanged} (${savedSettings.model} !== ${this.settings.embeddingModelName})`);
		console.log(`  Server changed: ${serverChanged} (${savedSettings.serverAddress} !== ${this.settings.serverAddress})`);
		
		const needsRebuild = providerChanged || modelChanged || serverChanged;
		console.log(`🔄 RAGManager: Needs rebuild? ${needsRebuild}`);
		
		return needsRebuild;
	}

	async getStorageStats(): Promise<{ totalEmbeddings: number; indexedFiles: number; lastIndexed: string; storageUsed: string }> {
		try {
			// Load embeddings data separately from plugin settings
			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;
			
			let data: EmbeddingData;
			try {
				const embeddingJson = await adapter.read(embeddingPath);
				data = JSON.parse(embeddingJson);
			} catch (fileError) {
				return {
					totalEmbeddings: 0,
					indexedFiles: 0,
					lastIndexed: 'Never',
					storageUsed: '0 KB'
				};
			}
			
			if (!data) {
				return {
					totalEmbeddings: 0,
					indexedFiles: 0,
					lastIndexed: 'Never',
					storageUsed: '0 KB'
				};
			}

			const storageSize = JSON.stringify(data).length;
			const storageUsed = storageSize < 1024 
				? `${storageSize} B` 
				: storageSize < 1024 * 1024 
					? `${(storageSize / 1024).toFixed(1)} KB`
					: `${(storageSize / (1024 * 1024)).toFixed(1)} MB`;

			return {
				totalEmbeddings: data.embeddings?.length || 0,
				indexedFiles: data.indexedFiles?.length || 0,
				lastIndexed: data.lastIndexed ? new Date(data.lastIndexed).toLocaleString() : 'Never',
				storageUsed
			};
		} catch (error) {
			console.error('Failed to get storage stats:', error);
			return {
				totalEmbeddings: 0,
				indexedFiles: 0,
				lastIndexed: 'Error',
				storageUsed: 'Unknown'
			};
		}
	}

	async clearStoredEmbeddings(): Promise<void> {
		try {
			// Clear embeddings data separately from plugin settings
			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;
			
			try {
				await adapter.remove(embeddingPath);
			} catch (error) {
				// File might not exist, that's okay
			}
			
			this.indexedFiles = [];
			this.vectorStore = new MemoryVectorStore(this.embeddings);
			console.log('✅ Cleared all stored embeddings');
		} catch (error) {
			console.error('Failed to clear embeddings:', error);
		}
	}

	async waitForVaultReady(): Promise<void> {
		while (true) {
			const files = this.vault.getFiles();
			if (files.length > 0) {
				break; // Vault is ready if we have files
			}
			// If no files, wait and try again
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
}