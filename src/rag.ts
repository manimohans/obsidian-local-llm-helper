import { TFile, Vault, Plugin, requestUrl } from "obsidian";
import { OpenAIEmbeddings } from "./openAIEmbeddings";
import type { OLocalLLMSettings } from "../main";
import {
	AttachmentExtractor,
	type ExtractionMethod,
	type IndexedSourceType,
} from "./attachmentExtractor";
import {
	buildOpenAIHeaders,
	getChatApiKey,
	getChatCompletionsUrl,
	getEffectiveEmbeddingApiKey,
	getEffectiveEmbeddingBaseUrl,
	getEffectiveEmbeddingServerAddress,
} from "./providerSettings";

interface IndexedDocument {
	pageContent: string;
	metadata: EmbeddingMetadata;
}

interface VectorEntry {
	doc: IndexedDocument;
	vector: number[];
}

class InMemoryVectorStore {
	entries: VectorEntry[] = [];

	constructor(private embedder: OpenAIEmbeddings) {}

	setEmbedder(embedder: OpenAIEmbeddings): void {
		this.embedder = embedder;
	}

	async addDocuments(docs: IndexedDocument[]): Promise<void> {
		if (docs.length === 0) {
			return;
		}

		const vectors = await this.embedder.embedDocuments(docs.map(doc => doc.pageContent));
		for (let i = 0; i < docs.length; i++) {
			this.entries.push({ doc: docs[i], vector: vectors[i] });
		}
	}

	removeBySource(path: string): void {
		this.entries = this.entries.filter(entry => entry.doc.metadata.source !== path);
	}

	clear(): void {
		this.entries = [];
	}
}

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
	sourceType: IndexedSourceType;
	extractionMethod: ExtractionMethod;
	pageNumber?: number;
}

interface FileIndex {
	path: string;
	modified: number;
	chunks: number;
	sourceType: IndexedSourceType;
}

interface EmbeddingData {
	embeddings: StoredEmbedding[];
	fileIndex?: FileIndex[];
	indexedFiles?: string[];
	lastIndexed: number;
	version: string;
	settings: {
		provider: string;
		model: string;
		serverAddress?: string;
		embeddingServerAddress?: string;
		indexPdfAttachments?: boolean;
		ocrImageAttachments?: boolean;
		ocrScannedPdfAttachments?: boolean;
	};
}

interface EmbeddingConfigSnapshot {
	model: string;
	serverAddress: string;
	indexPdfAttachments: boolean;
	ocrImageAttachments: boolean;
	ocrScannedPdfAttachments: boolean;
}

export type RAGScopeMode = 'vault' | 'paths' | 'folder' | 'tags';

export interface RAGQueryScope {
	mode: RAGScopeMode;
	paths?: string[];
	folder?: string;
	tags?: string[];
	label?: string;
}

export interface RelatedNoteResult {
	path: string;
	fileName: string;
	preview: string;
	score: number;
	sourceType: IndexedSourceType;
	pageNumber?: number;
	sourceLabel: string;
}

export interface SourceReference {
	path: string;
	label: string;
	sourceType: IndexedSourceType;
	pageNumber?: number;
}

export interface IndexStorageStats {
	totalEmbeddings: number;
	indexedFiles: number;
	lastIndexed: string;
	storageUsed: string;
	sourceCounts: Record<IndexedSourceType, number>;
}

// Chunking configuration
const CHUNK_SIZE = 800;        // Smaller chunks for better precision
const CHUNK_OVERLAP = 100;     // Overlap to preserve context
const MIN_CONTENT_LENGTH = 50; // Skip files with less content

export class RAGManager {
	private vectorStore: InMemoryVectorStore;
	private embeddings: OpenAIEmbeddings;
	private fileIndex: Map<string, FileIndex> = new Map();
	private provider: string;
	private isLoaded: boolean = false;
	private cachedEmbeddings: Map<string, StoredEmbedding[]> = new Map();
	private embeddingConfig: EmbeddingConfigSnapshot;
	private attachmentExtractor: AttachmentExtractor;

