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
	metadata: EmbeddingMetadata;
}

interface EmbeddingMetadata {
	source: string;
	fileName: string;
	chunk: number;
	totalChunks: number;
	indexed: number;
	fileModified: number;
}

interface FileIndex {
	path: string;
	modified: number;
	chunks: number;
}

interface EmbeddingData {
	embeddings: StoredEmbedding[];
	fileIndex: FileIndex[];
	lastIndexed: number;
	version: string;
	settings: {
		provider: string;
		model: string;
		serverAddress: string;
	};
}

// Chunking configuration
const CHUNK_SIZE = 800;        // Smaller chunks for better precision
const CHUNK_OVERLAP = 100;     // Overlap to preserve context
const MIN_CONTENT_LENGTH = 50; // Skip files with less content

export class RAGManager {
	private vectorStore: MemoryVectorStore;
	private embeddings: OpenAIEmbeddings;
	private fileIndex: Map<string, FileIndex> = new Map();
	private provider: string;
	private isLoaded: boolean = false;
	private cachedEmbeddings: Map<string, StoredEmbedding[]> = new Map();

	constructor(
		private vault: Vault,
		private settings: OLocalLLMSettings,
		private plugin: Plugin
	) {
		this.provider = this.settings.providerType || 'ollama';
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

		try {
			await this.loadEmbeddings();
			this.isLoaded = true;
			console.log('✅ RAGManager initialized');
		} catch (error) {
			console.error('❌ Failed to load embeddings:', error);
			this.isLoaded = true;
		}
	}

	updateSettings(settings: OLocalLLMSettings): void {
		const modelChanged = settings.embeddingModelName !== this.settings.embeddingModelName;
		const serverChanged = settings.serverAddress !== this.settings.serverAddress;

		this.settings = settings;
		this.provider = settings.providerType || 'ollama';

		// Only reinitialize embeddings client, preserve vector store data
		this.embeddings = new OpenAIEmbeddings(
			settings.openAIApiKey || 'not-needed',
			settings.embeddingModelName,
			settings.serverAddress
		);

		// Only warn if embedding-related settings changed
		if (modelChanged || serverChanged) {
			console.log('⚠️ RAGManager: Embedding settings changed. Re-index recommended for best results.');
		}
	}

