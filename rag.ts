import { Document } from 'langchain/document';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { TFile, Vault, Plugin } from 'obsidian';
import { LocalEmbeddings } from './localEmbeddings';
import { Ollama } from "@langchain/ollama";
import { createRetrievalChain } from "langchain/chains/retrieval";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { PromptTemplate } from "@langchain/core/prompts";
import { OLocalLLMSettings } from './main';

const CHUNK_SIZE = 1000;

export class RAGManager {
    private vectorStore: MemoryVectorStore;
    private embeddings: LocalEmbeddings;
    private indexedFiles: string[] = [];

    constructor(
        private plugin: Plugin, 
        private vault: Vault, 
        private settings: OLocalLLMSettings
    ) {
        this.embeddings = new LocalEmbeddings(this.settings.serverAddress, this.settings.embeddingModelName);
        this.vectorStore = new MemoryVectorStore(this.embeddings);
    }

    async getRAGResponse(query: string): Promise<{ response: string, sources: string[] }> {
        try {
            // First, let's verify we have documents in the store
            const docs = await this.vectorStore.similaritySearch(query, 4);
            console.log("Retrieved docs:", docs); // Debug log

            if (docs.length === 0) {
                throw new Error("No relevant documents found in vector store");
            }

            const llm = new Ollama({
                baseUrl: this.settings.serverAddress,
                model: this.settings.llmModel,
                temperature: 0.7,
            });

            const promptTemplate = PromptTemplate.fromTemplate(
                `Answer the following question based on the provided context.

Context: {context}
Question: {input}

Answer:`
            );

            const documentChain = await createStuffDocumentsChain({
                llm,
                prompt: promptTemplate,
            });

            const retrievalChain = await createRetrievalChain({
                combineDocsChain: documentChain,
                retriever: this.vectorStore.asRetriever(4),
            });

            const result = await retrievalChain.invoke({
                input: query,
            });

            const sources = [...new Set(result.context.map(
                (doc: Document) => doc.metadata.source
            ))];
            console.log(result);

            return {
                response: result.answer as string,
                sources: sources
            };

        } catch (error) {
            console.error("Detailed error in RAG response:", {
                error,
                errorMessage: error.message,
                errorStack: error.stack
            });
            throw error;
        }
    }

    async indexNotes(progressCallback: (progress: number) => void): Promise<void> {
        await this.waitForVaultReady();
        console.log("Starting indexing process...");

        const allFiles = this.vault.getFiles().filter(file => file.extension === 'md');
        console.log("All markdown files in vault:", allFiles.map(file => file.path));

        const totalFiles = allFiles.length;
        console.log(`Found ${totalFiles} markdown files to index.`);

        if (totalFiles > 0) {
            await this.processFiles(allFiles, progressCallback);
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
