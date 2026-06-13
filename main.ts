import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TFile,
	requestUrl,
	TextComponent,
	ButtonComponent,
	WorkspaceLeaf,
} from "obsidian";
import { generateAndAppendTags } from "./src/autoTagger";
import { UpdateNoticeModal } from "./src/updateNoticeModal";
import { RAGManager, RAGQueryScope } from './src/rag';
import { BacklinkGenerator } from './src/backlinkGenerator';
import { RAGChatModal } from './src/ragChatModal';
import { ChatView, CHAT_VIEW_TYPE, type ChatViewOpenOptions } from './src/chatView';
import { PromptPickerModal } from './src/promptPickerModal';
import { Persona, PersonasDict, DEFAULT_PERSONAS, buildPersonasDict, modifyPrompt } from './src/personas';
import { CustomPrompt, generatePromptId, SelectPromptModal } from './src/customPrompts';
import { extractActualResponse, parseReasoningMarkers, DEFAULT_REASONING_MARKERS } from './src/reasoningExtractor';
import { RelatedNotesContext, RelatedNotesView, RELATED_NOTES_VIEW_TYPE } from './src/relatedNotesView';
import { VaultAgentService, type ChatEnvironmentContext, type ConversationEntry, getActiveChatContext } from './src/vaultAgent';
import { submitGeneralChat, updateConversationHistory as recordConversationHistory } from './src/chatSession';
import { WorkflowModal } from './src/workflowModal';
import { WorkflowRunnerService, createDefaultWorkflowDefaults, mergeWorkflowDefaults } from './src/workflowRunner';
import type { WorkflowDefaults } from './src/workflowTypes';
import {
	buildOpenAIHeaders,
	getChatApiKey,
	getChatCompletionsUrl,
	getChatModelsUrl,
	getEffectiveEmbeddingApiKey,
	getEffectiveEmbeddingServerAddress,
	getEmbeddingModelsUrl,
	normalizeOptionalServerAddress,
	normalizeServerAddress,
	type ModelEndpointTarget,
} from './src/providerSettings';

// Remember to rename these classes and interfaces!

export interface OLocalLLMSettings {
	serverAddress: string;
	embeddingServerAddress: string;
	llmModel: string;
	stream: boolean;
	customPrompt: string;
	maxTokens: number;
	maxConvHistory: number;
	outputMode: string;
	personas: string;
	providerType: string;
	responseFormatting: boolean;
	responseFormatPrepend: string;
	responseFormatAppend: string;
	temperature: number;
	lastVersion: string;
	embeddingModelName: string;
	braveSearchApiKey: string;
	openAIApiKey?: string;
	embeddingApiKey?: string;
	searchProvider: string;
	tavilyApiKey: string;
	searxngInstanceUrl: string;
	savedPersonas?: { [key: string]: Persona };
	customPrompts?: CustomPrompt[];
	extractReasoningResponses?: boolean;
	reasoningMarkers?: string;
	ragTopK: number;
	autoIndexIntervalMinutes: number;
	autoNotice: boolean;
	indexPdfAttachments: boolean;
	ocrImageAttachments: boolean;
	ocrScannedPdfAttachments: boolean;
	enableVaultActions: boolean;
	showAgentDebug: boolean;
	renderMarkdownInChat: boolean;
	workflowDefaults: WorkflowDefaults;
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "http://localhost:11434",
	embeddingServerAddress: "",
	llmModel: "llama3",
	maxTokens: 1024,
	temperature: 0.7,
	providerType: "ollama",
	stream: false,
	customPrompt: "create a todo list from the following text:",
	outputMode: "replace",
	personas: "default",
	maxConvHistory: 0,
	responseFormatting: false,
	responseFormatPrepend: "``` LLM Helper - generated response \n\n",
	responseFormatAppend: "\n\n```",
	lastVersion: "0.0.0",
	embeddingModelName: "mxbai-embed-large",
	braveSearchApiKey: "",
	openAIApiKey: "lm-studio",
	embeddingApiKey: "",
	searchProvider: "tavily",
	tavilyApiKey: "",
	searxngInstanceUrl: "",
	savedPersonas: undefined,
	customPrompts: [],
	extractReasoningResponses: false,
	reasoningMarkers: JSON.stringify(DEFAULT_REASONING_MARKERS, null, 2),
	ragTopK: 5,
	autoIndexIntervalMinutes: 0,   // 0 = disabled
	autoNotice: false,
	indexPdfAttachments: true,
	ocrImageAttachments: false,
	ocrScannedPdfAttachments: false,
	enableVaultActions: false,
	showAgentDebug: false,
	renderMarkdownInChat: true,
	workflowDefaults: createDefaultWorkflowDefaults(),
};

function normalizeSearxngInstanceUrl(url: string): string {
	return normalizeServerAddress(url);
}

export default class OLocalLLMPlugin extends Plugin {
	settings: OLocalLLMSettings;
	conversationHistory: ConversationEntry[] = [];
	isKillSwitchActive: boolean = false;
	autoIndexTimer: number | undefined;
	isIndexing: boolean = false;
	public ragManager: RAGManager;
	public vaultAgent: VaultAgentService;
	public workflowRunner: WorkflowRunnerService;
	private backlinkGenerator: BacklinkGenerator;
	public personasDict: PersonasDict = {};
	private registeredPromptCommands: Set<string> = new Set();
	private relatedNotesRefreshTimer: number | null = null;
	private lastRelatedNotesContext: RelatedNotesContext | null = null;
	private lastMarkdownLeaf: WorkspaceLeaf | null = null;

	async checkForUpdates() {
		const currentVersion = this.manifest.version;
		const lastVersion = this.settings.lastVersion || "0.0.0";
		//const lastVersion = "0.0.0";

		if (currentVersion !== lastVersion) {
			new UpdateNoticeModal(this.app, currentVersion).open();
			this.settings.lastVersion = currentVersion;
			await this.saveSettings();
		}
	}

	async onload() {
		await this.loadSettings();
		this.registerCustomPromptCommands();
		void this.checkForUpdates();
		// Validate server configuration
		this.validateServerConfiguration();

		// Initialize RAGManager
		this.ragManager = new RAGManager(this.app.vault, this.settings, this);
		this.vaultAgent = new VaultAgentService(this.app, this);
		this.workflowRunner = new WorkflowRunnerService(this.app, this);
		
		// Initialize RAGManager and show user notification about loaded data
		await this.ragManager.initialize();
		this.startAutoIndexTimer();
		
		// Show user-friendly notification about loaded embeddings after a short delay
		// This ensures all UI elements are ready
		window.setTimeout(() => {
			void this.showStorageNotification();
		}, 500);

		// Initialize BacklinkGenerator
		this.backlinkGenerator = new BacklinkGenerator(this.ragManager, this.app.vault);
		this.registerView(
			RELATED_NOTES_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new RelatedNotesView(leaf, this)
		);
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ChatView(leaf, this)
		);

		// Add command for RAG Backlinks
		this.addCommand({
			id: 'generate-rag-backlinks',
			name: 'Notes: Generate backlinks',
			callback: this.handleGenerateBacklinks.bind(this),
		});

		this.addCommand({
			id: 'open-related-notes-view',
			name: 'Notes: Open related notes',
			callback: () => {
				void this.activateRelatedNotesView();
			},
		});

		// Add diagnostic command
		this.addCommand({
			id: 'rag-diagnostics',
			name: 'Settings: RAG diagnostics',
			callback: this.handleDiagnostics.bind(this),
		});

		// Remove the automatic indexing
		// this.indexNotes();
		this.addCommand({
			id: 'rag-chat',
			name: 'Chat: Notes (RAG)',
			callback: () => {
				this.openRAGChat();
			},
		});