	constructor(
		private vault: Vault,
		private settings: OLocalLLMSettings,
		private plugin: Plugin
	) {
		this.provider = this.settings.providerType || "ollama";
		this.embeddingConfig = this.createEmbeddingConfig(this.settings);
		this.embeddings = this.createEmbeddingsClient(this.settings);
		this.vectorStore = new InMemoryVectorStore(this.embeddings);
		this.attachmentExtractor = new AttachmentExtractor(this.vault, this.settings);
	}

	async initialize(): Promise<void> {
		if (this.isLoaded) return;

		console.log("🔄 RAGManager: Starting initialization...");

		try {
			await this.loadEmbeddings();
			this.isLoaded = true;
			console.log("✅ RAGManager initialized");
		} catch (error) {
			console.error("❌ Failed to load embeddings:", error);
			this.isLoaded = true;
		}
	}

	updateSettings(settings: OLocalLLMSettings): void {
		const nextEmbeddingConfig = this.createEmbeddingConfig(settings);
		const modelChanged = nextEmbeddingConfig.model !== this.embeddingConfig.model;
		const serverChanged = nextEmbeddingConfig.serverAddress !== this.embeddingConfig.serverAddress;
		const attachmentSettingsChanged =
			nextEmbeddingConfig.indexPdfAttachments !== this.embeddingConfig.indexPdfAttachments ||
			nextEmbeddingConfig.ocrImageAttachments !== this.embeddingConfig.ocrImageAttachments ||
			nextEmbeddingConfig.ocrScannedPdfAttachments !== this.embeddingConfig.ocrScannedPdfAttachments;

		this.settings = settings;
		this.provider = settings.providerType || "ollama";
		this.embeddingConfig = nextEmbeddingConfig;
		this.attachmentExtractor.updateSettings(settings);

		this.embeddings = this.createEmbeddingsClient(settings);
		this.vectorStore.setEmbedder(this.embeddings);

		if (modelChanged || serverChanged || attachmentSettingsChanged) {
			console.log("⚠️ RAGManager: Index settings changed. Re-index recommended for best results.");
		}
	}

	private createEmbeddingConfig(settings: OLocalLLMSettings): EmbeddingConfigSnapshot {
		return {
			model: settings.embeddingModelName,
			serverAddress: getEffectiveEmbeddingServerAddress(settings),
			indexPdfAttachments: settings.indexPdfAttachments,
			ocrImageAttachments: settings.ocrImageAttachments,
			ocrScannedPdfAttachments: settings.ocrScannedPdfAttachments,
		};
	}

	private createEmbeddingsClient(settings: OLocalLLMSettings): OpenAIEmbeddings {
		return new OpenAIEmbeddings(
			getEffectiveEmbeddingApiKey(settings),
			settings.embeddingModelName,
			getEffectiveEmbeddingBaseUrl(settings)
		);
	}

	async getRelevantContext(query: string, scope?: RAGQueryScope): Promise<{ context: string; sources: SourceReference[] }> {
		const indexedCount = this.getIndexedFilesCount();
		if (indexedCount === 0) {
			throw new Error("No notes indexed. Please index your notes first in Settings → Notes Index.");
		}

		const resolvedScope = this.normalizeScope(scope);
		const docs = await this.searchDocuments(query, resolvedScope);
		if (docs.length === 0) {
			if (resolvedScope.mode === 'vault') {
				throw new Error("No relevant content found. Try rephrasing your question.");
			}
			throw new Error(`No indexed content matched the selected scope (${this.describeScope(resolvedScope)}).`);
		}

		const sources = this.buildSourceReferences(docs);
		const context = docs
			.map((doc, index) => {
				const source = this.getContextSourceLabel(doc.metadata, index);
				return `[Source: ${source}]\n${doc.pageContent}`;
			})
			.join("\n\n---\n\n");

		return { context, sources };
	}