	async getRAGResponse(query: string): Promise<{ response: string, sources: string[] }> {
		const indexedCount = this.getIndexedFilesCount();
		if (indexedCount === 0) {
			throw new Error("No notes indexed. Please index your notes first in Settings → Notes Index.");
		}

		try {
			const docs = await this.vectorStore.similaritySearch(query, 4);
			if (docs.length === 0) {
				throw new Error("No relevant content found. Try rephrasing your question.");
			}

			const baseURL = this.settings.serverAddress.endsWith('/v1')
				? this.settings.serverAddress
				: `${this.settings.serverAddress}/v1`;

			const llm = new ChatOpenAI({
				openAIApiKey: this.settings.openAIApiKey || 'not-needed',
				modelName: this.settings.llmModel,
				temperature: this.settings.temperature,
				configuration: { baseURL },
			});

			const promptTemplate = PromptTemplate.fromTemplate(
				`You are a helpful assistant answering questions based on the user's notes.
Use the context below to answer the question. If the context doesn't contain relevant information, say so.
Be concise and cite specific notes when possible.

Context:
{context}

Question: {input}

Answer:`
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

		console.log("📚 Starting indexing process...");

		const allFiles = this.vault.getMarkdownFiles();
		const totalFiles = allFiles.length;

		if (totalFiles === 0) {
			console.log("No markdown files found in vault.");
			return;
		}

		// Determine which files need indexing
		const { toIndex, toRemove, unchanged } = await this.getFilesToProcess(allFiles);

		console.log(`📊 Index status: ${toIndex.length} new/modified, ${toRemove.length} deleted, ${unchanged.length} unchanged`);

		// Remove deleted files from index
		for (const path of toRemove) {
			this.removeFileFromIndex(path);
		}

		// Process new/modified files
		let processed = 0;
		const totalToProcess = toIndex.length;

		for (const file of toIndex) {
			try {
				await this.indexFile(file);
				processed++;
				progressCallback((processed / totalToProcess) * 0.9 + 0.1); // Reserve 10% for saving
			} catch (error) {
				console.error(`Error indexing ${file.path}:`, error);
			}
		}

		// Save to persistent storage
		progressCallback(0.95);
		await this.saveEmbeddings();
		progressCallback(1);

		console.log(`✅ Indexing complete. ${this.fileIndex.size} files indexed.`);
	}

	private async getFilesToProcess(allFiles: TFile[]): Promise<{
		toIndex: TFile[];
		toRemove: string[];
		unchanged: string[];
	}> {
		const currentPaths = new Set(allFiles.map(f => f.path));
		const toIndex: TFile[] = [];
		const unchanged: string[] = [];
		const toRemove: string[] = [];

		// Find files to remove (deleted from vault)
		for (const [path] of this.fileIndex) {
			if (!currentPaths.has(path)) {
				toRemove.push(path);
			}
		}

		// Find files to index (new or modified)
		for (const file of allFiles) {
			const existing = this.fileIndex.get(file.path);

			if (!existing) {
				// New file
				toIndex.push(file);
			} else if (file.stat.mtime > existing.modified) {
				// Modified file
				toIndex.push(file);
			} else {
				unchanged.push(file.path);
			}
		}

		return { toIndex, toRemove, unchanged };
	}

	private async indexFile(file: TFile): Promise<void> {
		const content = await this.vault.cachedRead(file);

		// Preprocess content
		const cleanedContent = this.preprocessContent(content);

		// Skip files with minimal content
		if (cleanedContent.length < MIN_CONTENT_LENGTH) {
			console.log(`⏭️ Skipping ${file.path} (content too short)`);
			return;
		}

		// Remove old embeddings for this file
		this.removeFileFromIndex(file.path);

		// Create chunks with overlap
		const chunks = this.splitIntoChunks(cleanedContent);

		if (chunks.length === 0) {
			return;
		}

		const fileName = file.basename;
		const now = Date.now();

		// Create documents and add to vector store
		for (let i = 0; i < chunks.length; i++) {
			const metadata: EmbeddingMetadata = {
				source: file.path,
				fileName: fileName,
				chunk: i,
				totalChunks: chunks.length,
				indexed: now,
				fileModified: file.stat.mtime
			};

			const doc = new Document({
				pageContent: chunks[i],
				metadata: metadata
			});

			await this.vectorStore.addDocuments([doc]);
		}

		// Update file index
		this.fileIndex.set(file.path, {
			path: file.path,
			modified: file.stat.mtime,
			chunks: chunks.length
		});

		console.log(`✅ Indexed ${file.path} (${chunks.length} chunks)`);
	}

	private removeFileFromIndex(path: string): void {
		// Remove from file index
		this.fileIndex.delete(path);

		// Remove embeddings from vector store
		const memoryVectors = (this.vectorStore as any).memoryVectors;
		if (memoryVectors && Array.isArray(memoryVectors)) {
			(this.vectorStore as any).memoryVectors = memoryVectors.filter(
				(v: any) => v.metadata?.source !== path
			);
		}

		// Remove from cache
		this.cachedEmbeddings.delete(path);
	}

	private preprocessContent(content: string): string {
		let processed = content;

		// Remove YAML frontmatter
		processed = processed.replace(/^---[\s\S]*?---\n*/m, '');

		// Remove code blocks (keep the description if any)
		processed = processed.replace(/```[\s\S]*?```/g, '');

		// Convert Obsidian links to plain text: [[link|alias]] -> alias, [[link]] -> link
		processed = processed.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
		processed = processed.replace(/\[\[([^\]]+)\]\]/g, '$1');

		// Remove image embeds
		processed = processed.replace(/!\[\[.*?\]\]/g, '');
		processed = processed.replace(/!\[.*?\]\(.*?\)/g, '');

		// Remove HTML tags
		processed = processed.replace(/<[^>]*>/g, '');

		// Remove markdown formatting but keep text
		processed = processed.replace(/(\*\*|__)(.*?)\1/g, '$2'); // Bold
		processed = processed.replace(/(\*|_)(.*?)\1/g, '$2');   // Italic
		processed = processed.replace(/~~(.*?)~~/g, '$1');        // Strikethrough
		processed = processed.replace(/`([^`]+)`/g, '$1');        // Inline code

		// Remove heading markers but keep text
		processed = processed.replace(/^#{1,6}\s+/gm, '');

		// Remove bullet/list markers
		processed = processed.replace(/^[\s]*[-*+]\s+/gm, '');
		processed = processed.replace(/^[\s]*\d+\.\s+/gm, '');

		// Remove blockquotes marker
		processed = processed.replace(/^>\s*/gm, '');

		// Remove horizontal rules
		processed = processed.replace(/^[-*_]{3,}\s*$/gm, '');

		// Normalize whitespace
		processed = processed.replace(/\n{3,}/g, '\n\n');
		processed = processed.replace(/[ \t]+/g, ' ');
		processed = processed.trim();

		return processed;
	}

	private splitIntoChunks(content: string): string[] {
		const chunks: string[] = [];

		if (!content || content.length === 0) {
			return chunks;
		}

		// Split by paragraphs first
		const paragraphs = content.split(/\n\n+/);
		let currentChunk = '';

		for (const paragraph of paragraphs) {
			const trimmedPara = paragraph.trim();
			if (!trimmedPara) continue;

			// If adding this paragraph exceeds chunk size
			if (currentChunk.length + trimmedPara.length + 2 > CHUNK_SIZE) {
				// Save current chunk if it has content
				if (currentChunk.length >= MIN_CONTENT_LENGTH) {
					chunks.push(currentChunk.trim());
				}

				// If paragraph itself is too long, split by sentences
				if (trimmedPara.length > CHUNK_SIZE) {
					const sentenceChunks = this.splitLongText(trimmedPara);
					chunks.push(...sentenceChunks);
					currentChunk = '';
				} else {
					// Start new chunk with overlap from previous
					const overlap = this.getOverlapText(currentChunk);
					currentChunk = overlap + trimmedPara;
				}
			} else {
				currentChunk += (currentChunk ? '\n\n' : '') + trimmedPara;
			}
		}

		// Don't forget the last chunk
		if (currentChunk.length >= MIN_CONTENT_LENGTH) {
			chunks.push(currentChunk.trim());
		}

		return chunks;
	}

	private splitLongText(text: string): string[] {
		const chunks: string[] = [];

		// Split by sentences (rough approximation)
		const sentences = text.split(/(?<=[.!?])\s+/);
		let currentChunk = '';

		for (const sentence of sentences) {
			if (currentChunk.length + sentence.length + 1 > CHUNK_SIZE) {
				if (currentChunk.length >= MIN_CONTENT_LENGTH) {
					chunks.push(currentChunk.trim());
				}
				const overlap = this.getOverlapText(currentChunk);
				currentChunk = overlap + sentence;
			} else {
				currentChunk += (currentChunk ? ' ' : '') + sentence;
			}
		}

		if (currentChunk.length >= MIN_CONTENT_LENGTH) {
			chunks.push(currentChunk.trim());
		}

		return chunks;
	}

	private getOverlapText(text: string): string {
		if (!text || text.length <= CHUNK_OVERLAP) {
			return '';
		}

		// Get last N characters, but try to break at word boundary
		const overlapStart = text.length - CHUNK_OVERLAP;
		const overlap = text.substring(overlapStart);

		// Find first space to get complete words
		const firstSpace = overlap.indexOf(' ');
		if (firstSpace > 0 && firstSpace < CHUNK_OVERLAP / 2) {
			return overlap.substring(firstSpace + 1) + ' ';
		}

		return overlap + ' ';
	}

	async findSimilarNotes(query: string): Promise<string> {
		try {
			const similarDocs = await this.vectorStore.similaritySearch(query, 5);

			if (similarDocs.length === 0) {
				return '';
			}

			const uniqueBacklinks = new Map<string, string>();

			for (const doc of similarDocs) {
				const source = doc.metadata.source;
				if (!uniqueBacklinks.has(source)) {
					const preview = doc.pageContent.substring(0, 100).replace(/\n/g, ' ');
					uniqueBacklinks.set(source, `[[${source}]]: ${preview}...`);
				}
			}

			return Array.from(uniqueBacklinks.values()).join('\n');
		} catch (error) {
			console.error('Error in findSimilarNotes:', error);
			return '';
		}
	}

	getIndexedFilesCount(): number {
		return this.fileIndex.size;
	}

	isInitialized(): boolean {
		return this.isLoaded;
	}

	async saveEmbeddings(): Promise<void> {
		try {
			console.log('💾 Saving embeddings...');

			const storedEmbeddings: StoredEmbedding[] = [];
			const vectorStoreData = (this.vectorStore as any).memoryVectors;

			if (vectorStoreData && Array.isArray(vectorStoreData)) {
				for (const item of vectorStoreData) {
					storedEmbeddings.push({
						id: `${item.metadata?.source || 'unknown'}_${item.metadata?.chunk || 0}`,
						content: item.content,
						vector: item.embedding,
						metadata: item.metadata
					});
				}
			}

			const embeddingData: EmbeddingData = {
				embeddings: storedEmbeddings,
				fileIndex: Array.from(this.fileIndex.values()),
				lastIndexed: Date.now(),
				version: '2.0',
				settings: {
					provider: this.provider,
					model: this.settings.embeddingModelName,
					serverAddress: this.settings.serverAddress
				}
			};

			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;
			await adapter.write(embeddingPath, JSON.stringify(embeddingData));

			console.log(`✅ Saved ${storedEmbeddings.length} embeddings from ${this.fileIndex.size} files`);
		} catch (error) {
			console.error('Failed to save embeddings:', error);
			throw error;
		}
	}

	async loadEmbeddings(): Promise<void> {
		try {
			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;

			let data: EmbeddingData;
			try {
				const embeddingJson = await adapter.read(embeddingPath);
				data = JSON.parse(embeddingJson);
			} catch {
				console.log('📂 No existing embeddings found');
				return;
			}

			if (!data?.embeddings?.length) {
				console.log('📂 Empty embeddings file');
				return;
			}

			// Check if settings changed
			if (this.shouldRebuildIndex(data.settings)) {
				console.log('⚠️ Embedding settings changed. Re-indexing recommended.');
				// Still load old embeddings, but warn user
			}

			// Restore vector store
			this.vectorStore = new MemoryVectorStore(this.embeddings);

			const memoryVectors = data.embeddings.map(stored => ({
				content: stored.content,
				embedding: stored.vector,
				metadata: stored.metadata
			}));

			(this.vectorStore as any).memoryVectors = memoryVectors;

			// Restore file index
			this.fileIndex.clear();

			// Handle both old format (indexedFiles: string[]) and new format (fileIndex: FileIndex[])
			if (data.fileIndex) {
				for (const file of data.fileIndex) {
					this.fileIndex.set(file.path, file);
				}
			} else if ((data as any).indexedFiles) {
				// Migrate from old format
				for (const path of (data as any).indexedFiles) {
					this.fileIndex.set(path, { path, modified: 0, chunks: 0 });
				}
			}

			console.log(`✅ Loaded ${data.embeddings.length} embeddings from ${this.fileIndex.size} files`);

		} catch (error) {
			console.error('Failed to load embeddings:', error);
		}
	}

	private shouldRebuildIndex(savedSettings: any): boolean {
		if (!savedSettings) return true;

		return (
			savedSettings.model !== this.settings.embeddingModelName ||
			savedSettings.serverAddress !== this.settings.serverAddress
		);
	}

	async getStorageStats(): Promise<{
		totalEmbeddings: number;
		indexedFiles: number;
		lastIndexed: string;
		storageUsed: string;
	}> {
		try {
			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;

			let data: EmbeddingData;
			try {
				const embeddingJson = await adapter.read(embeddingPath);
				data = JSON.parse(embeddingJson);
			} catch {
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

			const indexedFiles = data.fileIndex?.length || (data as any).indexedFiles?.length || 0;

			return {
				totalEmbeddings: data.embeddings?.length || 0,
				indexedFiles,
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
			const adapter = this.plugin.app.vault.adapter;
			const embeddingPath = `${this.plugin.manifest.dir}/embeddings.json`;

			try {
				await adapter.remove(embeddingPath);
			} catch {
				// File might not exist
			}

			this.fileIndex.clear();
			this.cachedEmbeddings.clear();
			this.vectorStore = new MemoryVectorStore(this.embeddings);

			console.log('✅ Cleared all embeddings');
		} catch (error) {
			console.error('Failed to clear embeddings:', error);
		}
	}

	async waitForVaultReady(): Promise<void> {
		let attempts = 0;
		while (attempts < 50) {
			if (this.vault.getFiles().length > 0) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
			attempts++;
		}
	}
}