		this.addCommand({
			id: 'rag-chat-current-note',
			name: 'Chat: Current note',
			callback: () => {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					new Notice("Open a note first.");
					return;
				}
				this.openRAGChat({
					mode: 'paths',
					paths: [file.path],
					label: file.basename
				});
			},
		});

		this.addCommand({
			id: 'rag-chat-current-folder',
			name: 'Chat: Current folder',
			callback: () => {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					new Notice("Open a note first.");
					return;
				}
				this.openRAGChat({
					mode: 'folder',
					folder: this.getFolderPath(file),
					label: this.getFolderPath(file) || 'Vault root'
				});
			},
		});

		this.addCommand({
			id: 'run-workflow',
			name: 'Workflow: Run workflow...',
			callback: () => {
				new WorkflowModal(this.app, this).open();
			},
		});

		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (file instanceof TFile) {
				void this.captureRelatedNotesContext().then(() => {
					this.queueRelatedNotesRefresh(0);
				});
				return;
			}
			this.queueRelatedNotesRefresh(150);
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
			if (leaf?.view instanceof MarkdownView) {
				this.lastMarkdownLeaf = leaf;
				void this.captureRelatedNotesContext(leaf.view).then(() => {
					this.queueRelatedNotesRefresh(0);
				});
			}
		}));

		this.addCommand({
			id: "summarize-selected-text",
			name: "Text: Summarize",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					void processText(
						selectedText,
						"Summarize the following text concisely. Preserve markdown formatting:",
						this
					);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "makeitprof-selected-text",
			name: "Text: Make professional",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					void processText(
						selectedText,
						"Rewrite the following text to be more professional and polished. Preserve markdown formatting:",
						this
					);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "actionitems-selected-text",
			name: "Text: Generate action items",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					void processText(
						selectedText,
						"Generate a clear list of action items from the following text. Use bullet points or numbers as appropriate:",
						this
					);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "custom-selected-text",
			name: "Text: Run custom prompt",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				new Notice("Custom prompt: " + this.settings.customPrompt);
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					void processText(
						selectedText,
						this.settings.customPrompt,
						this
					);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "gentext-selected-text",
			name: "Text: Use as prompt",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					void processText(
						selectedText,
						"Respond to the following prompt:",
						this
					);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "edit-with-prompt",
			name: "Text: Edit with prompt...",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const selectedText = this.getSelectedText();
				if (selectedText.length === 0) {
					new Notice("Please select some text first");
					return;
				}
				new PromptPickerModal(this.app, (prompt: string) => {
					this.isKillSwitchActive = false;
					void processText(selectedText, prompt, this);
				}).open();
			},
		});

		this.addCommand({
			id: "select-custom-prompt",
			name: "Text: Run saved prompt...",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const prompts = this.settings.customPrompts || [];
				if (prompts.length === 0) {
					new Notice("No saved prompts yet. Add some in settings.");
					return;
				}
				const selectedText = this.getSelectedText();
				if (selectedText.length === 0) {
					new Notice("Please select some text first");
					return;
				}
				new SelectPromptModal(this.app, prompts, (chosen) => {
					this.isKillSwitchActive = false;
					new Notice("Running: " + chosen.title);
					void processText(selectedText, chosen.prompt, this);
				}).open();
			},
		});

		this.addCommand({
			id: "llm-chat",
			name: "Chat: General",
			callback: () => {
				void this.openChatView({ mode: "general" });
			},
		});

		this.addCommand({
			id: "llm-chat-popup",
			name: "Chat: General (popup)",
			callback: () => {
				const chatModal = new LLMChatModal(this.app, this);
				chatModal.open();
			},
		});

		this.addCommand({
			id: "rag-chat-popup",
			name: "Chat: Notes (RAG popup)",
			callback: () => {
				new RAGChatModal(this.app, this.settings, this.ragManager, this).open();
			},
		});

		this.addCommand({
			id: "llm-hashtag",
			name: "Text: Generate tags",
			callback: () => {
				void generateAndAppendTags(this.app, this.settings);
			},
		});

		this.addCommand({
			id: "web-search-selected-text",
			name: "Web: Search",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false;
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					void processWebSearch(selectedText, this);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "web-news-search",
			name: "Web: Search news",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					void processNewsSearch(selectedText, this);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addRibbonIcon("brain-cog", "LLM Helper", (event) => {
			const menu = new Menu();

			// === Chat Section ===
			menu.addItem((item) =>
				item
					.setTitle("Chat")
					.setIcon("messages-square")
					.onClick(() => {
						void this.openChatView({ mode: "general" });
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Chat with notes (RAG)")
					.setIcon("book-open")
					.onClick(() => {
						this.openRAGChat();
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Chat with current note")
					.setIcon("file-text")
					.onClick(() => {
						const file = this.getActiveMarkdownFile();
						if (!file) {
							new Notice("Open a note first.");
							return;
						}
						this.openRAGChat({
							mode: 'paths',
							paths: [file.path],
							label: file.basename
						});
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Chat with current folder")
					.setIcon("folder-open")
					.onClick(() => {
						const file = this.getActiveMarkdownFile();
						if (!file) {
							new Notice("Open a note first.");
							return;
						}
						this.openRAGChat({
							mode: 'folder',
							folder: this.getFolderPath(file),
							label: this.getFolderPath(file) || 'Vault root'
						});
					})
			);

			menu.addSeparator();

			// === Text Editing Section ===
			menu.addItem((item) =>
				item
					.setTitle("Edit with prompt...")
					.setIcon("wand")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length === 0) {
							new Notice("Please select some text first");
							return;
						}
						new PromptPickerModal(this.app, (prompt: string) => {
							this.isKillSwitchActive = false;
							void processText(selectedText, prompt, this);
						}).open();
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Summarize")
					.setIcon("minimize-2")
					.onClick(async () => {
						this.isKillSwitchActive = false;
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							void processText(
								selectedText,
								"Summarize the following text concisely. Preserve markdown formatting:",
								this
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Make professional")
					.setIcon("briefcase")
					.onClick(async () => {
						this.isKillSwitchActive = false;
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							void processText(
								selectedText,
								"Rewrite the following text to be more professional and polished. Preserve markdown formatting:",
								this
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Generate action items")
					.setIcon("list-todo")
					.onClick(async () => {
						this.isKillSwitchActive = false;
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							void processText(
								selectedText,
								"Generate a clear list of action items from the following text. Use bullet points or numbers as appropriate:",
								this
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Generate tags")
					.setIcon("hash")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							new Notice("Generating tags...");
							void generateAndAppendTags(this.app, this.settings);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Use as prompt")
					.setIcon("lightbulb")
					.onClick(async () => {
						this.isKillSwitchActive = false;
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							void processText(
								selectedText,
								"Respond to the following prompt:",
								this
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Custom prompt")
					.setIcon("pencil")
					.onClick(async () => {
						this.isKillSwitchActive = false;
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							new Notice("Running: " + this.settings.customPrompt);
							void processText(
								selectedText,
								this.settings.customPrompt,
								this
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Run saved prompt...")
					.setIcon("list")
					.onClick(async () => {
						const prompts = this.settings.customPrompts || [];
						if (prompts.length === 0) {
							new Notice("No saved prompts yet. Add some in settings.");
							return;
						}
						const selectedText = this.getSelectedText();
						if (selectedText.length === 0) {
							new Notice("Please select some text first");
							return;
						}
						new SelectPromptModal(this.app, prompts, (chosen) => {
							this.isKillSwitchActive = false;
							new Notice("Running: " + chosen.title);
							void processText(selectedText, chosen.prompt, this);
						}).open();
					})
			);

			menu.addSeparator();

			// === Web Search Section ===
			menu.addItem((item) =>
				item
					.setTitle("Web search")
					.setIcon("globe")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							void processWebSearch(selectedText, this);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("News search")
					.setIcon("newspaper")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							void processNewsSearch(selectedText, this);
						}
					})
			);

			menu.addSeparator();

			// === Utility Section ===
			menu.addItem((item) =>
				item
					.setTitle("Stop generation")
					.setIcon("square")
					.onClick(() => {
						this.isKillSwitchActive = true;
						new Notice("Generation stopped");
					})
			);

			menu.showAtMouseEvent(event);
		});

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("LLM Helper: Ready");

		this.addSettingTab(new OLLMSettingTab(this.app, this));
	}

	private validateServerConfiguration(): boolean {
		const serverAddress = this.settings.serverAddress;
		const llmModel = this.settings.llmModel;
		const embeddingModel = this.settings.embeddingModelName;
		const embeddingServerAddress = getEffectiveEmbeddingServerAddress(this.settings);

		console.log(`Configuration - Chat server: ${serverAddress}, Embedding server: ${embeddingServerAddress}, LLM: ${llmModel}, Embeddings: ${embeddingModel}`);
		console.log('Using OpenAI-compatible API endpoints (/v1/chat/completions, /v1/embeddings)');

		if (!serverAddress || serverAddress.trim() === '') {
			console.warn('Server address is not configured.');
			return false;
		}

		return true;
	}

	private getSelectedText() {
		let view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("No active view");
			return "";
		} else {
			let view_mode = view.getMode();
			switch (view_mode) {
				case "preview":
					new Notice("Does not work in preview preview");
					return "";
				case "source":
					if ("editor" in view) {
						return view.editor.getSelection();
					}
					break;
				default:
					new Notice("Unknown view mode");
					return "";
			}
		}
		return "";
	}

	private getActiveMarkdownFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) {
			this.lastMarkdownLeaf = view.leaf;
			return view.file;
		}

		const lastView = this.lastMarkdownLeaf?.view;
		if (lastView instanceof MarkdownView && lastView.file) {
			return lastView.file;
		}

		return this.app.workspace.getActiveFile();
	}

	private getFolderPath(file: TFile): string {
		const lastSlashIndex = file.path.lastIndexOf('/');
		return lastSlashIndex === -1 ? '' : file.path.slice(0, lastSlashIndex);
	}

	public openRAGChat(initialScope?: RAGQueryScope) {
		void this.openChatView({ mode: "notes", initialScope });
	}

	async openChatView(options: ChatViewOpenOptions = {}): Promise<void> {
		const initialContext = getActiveChatContext(this.app);
		const existingLeaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
		const leaf = existingLeaf || this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Could not open LLM Chat view.");
			return;
		}

		if (!existingLeaf) {
			await leaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
		}
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });

		if (leaf.view instanceof ChatView) {
			leaf.view.applyOpenOptions({
				initialContext,
				focusInput: true,
				...options,
			});
		}
	}

	async activateRelatedNotesView(): Promise<void> {
		await this.captureRelatedNotesContext();
		const context = await this.getRelatedNotesContext();

		const existingLeaf = this.app.workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE)[0];
		const leaf = existingLeaf || this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Could not open Related Notes view.");
			return;
		}

		await leaf.setViewState({
			type: RELATED_NOTES_VIEW_TYPE,
			active: true,
		});
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		await this.refreshRelatedNotesView();

		if (!context) {
			new Notice("Open a note or select text to find related notes.");
			return;
		}
		if (this.ragManager.getIndexedFilesCount() === 0) {
			new Notice("Index your notes first: run Notes: Index notes for RAG.");
			return;
		}
		new Notice("Related Notes opened in the right sidebar.");
	}

	async refreshRelatedNotesView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE);
		if (leaves.length === 0) {
			return;
		}

		const context = await this.getRelatedNotesContext();
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof RelatedNotesView) {
				await view.refresh(context);
			}
		}
	}

	async getRelatedNotesContext(): Promise<RelatedNotesContext | null> {
		const context = await this.buildRelatedNotesContext(this.getRelatedNotesMarkdownView());
		if (context) {
			this.lastRelatedNotesContext = context;
			return context;
		}

		return this.lastRelatedNotesContext;
	}

	async openFileByPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice("Note not found.");
			return;
		}

		const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) || this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	async onunload() {
		if (this.relatedNotesRefreshTimer !== null) {
			window.clearTimeout(this.relatedNotesRefreshTimer);
			this.relatedNotesRefreshTimer = null;
		}
		if (this.autoIndexTimer !== undefined) {
			window.clearTimeout(this.autoIndexTimer);
			this.autoIndexTimer = undefined;
		}
		if (this.ragManager) {
			await this.ragManager.dispose();
		}

	}

	private truncateRelatedQuery(text: string): string {
		const normalized = text.replace(/\s+/g, ' ').trim();
		return normalized.length <= 4000 ? normalized : normalized.slice(0, 4000);
	}

	private queueRelatedNotesRefresh(delayMs: number): void {
		if (this.app.workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE).length === 0) {
			return;
		}

		if (this.relatedNotesRefreshTimer !== null) {
			window.clearTimeout(this.relatedNotesRefreshTimer);
		}

		this.relatedNotesRefreshTimer = window.setTimeout(() => {
			this.relatedNotesRefreshTimer = null;
			void this.refreshRelatedNotesView();
		}, delayMs);
	}

	private async captureRelatedNotesContext(view?: MarkdownView | null): Promise<void> {
		const context = await this.buildRelatedNotesContext(
			view !== undefined ? view : this.getRelatedNotesMarkdownView()
		);
		if (context) {
			this.lastRelatedNotesContext = context;
		}
	}

	private getRelatedNotesMarkdownView(): MarkdownView | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file) {
			this.lastMarkdownLeaf = activeView.leaf;
			return activeView;
		}

		const lastView = this.lastMarkdownLeaf?.view;
		if (lastView instanceof MarkdownView && lastView.file) {
			return lastView;
		}

		return null;
	}

	private async buildRelatedNotesContext(view: MarkdownView | null): Promise<RelatedNotesContext | null> {
		const file = view?.file;
		if (!view || !file) {
			return null;
		}

		const selection = view.getMode() === "source" && "editor" in view
			? view.editor.getSelection().trim()
			: "";
		if (selection.length >= 20) {
			return {
				query: this.truncateRelatedQuery(selection),
				description: `selection in ${file.basename}`,
				sourcePath: file.path
			};
		}

		const rawContent = await this.app.vault.cachedRead(file);
		const cleanedContent = rawContent.trim();
		if (!cleanedContent) {
			return null;
		}

		return {
			query: this.truncateRelatedQuery(cleanedContent),
			description: `current note ${file.basename}`,
			sourcePath: file.path
		};
	}

	startAutoIndexTimer() {
		if (this.autoIndexTimer) {
			window.clearTimeout(this.autoIndexTimer);
			this.autoIndexTimer = undefined;
		}
		const minutes = this.settings.autoIndexIntervalMinutes;
		if (minutes > 0) {
			const scheduleNext = () => {
				this.autoIndexTimer = window.setTimeout(() => {
					const scheduleIfActive = () => {
						if (this.autoIndexTimer !== undefined) {
							scheduleNext();
						}
					};
					void this.runAutoIndex().then(scheduleIfActive, scheduleIfActive);
				}, minutes * 60 * 1000);
			};
			scheduleNext();
		}
	}

	private async runAutoIndex(): Promise<void> {
		if (this.isIndexing) {
			return;
		}
		if (this.settings.autoNotice) {
			new Notice("LLM Helper: Auto-indexing notes...");
		}
		this.isIndexing = true;
		try {
			await this.ragManager.indexNotes(() => {});
			if (this.settings.autoNotice) {
				new Notice("LLM Helper: Auto-index complete.");
			}
		} catch (error) {
			console.error("LLM Helper: Auto-index error:", error);
		} finally {
			this.isIndexing = false;
		}
	}

	async loadSettings() {
		console.log('📂 LLM Helper: Loading plugin settings...');
		const savedData = await this.loadData();
		console.log('💾 LLM Helper: Raw saved data:', savedData);

		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			savedData
		);
		this.settings.workflowDefaults = mergeWorkflowDefaults(savedData?.workflowDefaults);

		this.settings.serverAddress = normalizeServerAddress(this.settings.serverAddress);
		this.settings.embeddingServerAddress = normalizeOptionalServerAddress(this.settings.embeddingServerAddress);
		this.settings.searxngInstanceUrl = normalizeSearxngInstanceUrl(this.settings.searxngInstanceUrl || "");
		this.rebuildPersonas();

		console.log('✅ LLM Helper: Final settings after merge:', {
			provider: this.settings.providerType,
			server: this.settings.serverAddress,
			embeddingServer: getEffectiveEmbeddingServerAddress(this.settings),
			embeddingModel: this.settings.embeddingModelName,
			llmModel: this.settings.llmModel,
			hasApiKey: !!this.settings.openAIApiKey,
			hasEmbeddingApiKey: !!this.settings.embeddingApiKey,
			hasBraveKey: !!this.settings.braveSearchApiKey,
			hasSearxngInstanceUrl: !!this.settings.searxngInstanceUrl
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);

		// Update RAG manager with new settings
		if (this.ragManager) {
			this.ragManager.updateSettings(this.settings);
		}

		this.queueRelatedNotesRefresh(150);
	}

	rebuildPersonas() {
		this.personasDict = buildPersonasDict(this.settings.savedPersonas);
	}

	registerCustomPromptCommands() {
		const prompts = this.settings.customPrompts || [];
		for (const prompt of prompts) {
			this.registerSinglePromptCommand(prompt);
		}
	}

	registerSinglePromptCommand(customPrompt: CustomPrompt) {
		const commandId = `ollm-helper:${customPrompt.id}`;
		this.addCommand({
			id: customPrompt.id,
			name: `Prompt: ${customPrompt.title}`,
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false;
				const selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					new Notice("Running: " + customPrompt.title);
					void processText(selectedText, customPrompt.prompt, this);
				} else {
					new Notice("Please select some text first");
				}
			},
		});
		this.registeredPromptCommands.add(commandId);
	}

	unregisterPromptCommand(id: string) {
		const commandId = `ollm-helper:${id}`;
		(this.app as ObsidianCommandApp).commands.removeCommand(commandId);
		this.registeredPromptCommands.delete(commandId);
	}

	refreshCustomPromptCommands() {
		// Unregister all existing custom prompt commands
		for (const commandId of this.registeredPromptCommands) {
			(this.app as ObsidianCommandApp).commands.removeCommand(commandId);
		}
		this.registeredPromptCommands.clear();

		// Re-register all
		this.registerCustomPromptCommands();
	}


	async indexNotes() {
		if (this.isIndexing) {
			new Notice('Indexing already in progress.');
			console.log("LLM Helper: Skipping manual index, indexing already in progress.");
			return;
		}
		this.isIndexing = true;
		new Notice('Indexing notes for RAG...');
		try {
			await this.ragManager.indexNotes(progress => {
				// You can use the progress value here if needed
				console.log(`Indexing progress: ${progress * 100}%`);
			});
			new Notice('Notes indexed successfully!');
			this.queueRelatedNotesRefresh(150);
		} catch (error) {
			console.error('Error indexing notes:', error);
			new Notice('Failed to index notes. Check console for details.');
		} finally {
			this.isIndexing = false;
		}
	}

	async handleGenerateBacklinks() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			new Notice('No active Markdown view');
			return;
		}

		const editor = activeView.editor;
		const selectedText = editor.getSelection();

		if (!selectedText) {
			new Notice('No text selected');
			return;
		}

		new Notice('Generating backlinks...');
		try {
			const backlinks = await this.backlinkGenerator.generateBacklinks(selectedText);

			if (backlinks.length > 0) {
				editor.replaceSelection(`${selectedText}\n\nRelated:\n${backlinks.join('\n')}`);
				new Notice(`Generated ${backlinks.length} backlinks`);
			} else {
				new Notice('No relevant backlinks found');
			}
		} catch (error) {
			console.error('Error generating backlinks:', error);
			new Notice('Failed to generate backlinks. Check console for details.');
		}
	}

	async handleDiagnostics() {
		console.log('🔍 === RAG STORAGE DIAGNOSTICS ===');
		
		// Plugin settings diagnostics
		console.log('📋 Plugin Settings:');
		console.log('  Provider:', this.settings.providerType);
		console.log('  Chat Server:', this.settings.serverAddress);
		console.log('  Embedding Server:', getEffectiveEmbeddingServerAddress(this.settings));
		console.log('  Embedding Model:', this.settings.embeddingModelName);
		console.log('  LLM Model:', this.settings.llmModel);
		
		// RAG storage diagnostics
		try {
			const stats = await this.ragManager.getStorageStats();
			console.log('💾 RAG Storage Stats:');
			console.log('  Total Embeddings:', stats.totalEmbeddings);
			console.log('  Indexed Sources:', stats.indexedFiles);
			console.log('  Markdown Sources:', stats.sourceCounts.markdown);
			console.log('  PDF Sources:', stats.sourceCounts.pdf);
			console.log('  Image Sources:', stats.sourceCounts.image);
			console.log('  Last Indexed:', stats.lastIndexed);
			console.log('  Storage Used:', stats.storageUsed);
			console.log('  Current Indexed Count:', this.ragManager.getIndexedFilesCount());
			
			new Notice(`RAG Diagnostics: ${stats.totalEmbeddings} embeddings, ${stats.indexedFiles} sources. Check console for details.`);
		} catch (error) {
			console.error('❌ Error getting storage stats:', error);
			new Notice('Error getting storage stats. Check console for details.');
		}
		
		// File system diagnostics
		const totalFiles = this.app.vault.getFiles().length;
		console.log('📁 Vault Stats:');
		console.log('  Total Files:', totalFiles);
		console.log('  Plugin Settings Path:', `${this.manifest.dir}/data.json`);
		console.log('  Embeddings Storage Path:', `${this.manifest.dir}/embeddings.json`);
		
		console.log('🔍 === END DIAGNOSTICS ===');
	}

	async showStorageNotification() {
		try {
			const stats = await this.ragManager.getStorageStats();
			if (stats.totalEmbeddings > 0) {
				new Notice(`📚 Loaded ${stats.totalEmbeddings} embeddings from ${stats.indexedFiles} sources (${stats.storageUsed})`);
			} else {
				new Notice('📝 No previous embeddings found - ready to index notes');
			}
		} catch (error) {
			console.error('Error showing storage notification:', error);
		}
	}
}