	async getRAGResponse(query: string, scope?: RAGQueryScope): Promise<{ response: string; sources: SourceReference[] }> {
		const indexedCount = this.getIndexedFilesCount();
		if (indexedCount === 0) {
			throw new Error("No notes indexed. Please index your notes first in Settings → Notes Index.");
		}

		try {
			const resolvedScope = this.normalizeScope(scope);
			const docs = await this.searchDocuments(query, resolvedScope);
			if (docs.length === 0) {
				if (resolvedScope.mode === 'vault') {
					throw new Error("No relevant content found. Try rephrasing your question.");
				}
				throw new Error(`No indexed content matched the selected scope (${this.describeScope(resolvedScope)}).`);
			}

			const context = docs
				.map((doc, index) => `[${this.getContextSourceLabel(doc.metadata, index)}]\n${doc.pageContent}`)
				.join("\n\n---\n\n");

			const systemPrompt = `You are a helpful assistant answering questions based on the user's notes.
Use the context below to answer the question. If the context doesn't contain relevant information, say so.
Be concise and cite specific notes when possible.

Context:
${context}`;

			const response = await requestUrl({
				url: getChatCompletionsUrl(this.settings),
				method: 'POST',
				headers: buildOpenAIHeaders(getChatApiKey(this.settings)),
				body: JSON.stringify({
					model: this.settings.llmModel,
					temperature: this.settings.temperature,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: query },
					],
				}),
				throw: false,
			});

			if (response.status < 200 || response.status >= 300) {
				throw new Error(`Chat completion failed (HTTP ${response.status}): ${response.text?.slice(0, 300) ?? ''}`);
			}

			const answer = response.json?.choices?.[0]?.message?.content;
			if (typeof answer !== 'string') {
				throw new Error("Chat completion returned an unexpected response shape.");
			}

			const sources = this.buildSourceReferences(docs);

			return {
				response: answer,
				sources,
			};
		} catch (error) {
			console.error("RAG Error:", error);
			throw error;
		}
	}

	private async searchDocuments(query: string, scope: RAGQueryScope): Promise<IndexedDocument[]> {
		const entries = this.getScopedEntries(scope);
		if (entries.length === 0) {
			return [];
		}

		const queryEmbedding = await this.embeddings.embedQuery(query);
		return entries
			.map(entry => ({
				score: this.cosineSimilarity(queryEmbedding, entry.vector),
				doc: entry.doc
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, this.settings.ragTopK)
			.map(item => item.doc);
	}

	private getScopedEntries(scope: RAGQueryScope): VectorEntry[] {
		return this.vectorStore.entries.filter(entry =>
			this.matchesScope(entry.doc.metadata.source, scope)
		);
	}

	private matchesScope(sourcePath: string | undefined, scope: RAGQueryScope): boolean {
		if (!sourcePath) {
			return false;
		}

		switch (scope.mode) {
			case 'vault':
				return true;
			case "paths":
				return (scope.paths || []).includes(sourcePath);
			case "folder":
				if (!scope.folder) return false;
				return sourcePath === scope.folder || sourcePath.startsWith(`${scope.folder}/`);
			case "tags":
				return this.fileHasAnyTag(sourcePath, scope.tags || []);
			default:
				return false;
		}
	}

	private fileHasAnyTag(sourcePath: string, tags: string[]): boolean {
		if (tags.length === 0) {
			return false;
		}

		const app = this.plugin.app;
		const file = app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			return false;
		}

		const cache = app.metadataCache.getFileCache(file);
		const discoveredTags = new Set<string>();

		for (const entry of cache?.tags || []) {
			if (entry?.tag) {
				discoveredTags.add(this.normalizeTag(entry.tag));
			}
		}

		const frontmatterTags = cache?.frontmatter?.tags;
		if (Array.isArray(frontmatterTags)) {
			for (const tag of frontmatterTags) {
				if (typeof tag === 'string') {
					discoveredTags.add(this.normalizeTag(tag));
				}
			}
		} else if (typeof frontmatterTags === 'string') {
			discoveredTags.add(this.normalizeTag(frontmatterTags));
		}

		return tags.some(tag => discoveredTags.has(this.normalizeTag(tag)));
	}

	private normalizeTag(tag: string): string {
		return tag.trim().replace(/^#/, '').toLowerCase();
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length === 0 || b.length === 0 || a.length !== b.length) {
			return -1;
		}

		let dot = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		if (normA === 0 || normB === 0) {
			return -1;
		}

		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	private normalizeScope(scope?: RAGQueryScope): RAGQueryScope {
		if (!scope) {
			return { mode: 'vault', label: 'Entire vault' };
		}

		if (scope.mode === 'paths') {
			const paths = [...new Set((scope.paths || []).filter(Boolean))];
			return {
				mode: paths.length > 0 ? 'paths' : 'vault',
				paths,
				label: scope.label || (paths.length === 1 ? paths[0] : `${paths.length} notes`)
			};
		}

		if (scope.mode === 'folder') {
			const folder = (scope.folder || '').replace(/^\/+|\/+$/g, '');
			return folder
				? { mode: 'folder', folder, label: scope.label || folder }
				: { mode: 'vault', label: 'Entire vault' };
		}

		if (scope.mode === 'tags') {
			const tags = [...new Set((scope.tags || []).map(tag => this.normalizeTag(tag)).filter(Boolean))];
			return tags.length > 0
				? { mode: 'tags', tags, label: scope.label || tags.map(tag => `#${tag}`).join(', ') }
				: { mode: 'vault', label: 'Entire vault' };
		}

		return { mode: 'vault', label: scope.label || 'Entire vault' };
	}

	private describeScope(scope: RAGQueryScope): string {
		switch (scope.mode) {
			case 'paths':
				return scope.label || `${scope.paths?.length || 0} notes`;
			case 'folder':
				return scope.label || scope.folder || 'folder';
			case 'tags':
				return scope.label || (scope.tags || []).map(tag => `#${tag}`).join(', ');
			default:
				return 'entire vault';
		}
	}

	async indexNotes(progressCallback: (progress: number) => void): Promise<void> {
		await this.initialize();
		await this.waitForVaultReady();

		console.log("📚 Starting indexing process...");

		const allFiles = this.getIndexableFiles();
		const totalFiles = allFiles.length;

		if (totalFiles === 0) {
			console.log("No eligible sources found in vault.");
			return;
		}

		const { toIndex, toRemove, unchanged } = await this.getFilesToProcess(allFiles);

		console.log(`📊 Index status: ${toIndex.length} new/modified, ${toRemove.length} deleted, ${unchanged.length} unchanged`);

		for (const path of toRemove) {
			this.removeFileFromIndex(path);
		}

		let processed = 0;
		const totalToProcess = toIndex.length;

		for (const file of toIndex) {
			try {
				await this.indexFile(file);
				processed++;
				progressCallback(totalToProcess === 0 ? 0.95 : (processed / totalToProcess) * 0.9 + 0.1);
			} catch (error) {
				console.error(`Error indexing ${file.path}:`, error);
			}
		}

		progressCallback(0.95);
		await this.saveEmbeddings();
		progressCallback(1);

		console.log(`✅ Indexing complete. ${this.fileIndex.size} files indexed.`);
	}

	private getIndexableFiles(): TFile[] {
		const allFiles = this.vault.getFiles();
		const filesByPath = new Map<string, TFile>();

		for (const file of allFiles) {
			const extension = file.extension.toLowerCase();
			if (extension === "md") {
				filesByPath.set(file.path, file);
				continue;
			}
			if (extension === "pdf" && this.settings.indexPdfAttachments) {
				filesByPath.set(file.path, file);
				continue;
			}
			if (this.settings.ocrImageAttachments && ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extension)) {
				filesByPath.set(file.path, file);
			}
		}

		return Array.from(filesByPath.values());
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
				toIndex.push(file);
			} else if (file.stat.mtime > existing.modified) {
				toIndex.push(file);
			} else if (existing.sourceType !== this.getSourceTypeForFile(file)) {
				toIndex.push(file);
			} else {
				unchanged.push(file.path);
			}
		}

		return { toIndex, toRemove, unchanged };
	}

	private async indexFile(file: TFile): Promise<void> {
		const sourceType = this.getSourceTypeForFile(file);
		if (sourceType === "markdown") {
			await this.indexMarkdownFile(file);
			return;
		}

		const extractedChunks = await this.attachmentExtractor.extractAttachment(file);
		this.removeFileFromIndex(file.path);
		if (extractedChunks.length === 0) {
			console.log(`⏭️ Skipping ${file.path} (no extractable attachment text)`);
			return;
		}

		const docs: IndexedDocument[] = [];
		const now = Date.now();
		for (const extractedChunk of extractedChunks) {
			const cleanedContent = this.preprocessExtractedContent(extractedChunk.text);
			if (cleanedContent.length < MIN_CONTENT_LENGTH) {
				continue;
			}

			const chunks = this.splitIntoChunks(cleanedContent);
			docs.push(...chunks.map((content, chunkIndex) => ({
				pageContent: content,
				metadata: {
					source: file.path,
					fileName: file.basename,
					chunk: docs.length + chunkIndex,
					totalChunks: 0,
					indexed: now,
					fileModified: file.stat.mtime,
					sourceType: extractedChunk.sourceType,
					extractionMethod: extractedChunk.extractionMethod,
					pageNumber: extractedChunk.pageNumber,
				},
			})));
		}

		if (docs.length === 0) {
			return;
		}

		this.assignChunkTotals(docs);
		await this.vectorStore.addDocuments(docs);
		this.fileIndex.set(file.path, {
			path: file.path,
			modified: file.stat.mtime,
			chunks: docs.length,
			sourceType,
		});
		console.log(`✅ Indexed ${file.path} (${docs.length} chunks)`);
	}

	private async indexMarkdownFile(file: TFile): Promise<void> {
		const content = await this.vault.cachedRead(file);
		const cleanedContent = this.preprocessMarkdownContent(content);
		if (cleanedContent.length < MIN_CONTENT_LENGTH) {
			console.log(`⏭️ Skipping ${file.path} (content too short)`);
			return;
		}

		this.removeFileFromIndex(file.path);
		const chunks = this.splitIntoChunks(cleanedContent);
		if (chunks.length === 0) {
			return;
		}
		const now = Date.now();

		const docs: IndexedDocument[] = chunks.map((content, i) => ({
			pageContent: content,
			metadata: {
				source: file.path,
				fileName: file.basename,
				chunk: i,
				totalChunks: chunks.length,
				indexed: now,
				fileModified: file.stat.mtime,
				sourceType: "markdown",
				extractionMethod: "markdown",
			},
		}));

		await this.vectorStore.addDocuments(docs);
		this.fileIndex.set(file.path, {
			path: file.path,
			modified: file.stat.mtime,
			chunks: chunks.length,
			sourceType: "markdown",
		});
		console.log(`✅ Indexed ${file.path} (${chunks.length} chunks)`);
	}

	private assignChunkTotals(docs: IndexedDocument[]): void {
		for (let i = 0; i < docs.length; i++) {
			docs[i].metadata.chunk = i;
			docs[i].metadata.totalChunks = docs.length;
		}
	}

	private removeFileFromIndex(path: string): void {
		this.fileIndex.delete(path);
		this.vectorStore.removeBySource(path);
		this.cachedEmbeddings.delete(path);
	}

	private preprocessMarkdownContent(content: string): string {
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

	private preprocessExtractedContent(content: string): string {
		return content
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private getSourceTypeForFile(file: TFile): IndexedSourceType {
		const extension = file.extension.toLowerCase();
		if (extension === "pdf") {
			return "pdf";
		}
		if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extension)) {
			return "image";
		}
		return "markdown";
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

		const sentences = this.splitSentences(text);
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

	private splitSentences(text: string): string[] {
		return text.match(/[^.!?\s][^.!?]*(?:[.!?]+|$)/g) || [text];
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
			const similarNotes = (await this.findRelatedNotes(query)).filter(note => note.sourceType === "markdown");
			if (similarNotes.length === 0) {
				return '';
			}

			return similarNotes
				.map((note) => `[[${note.path}]]: ${note.preview}`)
				.join('\n');
		} catch (error) {
			console.error('Error in findSimilarNotes:', error);
			return '';
		}
	}

	async findRelatedNotes(
		query: string,
		options?: {
			scope?: RAGQueryScope;
			excludePaths?: string[];
			limit?: number;
		}
	): Promise<RelatedNoteResult[]> {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			return [];
		}

		const scope = this.normalizeScope(options?.scope);
		const entries = this.getScopedEntries(scope);
		if (entries.length === 0) {
			return [];
		}

		const excludedPaths = new Set((options?.excludePaths || []).filter(Boolean));
		const limit = options?.limit || this.settings.ragTopK;
		const queryEmbedding = await this.embeddings.embedQuery(trimmedQuery);
		const bestByPath = new Map<string, RelatedNoteResult>();

		for (const entry of entries) {
			const sourcePath = entry.doc.metadata.source;
			if (!sourcePath || excludedPaths.has(sourcePath)) {
				continue;
			}

			const score = this.cosineSimilarity(queryEmbedding, entry.vector);
			if (score <= 0) {
				continue;
			}

			const preview = this.buildPreview(entry.doc.pageContent || '');
			const existing = bestByPath.get(sourcePath);
			if (!existing || score > existing.score) {
				bestByPath.set(sourcePath, {
					path: sourcePath,
					fileName: entry.doc.metadata.fileName || sourcePath,
					preview,
					score,
					sourceType: entry.doc.metadata.sourceType,
					pageNumber: entry.doc.metadata.pageNumber,
					sourceLabel: this.formatSourceLabel(entry.doc.metadata),
				});
			}
		}

		return Array.from(bestByPath.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	private buildPreview(content: string): string {
		const normalized = content.replace(/\s+/g, ' ').trim();
		if (normalized.length <= 140) {
			return normalized;
		}

		return `${normalized.slice(0, 137)}...`;
	}

	getIndexedFilesCount(): number {
		return this.fileIndex.size;
	}

	getEligibleSourceCount(): number {
		return this.getIndexableFiles().length;
	}

	isInitialized(): boolean {
		return this.isLoaded;
	}

	async saveEmbeddings(): Promise<void> {
		try {
			console.log('💾 Saving embeddings...');

			const storedEmbeddings: StoredEmbedding[] = this.vectorStore.entries.map(entry => ({
				id: `${entry.doc.metadata.source || 'unknown'}_${entry.doc.metadata.chunk || 0}`,
				content: entry.doc.pageContent,
				vector: entry.vector,
				metadata: entry.doc.metadata
			}));

			const embeddingData: EmbeddingData = {
				embeddings: storedEmbeddings,
				fileIndex: Array.from(this.fileIndex.values()),
				lastIndexed: Date.now(),
				version: "3.0",
				settings: {
					provider: this.provider,
					model: this.embeddingConfig.model,
					serverAddress: this.settings.serverAddress,
					embeddingServerAddress: this.embeddingConfig.serverAddress,
					indexPdfAttachments: this.settings.indexPdfAttachments,
					ocrImageAttachments: this.settings.ocrImageAttachments,
					ocrScannedPdfAttachments: this.settings.ocrScannedPdfAttachments,
				},
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
				console.log("📂 No existing embeddings found");
				return;
			}

			if (!data?.embeddings?.length) {
				console.log("📂 Empty embeddings file");
				return;
			}

			if (this.shouldRebuildIndex(data.settings)) {
				console.log("⚠️ Embedding settings changed. Re-indexing recommended.");
			}

			this.vectorStore = new InMemoryVectorStore(this.embeddings);
			this.vectorStore.entries = data.embeddings.map(stored => ({
				doc: {
					pageContent: stored.content,
					metadata: {
						...stored.metadata,
						sourceType: stored.metadata.sourceType || "markdown",
						extractionMethod: stored.metadata.extractionMethod || "markdown",
					},
				},
				vector: stored.vector
			}));

			this.fileIndex.clear();
			if (data.fileIndex) {
				for (const file of data.fileIndex) {
					this.fileIndex.set(file.path, {
						...file,
						sourceType: file.sourceType || "markdown",
					});
				}
			} else if (data.indexedFiles) {
				for (const path of data.indexedFiles) {
					this.fileIndex.set(path, { path, modified: 0, chunks: 0, sourceType: "markdown" });
				}
			}

			console.log(`✅ Loaded ${data.embeddings.length} embeddings from ${this.fileIndex.size} files`);

		} catch (error) {
			console.error('Failed to load embeddings:', error);
		}
	}

	private shouldRebuildIndex(savedSettings?: EmbeddingData["settings"]): boolean {
		if (!savedSettings) return true;
		const savedEmbeddingServer = savedSettings.embeddingServerAddress || savedSettings.serverAddress || "";

		return (
			savedSettings.model !== this.embeddingConfig.model ||
			savedEmbeddingServer !== this.embeddingConfig.serverAddress ||
			Boolean(savedSettings.indexPdfAttachments) !== this.embeddingConfig.indexPdfAttachments ||
			Boolean(savedSettings.ocrImageAttachments) !== this.embeddingConfig.ocrImageAttachments ||
			Boolean(savedSettings.ocrScannedPdfAttachments) !== this.embeddingConfig.ocrScannedPdfAttachments
		);
	}

	async getStorageStats(): Promise<IndexStorageStats> {
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
					lastIndexed: "Never",
					storageUsed: "0 KB",
					sourceCounts: this.createEmptySourceCounts(),
				};
			}

			if (!data) {
				return {
					totalEmbeddings: 0,
					indexedFiles: 0,
					lastIndexed: "Never",
					storageUsed: "0 KB",
					sourceCounts: this.createEmptySourceCounts(),
				};
			}

			const storageSize = JSON.stringify(data).length;
			const storageUsed = storageSize < 1024
				? `${storageSize} B`
				: storageSize < 1024 * 1024
					? `${(storageSize / 1024).toFixed(1)} KB`
					: `${(storageSize / (1024 * 1024)).toFixed(1)} MB`;

			const fileIndexEntries = data.fileIndex?.map(file => ({
				...file,
				sourceType: file.sourceType || "markdown",
			})) || data.indexedFiles?.map(path => ({ path, modified: 0, chunks: 0, sourceType: "markdown" as const })) || [];
			const indexedFiles = fileIndexEntries.length;

			return {
				totalEmbeddings: data.embeddings?.length || 0,
				indexedFiles,
				lastIndexed: data.lastIndexed ? new Date(data.lastIndexed).toLocaleString() : "Never",
				storageUsed,
				sourceCounts: this.countSourceTypes(fileIndexEntries),
			};
		} catch (error) {
			console.error('Failed to get storage stats:', error);
			return {
				totalEmbeddings: 0,
				indexedFiles: 0,
				lastIndexed: "Error",
				storageUsed: "Unknown",
				sourceCounts: this.createEmptySourceCounts(),
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
			this.vectorStore.clear();

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
			await new Promise(resolve => window.setTimeout(resolve, 100));
			attempts++;
		}
	}

	async dispose(): Promise<void> {
		await this.attachmentExtractor.dispose();
	}

	private buildSourceReferences(docs: IndexedDocument[]): SourceReference[] {
		const seen = new Set<string>();
		const sources: SourceReference[] = [];

		for (const doc of docs) {
			const label = this.formatSourceLabel(doc.metadata);
			const key = `${doc.metadata.source}::${doc.metadata.pageNumber || 0}::${label}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			sources.push({
				path: doc.metadata.source,
				label,
				sourceType: doc.metadata.sourceType,
				pageNumber: doc.metadata.pageNumber,
			});
		}

		return sources;
	}

	private getContextSourceLabel(metadata: EmbeddingMetadata, index: number): string {
		return this.formatSourceLabel(metadata) || metadata.source || `Source ${index + 1}`;
	}

	private formatSourceLabel(metadata: EmbeddingMetadata): string {
		const pageLabel = metadata.pageNumber ? ` (page ${metadata.pageNumber})` : "";
		return `${metadata.fileName || metadata.source}${pageLabel}`;
	}

	private createEmptySourceCounts(): Record<IndexedSourceType, number> {
		return {
			markdown: 0,
			pdf: 0,
			image: 0,
		};
	}

	private countSourceTypes(fileIndexEntries: Array<Pick<FileIndex, "sourceType">>): Record<IndexedSourceType, number> {
		const counts = this.createEmptySourceCounts();
		for (const file of fileIndexEntries) {
			counts[file.sourceType] = (counts[file.sourceType] || 0) + 1;
		}
		return counts;
	}
}