async function fetchAvailableModels(settings: OLocalLLMSettings, target: ModelEndpointTarget): Promise<string[]> {
	const apiKey = target === "embedding"
		? getEffectiveEmbeddingApiKey(settings)
		: getChatApiKey(settings);
	const url = target === "embedding"
		? getEmbeddingModelsUrl(settings)
		: getChatModelsUrl(settings);

	const response = await requestUrl({
		url,
		method: "GET",
		headers: buildOpenAIHeaders(apiKey),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Server returned ${response.status}`);
	}

	const data = response.json as ModelListResponse;
	if (!data?.data || !Array.isArray(data.data)) {
		throw new Error("Unexpected response format");
	}

	return data.data
		.map((model) => model.id)
		.filter((id): id is string => Boolean(id))
		.sort();
}

class ModelPickerModal extends SuggestModal<string> {
	private models: string[];
	private onChoose: (model: string) => void;

	constructor(app: App, models: string[], onChoose: (model: string) => void) {
		super(app);
		this.models = models;
		this.onChoose = onChoose;
		this.setPlaceholder("Search models...");
	}

	getSuggestions(query: string): string[] {
		const lower = query.toLowerCase();
		return this.models.filter(m => m.toLowerCase().includes(lower));
	}

	renderSuggestion(model: string, el: HTMLElement) {
		el.createEl("div", { text: model });
	}

	onChooseSuggestion(model: string) {
		this.onChoose(model);
	}
}

class OLLMSettingTab extends PluginSettingTab {
	plugin: OLocalLLMPlugin;
	private indexingProgressBar: HTMLProgressElement | null = null;
	private indexedFilesCountSetting: Setting | null = null;
	private saveTimeout: number | null = null;

	constructor(app: App, plugin: OLocalLLMPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Debounced save to prevent lag when typing
	private debouncedSave() {
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
		}
		this.saveTimeout = window.setTimeout(() => {
			void this.plugin.saveSettings();
		}, 500);
	}

	// Flush any pending debounced save when settings tab is closed
	hide() {
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
			void this.plugin.saveSettings();
		}
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// ═══════════════════════════════════════════════════════════
		// CONNECTION
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Connection");

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("All providers use OpenAI-compatible API format")
			.addDropdown(dropdown =>
				dropdown
					.addOption('ollama', 'Ollama')
					.addOption('openai', 'OpenAI / LM Studio / vLLM')
					.setValue(this.plugin.settings.providerType)
					.onChange(async (value: 'ollama' | 'openai') => {
						this.plugin.settings.providerType = value;
						if (value === 'ollama' && this.plugin.settings.serverAddress.includes('1234')) {
							this.plugin.settings.serverAddress = 'http://localhost:11434';
						} else if (value === 'openai' && this.plugin.settings.serverAddress.includes('11434')) {
							this.plugin.settings.serverAddress = 'http://localhost:1234';
						}
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Chat/default server URL")
			.setDesc("Used for chat and as the embedding fallback. Ollama: localhost:11434 | LM Studio: localhost:1234 | vLLM: localhost:8000")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:11434")
					.setValue(this.plugin.settings.serverAddress)
					.onChange((value) => {
						this.plugin.settings.serverAddress = normalizeServerAddress(value);
						this.debouncedSave();
					})
			);

		if (this.plugin.settings.providerType === 'openai') {
			new Setting(containerEl)
				.setName("Chat/default API key")
				.setDesc("Required for OpenAI. Embeddings inherit this unless an embedding API key is set. For local servers, use 'not-needed'")
				.addText(text => text
					.setPlaceholder("not-needed")
					.setValue(this.plugin.settings.openAIApiKey || '')
					.onChange((value) => {
						this.plugin.settings.openAIApiKey = value;
						this.debouncedSave();
					})
				);
		}

		new Setting(containerEl)
			.setName("Embedding server URL")
			.setDesc("Optional. Leave blank to use the chat/default server. Use this for a separate OpenAI-compatible embedding server.")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:8081")
					.setValue(this.plugin.settings.embeddingServerAddress || "")
					.onChange((value) => {
						this.plugin.settings.embeddingServerAddress = normalizeOptionalServerAddress(value);
						this.debouncedSave();
					})
			);

		new Setting(containerEl)
			.setName("Embedding API key")
			.setDesc("Optional. Leave blank to inherit the chat/default API key. Use 'not-needed' to send no Authorization header.")
			.addText((text) =>
				text
					.setPlaceholder("inherit chat/default key")
					.setValue(this.plugin.settings.embeddingApiKey || "")
					.onChange((value) => {
						this.plugin.settings.embeddingApiKey = value.trim();
						this.debouncedSave();
					})
			);

		// ═══════════════════════════════════════════════════════════
		// MODELS
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Models");

		let chatModelText: TextComponent;
		new Setting(containerEl)
			.setName("Chat model")
			.setDesc("Model for chat and text processing — type a name or browse from server")
			.addText((text) => {
				chatModelText = text;
				text
					.setPlaceholder("llama3")
					.setValue(this.plugin.settings.llmModel)
					.onChange((value) => {
						this.plugin.settings.llmModel = value;
						this.debouncedSave();
					});
			})
			.addButton(btn => btn
				.setButtonText("Browse")
				.onClick(async () => {
					try {
						btn.setDisabled(true);
						btn.setButtonText("Loading...");
						const models = await fetchAvailableModels(this.plugin.settings, "chat");
						if (models.length === 0) {
							new Notice("No models found on server");
							return;
						}
						new ModelPickerModal(this.app, models, (model) => {
							this.plugin.settings.llmModel = model;
							chatModelText.setValue(model);
							void this.plugin.saveSettings();
						}).open();
					} catch (e) {
						console.error("Failed to fetch models:", e);
						new Notice("Could not fetch models. Check server URL and connection.");
					} finally {
						btn.setDisabled(false);
						btn.setButtonText("Browse");
					}
				}));

		let embeddingModelText: TextComponent;
		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc("Model for RAG indexing — type a name or browse from server")
			.addText((text) => {
				embeddingModelText = text;
				text
					.setPlaceholder("mxbai-embed-large")
					.setValue(this.plugin.settings.embeddingModelName)
					.onChange((value) => {
						this.plugin.settings.embeddingModelName = value;
						this.debouncedSave();
					});
			})
			.addButton(btn => btn
				.setButtonText("Browse")
				.onClick(async () => {
					try {
						btn.setDisabled(true);
						btn.setButtonText("Loading...");
						const models = await fetchAvailableModels(this.plugin.settings, "embedding");
						if (models.length === 0) {
							new Notice("No models found on server");
							return;
						}
						new ModelPickerModal(this.app, models, (model) => {
							this.plugin.settings.embeddingModelName = model;
							embeddingModelText.setValue(model);
							void this.plugin.saveSettings();
						}).open();
					} catch (e) {
						console.error("Failed to fetch models:", e);
						new Notice("Could not fetch models. Check server URL and connection.");
					} finally {
						btn.setDisabled(false);
						btn.setButtonText("Browse");
					}
				}));

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("0 = deterministic, 1 = creative")
			.addText((text) =>
				text
					.setPlaceholder("0.7")
					.setValue(this.plugin.settings.temperature.toString())
					.onChange((value) => {
						const parsedValue = parseFloat(value);
						if (!isNaN(parsedValue) && parsedValue >= 0 && parsedValue <= 1) {
							this.plugin.settings.temperature = parsedValue;
							this.debouncedSave();
						}
					})
			);

		new Setting(containerEl)
			.setName("Max tokens")
			.setDesc("Maximum response length (typically 1-4000)")
			.addText((text) =>
				text
					.setPlaceholder("1024")
					.setValue(this.plugin.settings.maxTokens.toString())
					.onChange((value) => {
						const parsedValue = parseInt(value);
						if (!isNaN(parsedValue) && parsedValue >= 0) {
							this.plugin.settings.maxTokens = parsedValue;
							this.debouncedSave();
						}
					})
			);

		// ═══════════════════════════════════════════════════════════
		// CHAT
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Chat");

		new Setting(containerEl)
			.setName("Persona")
			.setDesc("AI personality for responses")
			.addDropdown(dropdown => {
				for (const key in this.plugin.personasDict) {
					dropdown.addOption(key, this.plugin.personasDict[key].displayName);
				}
				dropdown.setValue(this.plugin.settings.personas)
					.onChange(async (value) => {
						this.plugin.settings.personas = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		// Show/edit system prompt for selected persona
		const selectedPersonaKey = this.plugin.settings.personas;
		const selectedPersona = this.plugin.personasDict[selectedPersonaKey];
		if (selectedPersona && selectedPersonaKey !== "default") {
			new Setting(containerEl)
				.setName("System prompt")
				.setDesc("Edit the system prompt for this persona");

			const promptTextarea = containerEl.createEl("textarea", {
				cls: "persona-prompt-textarea",
				attr: { rows: "4", style: "width: 100%; font-family: monospace; font-size: 0.85em; margin-bottom: 8px;" }
			});
			promptTextarea.value = selectedPersona.systemPrompt;

			new Setting(containerEl)
				.addButton(btn => btn
					.setButtonText("Save persona prompt")
					.onClick(async () => {
						const saved = this.plugin.settings.savedPersonas || {};
						saved[selectedPersonaKey] = {
							displayName: selectedPersona.displayName,
							systemPrompt: promptTextarea.value,
						};
						this.plugin.settings.savedPersonas = saved;
						this.plugin.rebuildPersonas();
						await this.plugin.saveSettings();
						new Notice("Persona prompt saved");
					}));
		}

		// Create new persona
		const newPersonaContainer = containerEl.createDiv({ cls: "new-persona-container" });
		const newNameInput = newPersonaContainer.createEl("input", {
			attr: { type: "text", placeholder: "New persona name", style: "width: 100%; margin-bottom: 4px;" }
		});
		const newPromptInput = newPersonaContainer.createEl("textarea", {
			attr: { placeholder: "System prompt for new persona", rows: "3", style: "width: 100%; font-family: monospace; font-size: 0.85em; margin-bottom: 4px;" }
		});
		const isBuiltInPersona = selectedPersonaKey in DEFAULT_PERSONAS;

		new Setting(newPersonaContainer)
			.addButton(btn => btn
				.setButtonText("Add persona")
				.onClick(async () => {
					const name = newNameInput.value.trim();
					const prompt = newPromptInput.value.trim();
					if (!name) { new Notice("Please enter a persona name"); return; }
					if (!prompt) { new Notice("Please enter a system prompt"); return; }
					const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
					if (!key) { new Notice("Invalid persona name"); return; }
					const saved = this.plugin.settings.savedPersonas || {};
					saved[key] = { displayName: name, systemPrompt: prompt + "\n\n" };
					this.plugin.settings.savedPersonas = saved;
					this.plugin.rebuildPersonas();
					await this.plugin.saveSettings();
					new Notice(`Persona "${name}" added`);
					this.display();
				}))
			.addButton(btn => btn
				.setButtonText("Delete selected persona")
				.setWarning()
				.setDisabled(selectedPersonaKey === "default" || isBuiltInPersona && !this.plugin.settings.savedPersonas?.[selectedPersonaKey])
				.onClick(async () => {
					if (isBuiltInPersona) {
						new Notice("Cannot delete a built-in persona");
						return;
					}
					const saved = this.plugin.settings.savedPersonas || {};
					delete saved[selectedPersonaKey];
					this.plugin.settings.savedPersonas = saved;
					this.plugin.settings.personas = "default";
					this.plugin.rebuildPersonas();
					await this.plugin.saveSettings();
					new Notice("Persona deleted");
					this.display();
				}))
			.addButton(btn => btn
				.setButtonText("Restore defaults")
				.onClick(async () => {
					this.plugin.settings.savedPersonas = undefined;
					this.plugin.rebuildPersonas();
					await this.plugin.saveSettings();
					new Notice("Personas restored to defaults");
					this.display();
				}));

		new Setting(containerEl)
			.setName("Conversation history")
			.setDesc("Number of previous messages to include (0-3)")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("0", "0")
					.addOption("1", "1")
					.addOption("2", "2")
					.addOption("3", "3")
					.setValue(this.plugin.settings.maxConvHistory.toString())
					.onChange(async (value) => {
						this.plugin.settings.maxConvHistory = parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Render markdown in chat")
			.setDesc("Render assistant responses in chat views with Obsidian's Markdown renderer. Turn this off to keep plain escaped text.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.renderMarkdownInChat)
					.onChange(async (value) => {
						this.plugin.settings.renderMarkdownInChat = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Vault Actions")
			.setDesc("Allow chat to propose note writes for manual approval. No note is changed until you approve the action card.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableVaultActions)
					.onChange(async (value) => {
						this.plugin.settings.enableVaultActions = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show Vault Actions debug JSON")
			.setDesc("Show raw <vault-actions> JSON in chat responses for troubleshooting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showAgentDebug)
					.onChange(async (value) => {
						this.plugin.settings.showAgentDebug = value;
						await this.plugin.saveSettings();
					})
			);

		this.addHeading(containerEl, "Workflow Automation");

		containerEl.createEl("p", {
			text: "Manual workflow recipes draft note changes from RAG context and still require approval before writing.",
			cls: "setting-item-description",
		});

		this.renderWorkflowDefaultsSetting(containerEl, "weekly-review", "Weekly review");
		this.renderWorkflowDefaultsSetting(containerEl, "meeting-notes-to-tasks", "Meeting notes to tasks");
		this.renderWorkflowDefaultsSetting(containerEl, "project-status-summary", "Project status summary");

		// ═══════════════════════════════════════════════════════════
		// OUTPUT
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Output");

		new Setting(containerEl)
			.setName("Streaming")
			.setDesc("Request streamed responses from the server. Obsidian buffers the final result before inserting it.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.stream)
					.onChange(async (value) => {
						this.plugin.settings.stream = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Output mode")
			.setDesc("How to insert generated text")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("replace", "Replace selected text")
					.addOption("append", "Append after selected text")
					.setValue(this.plugin.settings.outputMode)
					.onChange(async (value) => {
						this.plugin.settings.outputMode = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Response formatting")
			.setDesc("Wrap response in custom text (e.g., code blocks)")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.responseFormatting)
					.onChange(async (value) => {
						this.plugin.settings.responseFormatting = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.responseFormatting) {
			new Setting(containerEl)
				.setName("Prepend text")
				.setDesc("Text before response")
				.addText((text) =>
					text
						.setPlaceholder("``` LLM Helper\n\n")
						.setValue(this.plugin.settings.responseFormatPrepend)
						.onChange((value) => {
							this.plugin.settings.responseFormatPrepend = value;
							this.debouncedSave();
						})
				);

			new Setting(containerEl)
				.setName("Append text")
				.setDesc("Text after response")
				.addText((text) =>
					text
						.setPlaceholder("\n\n```")
						.setValue(this.plugin.settings.responseFormatAppend)
						.onChange((value) => {
							this.plugin.settings.responseFormatAppend = value;
							this.debouncedSave();
						})
				);
		}

		// Reasoning extraction
		new Setting(containerEl)
			.setName("Extract reasoning")
			.setDesc("Strip <think>, <reasoning>, <thought> blocks from output (useful for Qwen, DeepSeek)")
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.extractReasoningResponses ?? false)
					.onChange(async (value) => {
						this.plugin.settings.extractReasoningResponses = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.extractReasoningResponses) {
			const markersTextarea = containerEl.createEl("textarea", {
				attr: {
					rows: "6",
					style: "width: 100%; font-family: monospace; font-size: 0.85em; margin-bottom: 8px;",
					placeholder: 'JSON array of {start, end} marker pairs'
				}
			});
			markersTextarea.value = this.plugin.settings.reasoningMarkers
				|| JSON.stringify(DEFAULT_REASONING_MARKERS, null, 2);

			new Setting(containerEl)
				.setName("Reasoning markers")
				.setDesc("JSON array of marker pairs to strip from responses")
				.addButton(btn => btn
					.setButtonText("Save markers")
					.onClick(async () => {
						const parsed = parseReasoningMarkers(markersTextarea.value);
						this.plugin.settings.reasoningMarkers = JSON.stringify(parsed, null, 2);
						await this.plugin.saveSettings();
						new Notice("Reasoning markers saved");
					}));
		}

		// ═══════════════════════════════════════════════════════════
		// CUSTOM PROMPT
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Custom Prompt");

		new Setting(containerEl)
			.setName("Your prompt")
			.setDesc("Used by 'Text: Run custom prompt' command")
			.addText((text) =>
				text
					.setPlaceholder("Create action items from the following:")
					.setValue(this.plugin.settings.customPrompt)
					.onChange((value) => {
						this.plugin.settings.customPrompt = value;
						this.debouncedSave();
					})
			);

		// ═══════════════════════════════════════════════════════════
		// SAVED PROMPTS
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Saved Prompts");

		const savedPrompts = this.plugin.settings.customPrompts || [];

		if (savedPrompts.length > 0) {
			for (const sp of savedPrompts) {
				new Setting(containerEl)
					.setName(sp.title)
					.setDesc(sp.prompt.length > 80 ? sp.prompt.substring(0, 80) + "..." : sp.prompt)
					.addButton(btn => btn
						.setButtonText("Edit")
						.onClick(() => {
							new EditPromptModal(this.app, sp, (updated) => {
								void (async () => {
									sp.title = updated.title;
									sp.prompt = updated.prompt;
									sp.updatedAt = Date.now();
									// Regenerate ID if title changed
									sp.id = generatePromptId(updated.title);
									this.plugin.refreshCustomPromptCommands();
									await this.plugin.saveSettings();
									new Notice("Prompt updated");
									this.display();
								})();
							}).open();
						}))
					.addButton(btn => btn
						.setButtonText("Delete")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.customPrompts = savedPrompts.filter(p => p.id !== sp.id);
							this.plugin.unregisterPromptCommand(sp.id);
							await this.plugin.saveSettings();
							new Notice("Prompt deleted");
							this.display();
						}));
			}
		} else {
			containerEl.createEl("p", {
				text: "No saved prompts yet. Add one below.",
				cls: "setting-item-description"
			});
		}

		// Add new prompt form
		const newPromptContainer = containerEl.createDiv({ cls: "new-prompt-container" });
		const newTitleInput = newPromptContainer.createEl("input", {
			attr: { type: "text", placeholder: "Prompt title (e.g., Translate to Spanish)", style: "width: 100%; margin-bottom: 4px;" }
		});
		const newPromptTextarea = newPromptContainer.createEl("textarea", {
			attr: { placeholder: "Prompt text (e.g., Translate the following text to Spanish:)", rows: "3", style: "width: 100%; font-family: monospace; font-size: 0.85em; margin-bottom: 4px;" }
		});

		new Setting(newPromptContainer)
			.addButton(btn => btn
				.setButtonText("Add prompt")
				.setCta()
				.onClick(async () => {
					const title = newTitleInput.value.trim();
					const prompt = newPromptTextarea.value.trim();
					if (!title) { new Notice("Please enter a title"); return; }
					if (!prompt) { new Notice("Please enter a prompt"); return; }
					const now = Date.now();
					const newPrompt: CustomPrompt = {
						id: generatePromptId(title),
						title,
						prompt,
						createdAt: now,
						updatedAt: now,
					};
					if (!this.plugin.settings.customPrompts) {
						this.plugin.settings.customPrompts = [];
					}
					this.plugin.settings.customPrompts.push(newPrompt);
					this.plugin.registerSinglePromptCommand(newPrompt);
					await this.plugin.saveSettings();
					new Notice(`Prompt "${title}" saved`);
					this.display();
				}));

		// ═══════════════════════════════════════════════════════════
		// NOTES INDEX (RAG)
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Notes Index (RAG)");
		
		// Top K
		new Setting(containerEl)
			.setName("RAG Top K")
			.setDesc("Number of relevant note chunks to send to the AI")
			.addText((text) => {
				text.inputEl.type = "number"
				text.inputEl.min = "1";
				text
					.setValue(this.plugin.settings.ragTopK.toString())
					.onChange(async (value) => {
						const numValue = parseInt(value);
						if (!isNaN(numValue)) {
							this.plugin.settings.ragTopK = Math.max(1, numValue);
							await this.plugin.saveSettings();
						}
					})
			});

		// Auto-index interval
		new Setting(containerEl)
			.setName("Auto-index interval (minutes)")
			.setDesc("Automatically re-index notes every N minutes using your configured embedding server. Set to 0 to disable.")
			.addText((text) => text
				.setPlaceholder("0")
				.setValue(String(this.plugin.settings.autoIndexIntervalMinutes))
				.onChange(async (value) => {
					const parsed = parseInt(value);
					this.plugin.settings.autoIndexIntervalMinutes = isNaN(parsed) || parsed < 0 ? 0 : parsed;
					await this.plugin.saveSettings();
					this.plugin.startAutoIndexTimer();
				})
			);

		new Setting(containerEl)
			.setName("Auto Index Notification")
			.setDesc("Show a notification when auto indexing")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoNotice)
					.onChange(async (value) => {
						this.plugin.settings.autoNotice = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Index PDF attachments")
			.setDesc("Include PDF files in the searchable index using built-in text extraction.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.indexPdfAttachments)
					.onChange(async (value) => {
						this.plugin.settings.indexPdfAttachments = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("OCR image attachments")
			.setDesc("Use local OCR to index supported image attachments like PNG, JPG, WebP, GIF, and BMP.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ocrImageAttachments)
					.onChange(async (value) => {
						this.plugin.settings.ocrImageAttachments = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("OCR scanned PDFs")
			.setDesc("Run local OCR on PDF pages that do not contain extractable text.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ocrScannedPdfAttachments)
					.onChange(async (value) => {
						this.plugin.settings.ocrScannedPdfAttachments = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Index sources")
			.setDesc("Build a searchable index of notes and supported attachments in your vault")
			.addButton(button => button
				.setButtonText("Start indexing")
				.onClick(async () => {
					button.setDisabled(true);
					this.indexingProgressBar = containerEl.createEl("progress", {
						attr: { value: 0, max: 100 }
					});
					const counterEl = containerEl.createEl("span", {
						text: "Processing: 0/?",
						cls: "indexing-counter"
					});

					const totalFiles = this.plugin.ragManager.getEligibleSourceCount();
					let processedFiles = 0;

					try {
						await this.plugin.ragManager.indexNotes((progress) => {
							if (this.indexingProgressBar) {
								this.indexingProgressBar.value = progress * 100;
							}
							processedFiles = Math.floor(progress * totalFiles);
							counterEl.textContent = `   Processing sources: ${processedFiles}/${totalFiles}`;
							counterEl.addClass("indexing-counter-small");
						});
						new Notice("Indexing complete!");
						this.updateIndexedFilesCount();
					} catch (error) {
						console.error("Indexing error:", error);
						new Notice("Error during indexing. Check console for details.");
					} finally {
						button.setDisabled(false);
						if (this.indexingProgressBar) {
							this.indexingProgressBar.remove();
							this.indexingProgressBar = null;
						}
						counterEl.remove();
					}
				}));

		this.indexedFilesCountSetting = new Setting(containerEl)
			.setName("Indexed sources")
			.setDesc("Number of notes and attachments in the current index")
			.addText(text => text
				.setValue("Loading...")
				.setDisabled(true));

		void this.updateIndexedFilesCountAsync();

		new Setting(containerEl)
			.setName("Diagnostics")
			.setDesc("Check index storage status")
			.addButton(button => button
				.setButtonText("Run diagnostics")
				.onClick(async () => {
					await this.plugin.handleDiagnostics();
				}));

		// ═══════════════════════════════════════════════════════════
		// INTEGRATIONS
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "Integrations");

		const searchApiKeyContainer = containerEl.createDiv();

		const renderSearchApiKey = () => {
			searchApiKeyContainer.empty();
			if (this.plugin.settings.searchProvider === "brave") {
				new Setting(searchApiKeyContainer)
					.setName("Brave Search API key")
					.setDesc("Required for web search features")
					.addText((text) =>
						text
							.setPlaceholder("Enter API key")
							.setValue(this.plugin.settings.braveSearchApiKey)
							.onChange((value) => {
								this.plugin.settings.braveSearchApiKey = value;
								this.debouncedSave();
							})
					);
			} else if (this.plugin.settings.searchProvider === "searxng") {
				new Setting(searchApiKeyContainer)
					.setName("SearXNG instance URL")
					.setDesc("Required for SearXNG search. The instance must have JSON output enabled under search.formats.")
					.addText((text) =>
						text
							.setPlaceholder("https://search.example.com")
							.setValue(this.plugin.settings.searxngInstanceUrl)
							.onChange((value) => {
								this.plugin.settings.searxngInstanceUrl = value.trim();
								this.debouncedSave();
							})
					);
			} else {
				new Setting(searchApiKeyContainer)
					.setName("Tavily API key")
					.setDesc("Required for web search features (tavily.com)")
					.addText((text) =>
						text
							.setPlaceholder("Enter API key")
							.setValue(this.plugin.settings.tavilyApiKey)
							.onChange((value) => {
								this.plugin.settings.tavilyApiKey = value;
								this.debouncedSave();
							})
					);
			}
		};

		new Setting(containerEl)
			.setName("Search provider")
			.setDesc("Choose which search API to use for web and news search")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("tavily", "Tavily")
					.addOption("brave", "Brave")
					.addOption("searxng", "SearXNG")
					.setValue(this.plugin.settings.searchProvider)
					.onChange((value) => {
						this.plugin.settings.searchProvider = value;
						this.debouncedSave();
						renderSearchApiKey();
					})
			);

		renderSearchApiKey();

		// ═══════════════════════════════════════════════════════════
		// ABOUT
		// ═══════════════════════════════════════════════════════════
		this.addHeading(containerEl, "About");

		new Setting(containerEl)
			.setName("Version")
			.setDesc(`Local LLM Helper v${this.plugin.manifest.version}`)
			.addButton(btn => btn
				.setButtonText("View changelog")
				.onClick(() => {
					new UpdateNoticeModal(this.app, this.plugin.manifest.version).open();
				}));
	}

	private renderWorkflowDefaultsSetting(containerEl: HTMLElement, recipeId: keyof WorkflowDefaults["recipes"], label: string) {
		const defaults = this.plugin.settings.workflowDefaults.recipes[recipeId];
		this.addHeading(containerEl, label);

		new Setting(containerEl)
			.setName("Default source scope")
			.setDesc(`Saved default scope for ${label.toLowerCase()}`)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("vault", "Entire vault")
					.addOption("current-note", "Current note")
					.addOption("current-folder", "Current folder")
					.addOption("tag", "Tag")
					.setValue(defaults.scopeOption)
					.onChange(async (value) => {
						defaults.scopeOption = value as typeof defaults.scopeOption;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default tags")
			.setDesc("Only used when the default source scope is Tag")
			.addText((text) =>
				text
					.setPlaceholder("#project")
					.setValue(defaults.tagValue)
					.onChange((value) => {
						defaults.tagValue = value;
						this.debouncedSave();
					})
			);

		if (recipeId === "weekly-review") {
			new Setting(containerEl)
				.setName("Output folder")
				.setDesc("Folder used for the new weekly review note")
				.addText((text) =>
					text
						.setPlaceholder("Reviews")
						.setValue(defaults.outputFolder)
						.onChange((value) => {
							defaults.outputFolder = value;
							this.debouncedSave();
						})
				);

			new Setting(containerEl)
				.setName("Title template")
				.setDesc("Use YYYY-MM-DD for the local date")
				.addText((text) =>
					text
						.setPlaceholder("Weekly Review - YYYY-MM-DD")
						.setValue(defaults.titleTemplate)
						.onChange((value) => {
							defaults.titleTemplate = value || "Weekly Review - YYYY-MM-DD";
							this.debouncedSave();
						})
				);
			return;
		}

		new Setting(containerEl)
			.setName("Target note")
			.setDesc("Default note to append workflow output into")
			.addText((text) =>
				text
					.setPlaceholder("Projects/Current Project.md")
					.setValue(defaults.targetNote)
					.onChange((value) => {
						defaults.targetNote = value;
						this.debouncedSave();
					})
			);
	}

	updateIndexedFilesCount() {
		if (this.indexedFilesCountSetting) {
			const textComponent = this.indexedFilesCountSetting.components[0] as TextComponent;
			textComponent.setValue(this.plugin.ragManager.getIndexedFilesCount().toString());
		}
	}

	async updateIndexedFilesCountAsync() {
		// Wait for RAGManager to be fully initialized
		const checkAndUpdate = () => {
			if (this.plugin.ragManager && this.plugin.ragManager.isInitialized()) {
				this.updateIndexedFilesCount();
				console.log('📊 Settings: Updated indexed files count to', this.plugin.ragManager.getIndexedFilesCount());
			} else {
				// Check again in 100ms
				window.setTimeout(checkAndUpdate, 100);
			}
		};
		
		// Start checking after a short delay
		window.setTimeout(checkAndUpdate, 50);
	}

	private addHeading(containerEl: HTMLElement, name: string): void {
		new Setting(containerEl).setName(name).setHeading();
	}
}

interface ChatCompletionResponse {
	choices: Array<{
		message: {
			content: string;
			reasoning?: string;
		};
	}>;
}

interface StreamedChatCompletionChunk {
	choices?: Array<{
		delta?: {
			content?: string;
		};
		message?: {
			content?: string;
		};
	}>;
}

interface ModelListResponse {
	data: Array<{ id?: string }>;
}

interface TavilySearchResult {
	title: string;
	content: string;
	url: string;
}

interface TavilySearchResponse {
	results: TavilySearchResult[];
}

interface BraveWebResult {
	title: string;
	description: string;
	url: string;
	extra_snippets?: string[];
}

interface BraveNewsResult {
	title: string;
	description: string;
	url: string;
	published_time?: string;
}

interface SearxngSearchResult {
	title?: string;
	content?: string;
	url?: string;
	engines?: string[];
	publishedDate?: string;
	published_date?: string;
}

interface SearxngSearchResponse {
	results?: SearxngSearchResult[];
	answers?: Array<{ answer?: string; url?: string; engine?: string } | string>;
	suggestions?: string[];
	error?: string;
}

interface ObsidianCommandApp extends App {
	commands: {
		removeCommand(id: string): void;
	};
}

function buildChatHeaders(plugin: OLocalLLMPlugin): Record<string, string> {
	return buildOpenAIHeaders(getChatApiKey(plugin.settings));
}

function parseStreamedChatCompletion(responseText: string): string {
	const chunks: string[] = [];
	for (const line of responseText.split("\n")) {
		const trimmedLine = line.trim();
		if (!trimmedLine || !trimmedLine.startsWith("data:")) {
			continue;
		}
		const payload = trimmedLine.replace(/^data:\s*/, "");
		if (payload === "[DONE]") {
			continue;
		}
		try {
			const data = JSON.parse(payload) as StreamedChatCompletionChunk;
			const content = data.choices?.[0]?.delta?.content;
			if (content) {
				chunks.push(content);
			}
		} catch {
			// Some local servers append keep-alive lines to SSE streams.
		}
	}

	if (chunks.length > 0) {
		return chunks.join("");
	}

	try {
		const data = JSON.parse(responseText) as StreamedChatCompletionChunk;
		return data.choices?.[0]?.message?.content || "";
	} catch {
		return "";
	}
}

async function processText(
	selectedText: string,
	iprompt: string,
	plugin: OLocalLLMPlugin
) {
	// Reset kill switch state at the beginning of each process
	plugin.isKillSwitchActive = false;

	new Notice("Generating response. This takes a few seconds..");
	const statusBarItemEl = activeDocument.querySelector(
		".status-bar .status-bar-item"
	);
	if (statusBarItemEl) {
		statusBarItemEl.textContent = "LLM Helper: Generating response...";
	} else {
		console.error("Status bar item element not found");
	}

	let prompt = modifyPrompt(iprompt, plugin.settings.personas, plugin.personasDict);

	const body = {
		model: plugin.settings.llmModel,
		messages: [
			{ role: "system", content: "You are a helpful writing assistant. Provide clear, concise responses. When editing text, preserve the author's voice unless asked to change it." },
			...plugin.conversationHistory.slice(-plugin.settings.maxConvHistory).reduce((acc, entry) => {
				acc.push({ role: "user", content: entry.prompt });
				acc.push({ role: "assistant", content: entry.response });
				return acc;
			}, [] as { role: string; content: string }[]),
			{ role: "user", content: prompt + ": " + selectedText },
		],
		temperature: plugin.settings.temperature,
		max_tokens: plugin.settings.maxTokens,
		stream: plugin.settings.stream,
	};

	try {
		if (plugin.settings.outputMode === "append") {
			modifySelectedText(selectedText + "\n\n", plugin);
		}
		if (plugin.settings.responseFormatting === true) {
			modifySelectedText(plugin.settings.responseFormatPrepend, plugin);
		}
		if (plugin.settings.stream) {
			const response = await requestUrl({
				url: getChatCompletionsUrl(plugin.settings),
				method: "POST",
				headers: buildChatHeaders(plugin),
				body: JSON.stringify(body),
			});

			if (response.status < 200 || response.status >= 300) {
				if (response.status === 401) {
					throw new Error("Authentication failed (401). Check your API key in plugin settings.");
				}
				throw new Error(
					"Error summarizing text (requestUrl): " + response.text
				);
			}

			let responseStr = parseStreamedChatCompletion(response.text);
			if (plugin.settings.extractReasoningResponses) {
				const markers = parseReasoningMarkers(plugin.settings.reasoningMarkers || '');
				responseStr = extractActualResponse(responseStr, markers);
			}
			updateConversationHistory(prompt + ": " + selectedText, responseStr, plugin.conversationHistory, plugin.settings.maxConvHistory);
			if (!plugin.isKillSwitchActive) {
				modifySelectedText(responseStr, plugin);
				if (plugin.settings.responseFormatting === true) {
					modifySelectedText(plugin.settings.responseFormatAppend, plugin);
				}
				new Notice("Text generation complete. Voila!");
			} else {
				new Notice("Text generation stopped by kill switch");
				plugin.isKillSwitchActive = false;
			}
		} else {
			const response = await requestUrl({
				url: getChatCompletionsUrl(plugin.settings),
				method: "POST",
				headers: buildChatHeaders(plugin),
				body: JSON.stringify(body),
			});

			const statusCode = response.status;

			if (statusCode >= 200 && statusCode < 300) {
				const data = response.json as ChatCompletionResponse;
				let summarizedText = data.choices[0].message.content;

				// Use explicit reasoning field if available
				if (data.choices[0].message.reasoning) {
					summarizedText = data.choices[0].message.content;
				}

				// Strip reasoning markers if enabled
				if (plugin.settings.extractReasoningResponses) {
					const markers = parseReasoningMarkers(plugin.settings.reasoningMarkers || '');
					summarizedText = extractActualResponse(summarizedText, markers);
				}

				updateConversationHistory(prompt + ": " + selectedText, summarizedText, plugin.conversationHistory, plugin.settings.maxConvHistory);
				new Notice("Text generated. Voila!");
				if (!plugin.isKillSwitchActive) {
					if (plugin.settings.responseFormatting === true) {
						modifySelectedText(summarizedText + plugin.settings.responseFormatAppend, plugin);
					} else {
						modifySelectedText(summarizedText, plugin);
					}
				} else {
					new Notice("Text generation stopped by kill switch");
					plugin.isKillSwitchActive = false; // Reset the kill switch
				}
			} else {
				throw new Error(
					"Error summarizing text (requestUrl): " + response.text
				);
			}
		}
	} catch (error) {
		console.error("Error during request:", error);
		const errMsg = error instanceof Error ? error.message : String(error);
		if (errMsg.includes("401") || errMsg.toLowerCase().includes("unauthorized")) {
			new Notice("Authentication failed (401). Check your API key in plugin settings.");
		} else {
			new Notice("Error generating text. Check plugin console for details.");
		}
	}
	if (statusBarItemEl) {
		statusBarItemEl.textContent = "LLM Helper: Ready";
	} else {
		console.error("Status bar item element not found");
	}
}

function modifySelectedText(text: string, plugin: OLocalLLMPlugin) {
	let view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		new Notice("No active view");
	} else {
		let view_mode = view.getMode();
		switch (view_mode) {
			case "preview":
				new Notice("Cannot summarize in preview");
				break;
			case "source":
				if ("editor" in view) {
					view.editor.replaceSelection(text);
				}
				break;
			default:
				new Notice("Unknown view mode");
		}
	}
}

export class LLMChatModal extends Modal {
	result: string = "";
	pluginSettings: OLocalLLMSettings;
	plugin: OLocalLLMPlugin;
	conversationHistory: ConversationEntry[] = [];
	private initialChatContext: ChatEnvironmentContext;
	submitButton: ButtonComponent;

	constructor(app: App, plugin: OLocalLLMPlugin) {
		super(app);
		this.plugin = plugin;
		this.pluginSettings = plugin.settings;
		this.initialChatContext = getActiveChatContext(app);
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.classList.add("llm-chat-modal");

		const chatContainer = contentEl.createDiv({ cls: "llm-chat-container" });
		const chatHistoryEl = chatContainer.createDiv({ cls: "llm-chat-history" });

		chatHistoryEl.classList.add("chatHistoryElStyle");

		// Display existing conversation history (if any)
		chatHistoryEl.createEl("h1", { text: "Chat with your Local LLM" });

		const personasInfoEl = chatHistoryEl.createDiv({ cls: "personasInfoStyle" });
		const currentPersona = this.plugin.personasDict[this.pluginSettings.personas];
		personasInfoEl.setText("Current persona: " + (currentPersona ? currentPersona.displayName : "Default"));

		// Update this part to use conversationHistory
		this.conversationHistory.forEach((entry) => {
			const userMessageEl = chatHistoryEl.createEl("p", { text: "You: " + entry.prompt });
			userMessageEl.classList.add('llmChatMessageStyleUser');
			const aiMessageEl = chatHistoryEl.createEl("p", { text: "LLM Helper: " + entry.response });
			aiMessageEl.classList.add('llmChatMessageStyleAI');
		});

		const inputContainer = contentEl.createDiv({ cls: "llm-chat-input-container" });

		const inputRow = inputContainer.createDiv({ cls: "llm-chat-input-row" });

		inputRow.createSpan({ text: "Ask:", cls: "llm-chat-ask-label" });

		const textInput = new TextComponent(inputRow)
			.setPlaceholder("Type your question here...")
			.onChange((value) => {
				this.result = value;
				this.updateSubmitButtonState();
			});
		textInput.inputEl.classList.add("llm-chat-input");
		textInput.inputEl.addEventListener('keypress', (event) => {
			if (event.key === 'Enter' && this.result.trim() !== "") {
				event.preventDefault();
				void this.handleSubmit();
			}
		});

		this.submitButton = new ButtonComponent(inputRow)
			.setButtonText("Submit")
			.setCta()
			.onClick(() => void this.handleSubmit());
		this.submitButton.buttonEl.classList.add("llm-chat-submit-button");

		// Initially disable the submit button
		this.updateSubmitButtonState();

		// Scroll to bottom initially
		this.scrollToBottom();
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}

	updateSubmitButtonState() {
		if (this.result.trim() === "") {
			this.submitButton.setDisabled(true);
			this.submitButton.buttonEl.classList.add("llm-chat-submit-button-disabled");
		} else {
			this.submitButton.setDisabled(false);
			this.submitButton.buttonEl.classList.remove("llm-chat-submit-button-disabled");
		}
	}

	// New method to handle submission
	async handleSubmit() {
		if (this.result.trim() === "") {
			return;
		}

		const chatHistoryEl = this.contentEl.querySelector('.llm-chat-history');
		if (chatHistoryEl) {
			await processChatInput(
				this.result,
				this.contentEl,
				chatHistoryEl as HTMLElement,
				this.conversationHistory,
				this.plugin,
				this.initialChatContext
			);
			this.result = ""; // Clear user input field
			const textInputEl = this.contentEl.querySelector('.llm-chat-input') as HTMLInputElement;
			if (textInputEl) {
				textInputEl.value = "";
			}
			this.updateSubmitButtonState(); // Disable the button after submission
			this.scrollToBottom();
		}
	}

	scrollToBottom() {
		const chatHistoryEl = this.contentEl.querySelector('.llm-chat-history');
		if (chatHistoryEl) {
			chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
		}
	}
}

async function processChatInput(
	text: string,
	chatContainer: HTMLElement,
	chatHistoryEl: HTMLElement,
	conversationHistory: ConversationEntry[],
	plugin: OLocalLLMPlugin,
	initialChatContext: ChatEnvironmentContext,
) {
	const userMessageEl = chatHistoryEl.createDiv({ cls: "llmChatMessageStyleUser" });
	userMessageEl.setText(text);

	showThinkingIndicator(chatHistoryEl);
	scrollToBottom(chatContainer);

	try {
		const result = await submitGeneralChat(plugin, text, conversationHistory, initialChatContext);

		hideThinkingIndicator(chatHistoryEl);
		const renderedMessage = plugin.vaultAgent.renderAgentResponse(
			chatHistoryEl,
			result.response,
			result.context,
			{
				messageClassName: "llmChatMessageStyleAI",
				scrollToBottom: () => scrollToBottom(chatContainer),
			},
		);
		recordConversationHistory(conversationHistory, text, renderedMessage, plugin.settings.maxConvHistory);
		new Notice("Chat response ready.");
		scrollToBottom(chatContainer);
	} catch (error) {
		console.error("Error during request:", error);
		const errMsg = error instanceof Error ? error.message : String(error);
		if (errMsg.includes("401") || errMsg.toLowerCase().includes("unauthorized")) {
			new Notice("Authentication failed (401). Check your API key in plugin settings.");
		} else {
			new Notice("Error communicating with LLM server. Check plugin console for details.");
		}
		hideThinkingIndicator(chatHistoryEl);
	}
}

function showThinkingIndicator(chatHistoryEl: HTMLElement) {
	const thinkingIndicatorEl = chatHistoryEl.createDiv({ cls: "thinking-indicator" });
	const tStr = ["Calculating the last digit of pi... just kidding",
		"Quantum entanglement engaged... thinking deeply",
		"Reticulating splines... stand by",
		"Consulting the Oracle",
		"Entangling qubits... preparing for a quantum leap",
		"Processing... yada yada yada... almost done",
		"Processing... We're approaching singularity",
		"Serenity now! Patience while we process",
		"Calculating the probability of George getting a date",
		"Asking my man Art Vandalay"];
	// pick a random index between 0 and size of string array above
	const randomIndex = Math.floor(Math.random() * tStr.length);
	thinkingIndicatorEl.createSpan({ text: tStr[randomIndex] });
	const dots = thinkingIndicatorEl.createSpan({ cls: "dots" });
	dots.createSpan({ cls: "dot" });
	dots.createSpan({ cls: "dot" });
	dots.createSpan({ cls: "dot" });
}

function hideThinkingIndicator(chatHistoryEl: HTMLElement) {
	const thinkingIndicatorEl = chatHistoryEl.querySelector('.thinking-indicator');
	if (thinkingIndicatorEl) {
		chatHistoryEl.removeChild(thinkingIndicatorEl);
	}
}

function scrollToBottom(el: HTMLElement) {
	const chatHistoryEl = el.querySelector('.llm-chat-history');
	if (chatHistoryEl) {
		chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
	}
}

function updateConversationHistory(prompt: string, response: string, conversationHistory: ConversationEntry[], maxConvHistoryLength: number) {
	conversationHistory.push({ prompt, response });

	// Limit history length to maxConvHistoryLength
	if (conversationHistory.length > maxConvHistoryLength) {
		conversationHistory.shift();
	}
}


class EditPromptModal extends Modal {
	private prompt: CustomPrompt;
	private onSave: (updated: { title: string; prompt: string }) => void;

	constructor(app: App, prompt: CustomPrompt, onSave: (updated: { title: string; prompt: string }) => void) {
		super(app);
		this.prompt = prompt;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Edit Prompt" });

		const titleInput = contentEl.createEl("input", {
			attr: { type: "text", value: this.prompt.title, style: "width: 100%; margin-bottom: 8px;" }
		});

		const promptTextarea = contentEl.createEl("textarea", {
			attr: { rows: "5", style: "width: 100%; font-family: monospace; font-size: 0.85em; margin-bottom: 8px;" }
		});
		promptTextarea.value = this.prompt.prompt;

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					const title = titleInput.value.trim();
					const prompt = promptTextarea.value.trim();
					if (!title || !prompt) {
						new Notice("Title and prompt are required");
						return;
					}
					this.onSave({ title, prompt });
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText("Cancel")
				.onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

//TODO: kill switch

async function tavilySearch(query: string, topic: string, plugin: OLocalLLMPlugin): Promise<string> {
	const body: {
		query: string;
		topic: string;
		max_results: number;
		search_depth: string;
		include_answer: boolean;
		time_range?: string;
	} = {
		query,
		topic,
		max_results: 5,
		search_depth: "basic",
		include_answer: false,
	};
	if (topic === "news") {
		body.time_range = "day";
	}

	const response = await requestUrl({
		url: "https://api.tavily.com/search",
		method: "POST",
		headers: {
			"Authorization": `Bearer ${plugin.settings.tavilyApiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (response.status !== 200) {
		throw new Error("Tavily search failed: " + response.status);
	}

	const results = (response.json as TavilySearchResponse).results;
	return results.map((result) =>
		`${result.title}\n${result.content}\nSource: ${result.url}\n\n`
	).join('');
}

function buildSearxngSearchUrl(query: string, topic: string, instanceUrl: string): string {
	const normalizedInstanceUrl = normalizeSearxngInstanceUrl(instanceUrl);
	const searchUrl = new URL(normalizedInstanceUrl);
	const basePath = searchUrl.pathname.replace(/\/+$/, '');
	searchUrl.pathname = basePath.endsWith("/search") ? basePath : `${basePath}/search`;
	searchUrl.search = "";
	searchUrl.hash = "";
	searchUrl.searchParams.set("q", query);
	searchUrl.searchParams.set("format", "json");
	if (topic === "news") {
		searchUrl.searchParams.set("categories", "news");
		searchUrl.searchParams.set("time_range", "day");
	}
	return searchUrl.toString();
}

function formatSearxngResults(response: SearxngSearchResponse): string {
	const results = response.results || [];
	return results
		.filter((result) => result.url && result.title)
		.slice(0, 5)
		.map((result) => {
			const content = result.content ? `\n${result.content}` : "";
			const engines = result.engines && result.engines.length > 0 ? `\nEngines: ${result.engines.join(", ")}` : "";
			const published = result.publishedDate || result.published_date;
			const publishedLine = published ? `\nPublished: ${published}` : "";
			return `${result.title}${content}\nSource: ${result.url}${engines}${publishedLine}\n\n`;
		})
		.join('');
}

function getSearchErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

async function searxngSearch(query: string, topic: string, plugin: OLocalLLMPlugin): Promise<string> {
	const response = await requestUrl({
		url: buildSearxngSearchUrl(query, topic, plugin.settings.searxngInstanceUrl),
		method: "GET",
		headers: {
			"Accept": "application/json",
		},
	});

	if (response.status === 403) {
		throw new Error("SearXNG search failed: JSON output is not enabled or access is forbidden for this instance. Add json to search.formats in settings.yml.");
	}
	if (response.status !== 200) {
		throw new Error("SearXNG search failed: " + response.status);
	}

	const searchResponse = response.json as SearxngSearchResponse;
	if (!searchResponse || typeof searchResponse !== "object") {
		throw new Error("SearXNG search failed: the instance did not return a JSON response.");
	}
	if (searchResponse.error) {
		throw new Error("SearXNG search failed: " + searchResponse.error);
	}

	const context = formatSearxngResults(searchResponse);
	if (!context) {
		throw new Error("SearXNG search returned no usable results.");
	}
	return context;
}

async function processWebSearch(query: string, plugin: OLocalLLMPlugin) {
	const provider = plugin.settings.searchProvider;

	if (provider === "tavily" && !plugin.settings.tavilyApiKey) {
		new Notice("Please set your Tavily API key in settings");
		return;
	}
	if (provider === "brave" && !plugin.settings.braveSearchApiKey) {
		new Notice("Please set your Brave Search API key in settings");
		return;
	}
	if (provider === "searxng" && !plugin.settings.searxngInstanceUrl) {
		new Notice("Please set your SearXNG instance URL in settings");
		return;
	}

	new Notice("Searching the web...");

	try {
		let context: string;

		if (provider === "tavily") {
			context = await tavilySearch(query, "general", plugin);
		} else if (provider === "searxng") {
			context = await searxngSearch(query, "general", plugin);
		} else {
			const response = await requestUrl({
				url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&summary=1&extra_snippets=1&text_decorations=1&result_filter=web,discussions,faq,news&spellcheck=1`,
				method: "GET",
				headers: {
					"Accept": "application/json",
					"Accept-Encoding": "gzip",
					"X-Subscription-Token": plugin.settings.braveSearchApiKey,
				}
			});

			if (response.status !== 200) {
				throw new Error("Search failed: " + response.status);
			}

			const searchResults = (response.json as { web: { results: BraveWebResult[] } }).web.results;
			context = searchResults.map((result) => {
				let snippets = result.extra_snippets ?
					'\nAdditional Context:\n' + result.extra_snippets.join('\n') : '';
				return `${result.title}\n${result.description}${snippets}\nSource: ${result.url}\n\n`;
			}).join('');
		}

		void processText(
			`Search results for "${query}":\n\n${context}`,
			"Summarize these search results concisely. Use bullet points for key facts and cite sources inline as [Source](url).",
			plugin
		);

	} catch (error) {
		console.error("Web search error:", error);
		new Notice(getSearchErrorMessage(error, "Web search failed. Check console for details."));
	}
}

async function processNewsSearch(query: string, plugin: OLocalLLMPlugin) {
	const provider = plugin.settings.searchProvider;

	if (provider === "tavily" && !plugin.settings.tavilyApiKey) {
		new Notice("Please set your Tavily API key in settings");
		return;
	}
	if (provider === "brave" && !plugin.settings.braveSearchApiKey) {
		new Notice("Please set your Brave Search API key in settings");
		return;
	}
	if (provider === "searxng" && !plugin.settings.searxngInstanceUrl) {
		new Notice("Please set your SearXNG instance URL in settings");
		return;
	}

	new Notice("Searching for news...");

	try {
		let context: string;

		if (provider === "tavily") {
			context = await tavilySearch(query, "news", plugin);
		} else if (provider === "searxng") {
			context = await searxngSearch(query, "news", plugin);
		} else {
			const response = await requestUrl({
				url: `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=5&search_lang=en&freshness=pd`,
				method: "GET",
				headers: {
					"Accept": "application/json",
					"Accept-Encoding": "gzip",
					"X-Subscription-Token": plugin.settings.braveSearchApiKey,
				}
			});

			if (response.status !== 200) {
				throw new Error("News search failed: " + response.status);
			}

			const newsResults = (response.json as { results: BraveNewsResult[] }).results;
			context = newsResults.map((result) =>
				`${result.title}\n${result.description}\nSource: ${result.url}\nPublished: ${result.published_time}\n\n`
			).join('');
		}

		void processText(
			`News results for "${query}":\n\n${context}`,
			"Summarize these news results concisely. List key developments as bullet points and cite sources inline as [Source](url).",
			plugin
		);
	} catch (error) {
		console.error("News search error:", error);
		new Notice(getSearchErrorMessage(error, "News search failed. Check console for details."));
	}
}
