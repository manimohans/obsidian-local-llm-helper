import { DiagnosticsModal } from "./src/diagnosticsModal";
import { ChatRenderScope } from "./src/chatRenderScope";
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
	TFolder,
	normalizePath,
	requestUrl,
	requireApiVersion,
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
import { Persona, PersonasDict, DEFAULT_PERSONAS, buildPersonasDict } from './src/personas';
import { CustomPrompt, generatePromptId, SelectPromptModal } from './src/customPrompts';
import { extractActualResponse, parseReasoningMarkers, DEFAULT_REASONING_MARKERS } from './src/reasoningExtractor';
import { RelatedNotesContext, RelatedNotesView, RELATED_NOTES_VIEW_TYPE } from './src/relatedNotesView';
import {
	VaultRadarView,
	VAULT_RADAR_VIEW_TYPE,
	type VaultRadarViewOpenOptions,
} from './src/vaultRadarView';
import { VaultAgentService, type ChatEnvironmentContext, type ConversationEntry, getActiveChatContext } from './src/vaultAgent';
import { submitGeneralChat, updateConversationHistory as recordConversationHistory } from './src/chatSession';
import { debugLog, setDebugLogging } from './src/debug';
import { LLMClientError, OpenAICompatibleClient } from './src/llmClient';
import {
	BUILT_IN_TEXT_PROMPTS,
	buildSearchMaterial,
	buildTextActionMessages,
	DEFAULT_CUSTOM_TEXT_PROMPT,
	migrateLegacyDefaultCustomPrompt,
	NEWS_SEARCH_SYNTHESIS_PROMPT,
	type GroundedSearchResult,
	type TextActionMode,
	WEB_SEARCH_SYNTHESIS_PROMPT,
} from './src/prompts';
import { obsidianRequestTransport } from './src/obsidianRequestTransport';
import { WorkflowModal } from './src/workflowModal';
import { WorkflowRunnerService, createDefaultWorkflowDefaults, mergeWorkflowDefaults } from './src/workflowRunner';
import type { WorkflowDefaults } from './src/workflowTypes';
import {
	applyTextActionResult,
	captureTextActionTarget,
	type TextActionTarget,
} from './src/textActionTarget';
import {
	buildInsightCanvas,
	getCollisionSafeInsightCanvasPath,
	INSIGHT_CANVAS_FOLDER,
	serializeInsightCanvas,
} from './src/insightCanvas';
import {
	InsightCanvasModal,
	type InsightCanvasModalState,
} from './src/insightCanvasModal';
import {
	createEmptyVaultRadarState,
	getVisibleVaultRadarCards,
	MAX_VAULT_RADAR_STATE_CHARS,
	normalizeVaultRadarState,
	prepareVaultRadarStateForPersistence,
	updateVaultRadarCard,
	VaultRadarService,
	type VaultRadarCardAction,
	type VaultRadarRunResult,
	type VaultRadarState,
	type VaultRadarStoredCard,
} from './src/vaultRadar';
import {
	getEffectiveEmbeddingServerAddress,
	normalizeOptionalServerAddress,
	normalizeServerAddress,
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
	vaultRadarAutoRun: boolean;
	vaultRadarAutoRunEnabledAt: number;
	vaultRadarMaxNotes: number;
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "http://localhost:11434",
	embeddingServerAddress: "",
	llmModel: "llama3",
	maxTokens: 1024,
	temperature: 0.7,
	providerType: "ollama",
	stream: false,
	customPrompt: DEFAULT_CUSTOM_TEXT_PROMPT,
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
	vaultRadarAutoRun: false,
	vaultRadarAutoRunEnabledAt: 0,
	vaultRadarMaxNotes: 12,
};

function normalizeSearxngInstanceUrl(url: string): string {
	return normalizeServerAddress(url);
}

// Single source of truth for the built-in text actions, used by both the
// command palette registrations and the ribbon menu.
interface TextAction {
	commandId: string;
	commandName: string;
	menuTitle: string;
	icon: string;
	prompt: string;
	mode?: TextActionMode;
}

const TEXT_ACTIONS: Record<string, TextAction> = {
	summarize: {
		commandId: "summarize-selected-text",
		commandName: "Text: Summarize",
		menuTitle: "Summarize",
		icon: "minimize-2",
		prompt: BUILT_IN_TEXT_PROMPTS.summarize,
	},
	makeProfessional: {
		commandId: "makeitprof-selected-text",
		commandName: "Text: Make professional",
		menuTitle: "Make professional",
		icon: "briefcase",
		prompt: BUILT_IN_TEXT_PROMPTS.makeProfessional,
	},
	actionItems: {
		commandId: "actionitems-selected-text",
		commandName: "Text: Generate action items",
		menuTitle: "Generate action items",
		icon: "list-todo",
		prompt: BUILT_IN_TEXT_PROMPTS.actionItems,
	},
	useAsPrompt: {
		commandId: "gentext-selected-text",
		commandName: "Text: Use as prompt",
		menuTitle: "Use as prompt",
		icon: "lightbulb",
		prompt: BUILT_IN_TEXT_PROMPTS.useAsPrompt,
		mode: "request",
	},
};

export default class OLocalLLMPlugin extends Plugin {
	settings: OLocalLLMSettings;
	isKillSwitchActive: boolean = false;
	autoIndexTimer: number | undefined;
	isIndexing: boolean = false;
	public ragManager: RAGManager;
	public vaultAgent: VaultAgentService;
	public workflowRunner: WorkflowRunnerService;
	public llmClient: OpenAICompatibleClient;
	public vaultRadar: VaultRadarService;
	private backlinkGenerator: BacklinkGenerator;
	public personasDict: PersonasDict = {};
	private registeredPromptCommands: Set<string> = new Set();
	private relatedNotesRefreshTimer: number | null = null;
	private storageNotificationTimer: number | null = null;
	statusBarItemEl: HTMLElement | null = null;
	private lastRelatedNotesContext: RelatedNotesContext | null = null;
	private lastMarkdownLeaf: WorkspaceLeaf | null = null;
	private vaultRadarState: VaultRadarState = createEmptyVaultRadarState();
	private vaultRadarTimer: number | null = null;
	private vaultRadarRunPromise: Promise<void> | null = null;
	private vaultRadarMessage = "";
	private vaultRadarError = "";
	private vaultRadarDisposed = false;
	private vaultRadarNextRetryAt = 0;
	private vaultRadarCardMutationQueue: Promise<void> = Promise.resolve();
	private insightCanvasCreationQueue: Promise<void> = Promise.resolve();
	private insightCanvasInFlight = new Map<string, Promise<string>>();
	private activeInsightCanvasModals = new Set<InsightCanvasModal>();
	private insightCanvasDisposed = false;

	async checkForUpdates() {
		const currentVersion = this.manifest.version;
		const lastVersion = this.settings.lastVersion || "0.0.0";

		if (currentVersion !== lastVersion) {
			new UpdateNoticeModal(this.app, currentVersion).open();
			this.settings.lastVersion = currentVersion;
			await this.saveSettings();
		}
	}

	async onload() {
		await this.loadSettings();
		this.vaultRadarDisposed = false;
		this.insightCanvasDisposed = false;
		this.vaultRadarState = await this.loadVaultRadarStateFromDisk();
		this.llmClient = new OpenAICompatibleClient(
			() => this.settings,
			obsidianRequestTransport,
		);
		this.registerCustomPromptCommands();
		void this.checkForUpdates();
		// Validate server configuration
		this.validateServerConfiguration();

		// Initialize RAGManager
		this.ragManager = new RAGManager(this.app.vault, this.settings, this, this.llmClient);
		this.vaultAgent = new VaultAgentService(this.app, this, this.llmClient);
		this.workflowRunner = new WorkflowRunnerService(this.app, this, this.llmClient);
		this.vaultRadar = this.createVaultRadarService();
		
		// Initialize RAGManager and show user notification about loaded data
		await this.ragManager.initialize();
		this.startAutoIndexTimer();
		
		// Show user-friendly notification about loaded embeddings after a short delay
		// This ensures all UI elements are ready
		this.storageNotificationTimer = window.setTimeout(() => {
			this.storageNotificationTimer = null;
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
		this.registerView(
			VAULT_RADAR_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new VaultRadarView(leaf, this)
		);

		this.addCommand({
			id: 'index-notes-rag',
			name: 'Notes: Index notes for RAG',
			callback: () => {
				void this.indexNotes();
			},
		});

		// Add command for RAG Backlinks
		this.addCommand({
			id: 'generate-rag-backlinks',
			name: 'Notes: Generate backlinks',
			callback: this.handleGenerateBacklinks.bind(this),
		});

		this.addCommand({
			id: 'open-related-notes-view',
			name: 'Notes: Open Related Notes',
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

		this.addCommand({
			id: 'open-vault-radar',
			name: 'Vault Radar: Open',
			callback: () => {
				void this.openVaultRadarView({ focusRunButton: true });
			},
		});

		this.addCommand({
			id: 'run-vault-radar',
			name: 'Vault Radar: Run now',
			callback: () => {
				void this.openVaultRadarView({ runNow: true });
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

		for (const action of Object.values(TEXT_ACTIONS)) {
			this.addCommand({
				id: action.commandId,
				name: action.commandName,
				editorCallback: () => this.runTextAction(action.prompt, undefined, action.mode),
			});
		}

		this.addCommand({
			id: "custom-selected-text",
			name: "Text: Run custom prompt",
			editorCallback: () => {
				this.runTextAction(
					this.settings.customPrompt,
					"Custom prompt: " + this.settings.customPrompt
				);
			},
		});

		this.addCommand({
			id: "edit-with-prompt",
			name: "Text: Edit with prompt...",
			editorCallback: () => this.openPromptPicker(),
		});

		this.addCommand({
			id: "select-custom-prompt",
			name: "Text: Run saved prompt...",
			editorCallback: () => this.openSavedPromptPicker(),
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
				void generateAndAppendTags(this.app, this.settings, this.llmClient);
			},
		});

		this.addCommand({
			id: "web-search-selected-text",
			name: "Web: Search",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false;
				const target = this.getTextActionTarget();
				if (target?.selectedText.length) {
					void processWebSearch(target.selectedText, this, target);
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "web-news-search",
			name: "Web: Search news",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const target = this.getTextActionTarget();
				if (target?.selectedText.length) {
					void processNewsSearch(target.selectedText, this, target);
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
					.setTitle("Vault Radar")
					.setIcon("radar")
					.onClick(() => {
						void this.openVaultRadarView();
					})
			);

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
					.onClick(() => this.openPromptPicker())
			);

			for (const action of [TEXT_ACTIONS.summarize, TEXT_ACTIONS.makeProfessional, TEXT_ACTIONS.actionItems]) {
				menu.addItem((item) =>
					item
						.setTitle(action.menuTitle)
						.setIcon(action.icon)
						.onClick(() => this.runTextAction(action.prompt, undefined, action.mode))
				);
			}

			menu.addItem((item) =>
				item
					.setTitle("Generate tags")
					.setIcon("hash")
					.onClick(() => {
						const selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							new Notice("Generating tags...");
							void generateAndAppendTags(this.app, this.settings, this.llmClient);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle(TEXT_ACTIONS.useAsPrompt.menuTitle)
					.setIcon(TEXT_ACTIONS.useAsPrompt.icon)
					.onClick(() => this.runTextAction(
						TEXT_ACTIONS.useAsPrompt.prompt,
						undefined,
						TEXT_ACTIONS.useAsPrompt.mode,
					))
			);

			menu.addItem((item) =>
				item
					.setTitle("Custom prompt")
					.setIcon("pencil")
					.onClick(() => {
						this.runTextAction(
							this.settings.customPrompt,
							"Running: " + this.settings.customPrompt
						);
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Run saved prompt...")
					.setIcon("list")
					.onClick(() => this.openSavedPromptPicker())
			);

			menu.addSeparator();

			// === Web Search Section ===
			menu.addItem((item) =>
				item
					.setTitle("Web search")
					.setIcon("globe")
					.onClick(async () => {
						const target = this.getTextActionTarget();
						if (target?.selectedText.length) {
							void processWebSearch(target.selectedText, this, target);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("News search")
					.setIcon("newspaper")
					.onClick(async () => {
						const target = this.getTextActionTarget();
						if (target?.selectedText.length) {
							void processNewsSearch(target.selectedText, this, target);
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

		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.setText("LLM Helper: Ready");

		this.addSettingTab(new OLLMSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			if (!this.vaultRadarDisposed) {
				this.startVaultRadarTimer();
			}
		});
	}

	private validateServerConfiguration(): boolean {
		const serverAddress = this.settings.serverAddress;
		const llmModel = this.settings.llmModel;
		const embeddingModel = this.settings.embeddingModelName;
		const embeddingServerAddress = getEffectiveEmbeddingServerAddress(this.settings);

		debugLog(`Configuration - Chat server: ${serverAddress}, Embedding server: ${embeddingServerAddress}, LLM: ${llmModel}, Embeddings: ${embeddingModel}`);
		debugLog('Using OpenAI-compatible API endpoints (/v1/chat/completions, /v1/embeddings)');

		if (!serverAddress || serverAddress.trim() === '') {
			console.warn('Server address is not configured.');
			return false;
		}

		return true;
	}

	private runTextAction(prompt: string, notice?: string, mode: TextActionMode = "edit") {
		this.isKillSwitchActive = false;
		const target = this.getTextActionTarget();
		if (!target?.selectedText.length) {
			new Notice("Please select some text first");
			return;
		}
		if (notice) {
			new Notice(notice);
		}
		void processText(target.selectedText, prompt, this, target, mode);
	}

	private openPromptPicker() {
		const target = this.getTextActionTarget();
		if (!target?.selectedText.length) {
			new Notice("Please select some text first");
			return;
		}
		new PromptPickerModal(this.app, (prompt: string) => {
			this.isKillSwitchActive = false;
			void processText(target.selectedText, prompt, this, target);
		}).open();
	}

	private openSavedPromptPicker() {
		const prompts = this.settings.customPrompts || [];
		if (prompts.length === 0) {
			new Notice("No saved prompts yet. Add some in settings.");
			return;
		}
		const target = this.getTextActionTarget();
		if (!target?.selectedText.length) {
			new Notice("Please select some text first");
			return;
		}
		new SelectPromptModal(this.app, prompts, (chosen) => {
			this.isKillSwitchActive = false;
			new Notice("Running: " + chosen.title);
			void processText(target.selectedText, chosen.prompt, this, target);
		}).open();
	}

	private getTextActionTarget(): TextActionTarget | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const target = captureTextActionTarget(view);
		if (target) {
			return target;
		}

		if (!view) {
			new Notice("No active view");
		} else if (view.getMode() === "preview") {
			new Notice("Does not work in preview mode");
		} else {
			new Notice("No editable Markdown note is active");
		}
		return null;
	}

	private getSelectedText() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("No active view");
			return "";
		} else {
			const view_mode = view.getMode();
			switch (view_mode) {
				case "preview":
					new Notice("Does not work in preview mode");
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

	async openVaultRadarView(options: VaultRadarViewOpenOptions = {}): Promise<void> {
		const leaf = await this.app.workspace.ensureSideLeaf(
			VAULT_RADAR_VIEW_TYPE,
			"right",
			{ active: true, reveal: true },
		);
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });

		if (leaf.view instanceof VaultRadarView) {
			leaf.view.applyOpenOptions(options);
			return;
		}
		new Notice("Could not open Vault Radar view.");
	}

	getVaultRadarSnapshot() {
		const state = normalizeVaultRadarState(this.vaultRadarState);
		return {
			state,
			cards: getVisibleVaultRadarCards(state),
			isRunning: this.vaultRadarRunPromise !== null,
			message: this.vaultRadarMessage,
			error: this.vaultRadarError,
		};
	}

	async runVaultRadar(trigger: "manual" | "daily" = "manual"): Promise<void> {
		if (this.vaultRadarRunPromise) {
			if (trigger === "manual") {
				new Notice("Vault Radar is already scanning changed notes.");
			}
			return this.vaultRadarRunPromise;
		}

		const runPromise = this.executeVaultRadarRun(trigger).finally(() => {
			if (this.vaultRadarRunPromise === runPromise) {
				this.vaultRadarRunPromise = null;
			}
			void this.refreshVaultRadarViews();
			this.startVaultRadarTimer();
		});
		this.vaultRadarRunPromise = runPromise;
		await this.refreshVaultRadarViews();
		return runPromise;
	}

	async recordVaultRadarCardAction(
		cardId: string,
		action: VaultRadarCardAction,
	): Promise<boolean> {
		if (this.vaultRadarRunPromise) {
			new Notice("Wait for the current Vault Radar scan to finish.");
			return false;
		}
		const mutation = this.vaultRadarCardMutationQueue.then(async () => {
			const nextState = updateVaultRadarCard(this.vaultRadarState, cardId, action);
			await this.persistVaultRadarState(nextState);
			await this.refreshVaultRadarViews();
			return true;
		});
		this.vaultRadarCardMutationQueue = mutation.then(() => undefined, () => undefined);
		try {
			return await mutation;
		} catch (error) {
			console.error("Vault Radar feedback could not be saved:", error);
			new Notice("Could not save Vault Radar feedback.");
			return false;
		}
	}

	private async executeVaultRadarRun(trigger: "manual" | "daily"): Promise<void> {
		this.vaultRadarError = "";
		this.vaultRadarMessage = "Scanning changed notes…";
		await this.refreshVaultRadarViews();
		try {
			await this.vaultRadarCardMutationQueue;
			const result = await this.vaultRadar.run();
			this.vaultRadarNextRetryAt = 0;
			this.vaultRadarMessage = this.describeVaultRadarResult(result);
			if (trigger === "manual") {
				new Notice(this.vaultRadarMessage);
			} else if (result.status === "generated") {
				new Notice(`Vault Radar found ${result.cards.length} new insight${result.cards.length === 1 ? "" : "s"}.`);
			}
		} catch (error) {
			console.error("Vault Radar run failed:", error);
			this.vaultRadarNextRetryAt = Date.now() + 30 * 60 * 1000;
			this.vaultRadarError = this.describeVaultRadarError(error);
			this.vaultRadarMessage = "Previous insights are still available.";
			if (trigger === "manual") {
				new Notice(this.vaultRadarError);
			}
		}
	}

	private describeVaultRadarResult(result: VaultRadarRunResult): string {
		if (result.status === "generated") {
			return `Found ${result.cards.length} new cited insight${result.cards.length === 1 ? "" : "s"} from ${result.selectedPaths.length} changed note${result.selectedPaths.length === 1 ? "" : "s"}.`;
		}
		if (result.status === "no_new_insights") {
			return `Checked ${result.selectedPaths.length} changed note${result.selectedPaths.length === 1 ? "" : "s"}; no new grounded insight was strong enough to show.`;
		}
		return "No changed Markdown notes since the last successful check.";
	}

	private describeVaultRadarError(error: unknown): string {
		const message = error instanceof Error ? error.message : "Unknown error";
		if (error instanceof LLMClientError) {
			return `Vault Radar could not reach the configured model: ${message}`;
		}
		return `Vault Radar could not finish: ${message}`;
	}

	private async refreshVaultRadarViews(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(VAULT_RADAR_VIEW_TYPE)) {
			if (leaf.view instanceof VaultRadarView) {
				leaf.view.refresh();
			}
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
			new Notice("Open a note or select text to find Related Notes.");
			return;
		}
		if (this.ragManager.getIndexedFilesCount() === 0) {
			new Notice("Index your notes first: run notes: Index notes for RAG.");
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

	async createInsightCanvas(card: VaultRadarStoredCard): Promise<string> {
		if (this.insightCanvasDisposed) {
			throw new Error("Insight Canvas is unavailable while the plugin is unloading.");
		}
		const creationKey = card.id || card.fingerprint;
		const inFlight = this.insightCanvasInFlight.get(creationKey);
		if (inFlight) {
			return inFlight;
		}
		const creation = this.insightCanvasCreationQueue.then(() => (
			this.createInsightCanvasFile(card)
		));
		this.insightCanvasCreationQueue = creation.then(() => undefined, () => undefined);
		this.insightCanvasInFlight.set(creationKey, creation);
		try {
			return await creation;
		} finally {
			if (this.insightCanvasInFlight.get(creationKey) === creation) {
				this.insightCanvasInFlight.delete(creationKey);
			}
		}
	}

	openInsightCanvasModal(
		card: VaultRadarStoredCard,
		onStateChange?: (state: InsightCanvasModalState) => void,
	): void {
		if (this.insightCanvasDisposed) {
			new Notice("Insight Canvas is unavailable while the plugin is unloading.");
			return;
		}
		let modal: InsightCanvasModal;
		modal = new InsightCanvasModal(
			this.app,
			this,
			card,
			() => this.activeInsightCanvasModals.delete(modal),
			onStateChange,
		);
		this.activeInsightCanvasModals.add(modal);
		modal.open();
	}

	private async createInsightCanvasFile(card: VaultRadarStoredCard): Promise<string> {
		if (this.insightCanvasDisposed) {
			throw new Error("Insight Canvas is unavailable while the plugin is unloading.");
		}
		const citedSourcePaths = Array.from(new Set(
			card.sourcePaths.filter((path) => path.trim().length > 0),
		));
		const availableSourcePaths = citedSourcePaths.filter((path) => (
			this.app.vault.getAbstractFileByPath(path) instanceof TFile
		));
		if (availableSourcePaths.length === 0) {
			throw new Error("None of this insight's cited notes are available. Run Vault Radar again to refresh its sources.");
		}

		const existingFolder = this.app.vault.getAbstractFileByPath(INSIGHT_CANVAS_FOLDER);
		if (existingFolder && !(existingFolder instanceof TFolder)) {
			throw new Error(`${INSIGHT_CANVAS_FOLDER} exists as a file. Rename it before creating an Insight Canvas.`);
		}
		if (!existingFolder) {
			try {
				await this.app.vault.createFolder(INSIGHT_CANVAS_FOLDER);
			} catch (error) {
				const racedFolder = this.app.vault.getAbstractFileByPath(INSIGHT_CANVAS_FOLDER);
				if (!(racedFolder instanceof TFolder)) {
					throw error;
				}
			}
		}

		const canvasPath = normalizePath(await getCollisionSafeInsightCanvasPath(
			INSIGHT_CANVAS_FOLDER,
			card.title,
			(path) => this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null,
		));
		const document = buildInsightCanvas(card, availableSourcePaths);
		if (this.insightCanvasDisposed) {
			throw new Error("Insight Canvas stopped because the plugin is unloading.");
		}
		const canvasFile = await this.app.vault.create(
			canvasPath,
			`${serializeInsightCanvas(document)}\n`,
		);

		if (this.insightCanvasDisposed) {
			return canvasPath;
		}
		const skippedSourceCount = citedSourcePaths.length - availableSourcePaths.length;
		const skippedSuffix = skippedSourceCount > 0
			? ` ${skippedSourceCount} missing source${skippedSourceCount === 1 ? " was" : "s were"} skipped.`
			: "";
		try {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(canvasFile);
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		} catch {
			new Notice(`Insight Canvas was created at ${canvasPath}, but Obsidian could not open it automatically.`);
			return canvasPath;
		}
		new Notice(
			`Insight Canvas created from ${availableSourcePaths.length} source${availableSourcePaths.length === 1 ? "" : "s"}.${skippedSuffix}`,
		);
		return canvasPath;
	}

	onunload(): void {
		this.vaultRadarDisposed = true;
		this.insightCanvasDisposed = true;
		for (const modal of this.activeInsightCanvasModals) {
			modal.close();
		}
		this.activeInsightCanvasModals.clear();
		if (this.vaultRadarTimer !== null) {
			window.clearTimeout(this.vaultRadarTimer);
			this.vaultRadarTimer = null;
		}
		if (this.relatedNotesRefreshTimer !== null) {
			window.clearTimeout(this.relatedNotesRefreshTimer);
			this.relatedNotesRefreshTimer = null;
		}
		if (this.storageNotificationTimer !== null) {
			window.clearTimeout(this.storageNotificationTimer);
			this.storageNotificationTimer = null;
		}
		if (this.autoIndexTimer !== undefined) {
			window.clearTimeout(this.autoIndexTimer);
			this.autoIndexTimer = undefined;
		}
		if (this.ragManager) {
			void this.ragManager.dispose().catch((error) => {
				console.error("Failed to dispose the note index:", error);
			});
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

	private createVaultRadarService(): VaultRadarService {
		return new VaultRadarService(
			this.llmClient,
			() => ({
				model: this.settings.llmModel,
				temperature: Math.min(0.4, Math.max(0, this.settings.temperature)),
				maxTokens: Math.min(2_400, Math.max(1_400, this.settings.maxTokens)),
				reasoningMarkers: this.settings.reasoningMarkers,
			}),
			{
				listNotes: async () => this.app.vault.getMarkdownFiles().map((file) => ({
					path: file.path,
					modifiedAt: file.stat.mtime,
					createdAt: file.stat.ctime,
					size: file.stat.size,
				})),
				readNote: async (path: string) => {
					const file = this.app.vault.getAbstractFileByPath(path);
					if (!(file instanceof TFile)) {
						throw new Error(`Changed note is no longer available: ${path}`);
					}
					return this.app.vault.cachedRead(file);
				},
				loadState: async () => normalizeVaultRadarState(this.vaultRadarState),
				saveState: async (state: VaultRadarState) => this.persistVaultRadarState(state),
			},
			{
				maxNotes: this.settings.vaultRadarMaxNotes,
				maxContextChars: 36_000,
				maxCharsPerNote: 3_200,
				maxCards: 5,
			},
		);
	}

	refreshVaultRadarConfiguration(): void {
		if (!this.vaultRadarRunPromise) {
			this.vaultRadar = this.createVaultRadarService();
		}
	}

	startVaultRadarTimer(): void {
		if (this.vaultRadarTimer !== null) {
			window.clearTimeout(this.vaultRadarTimer);
			this.vaultRadarTimer = null;
		}
		if (this.vaultRadarDisposed || !this.settings.vaultRadarAutoRun) {
			return;
		}

		const now = Date.now();
		const enabledAt = this.settings.vaultRadarAutoRunEnabledAt > 0
			? this.settings.vaultRadarAutoRunEnabledAt
			: now;
		const lastCheck = Math.max(
			this.vaultRadarState.lastSuccessfulRunAt ?? 0,
			enabledAt,
		);
		const dailyDueAt = lastCheck + 24 * 60 * 60 * 1000;
		const dueAt = Math.max(dailyDueAt, this.vaultRadarNextRetryAt);
		const delay = Math.min(2_147_000_000, Math.max(2_000, dueAt - now));
		this.vaultRadarTimer = window.setTimeout(() => {
			this.vaultRadarTimer = null;
			void this.runVaultRadar("daily");
		}, delay);
	}

	private getVaultRadarStatePath(): string {
		const configDir = this.app.vault.configDir.replace(/\/+$/, "");
		const pluginDir = this.manifest.dir || `${configDir}/plugins/${this.manifest.id}`;
		return `${pluginDir}/vault-radar-state.json`;
	}

	private async loadVaultRadarStateFromDisk(): Promise<VaultRadarState> {
		const path = this.getVaultRadarStatePath();
		const backupPath = `${path}.bak`;
		for (const candidate of [path, backupPath]) {
			try {
				if (!await this.app.vault.adapter.exists(candidate)) {
					continue;
				}
				const raw = await this.app.vault.adapter.read(candidate);
				if (raw.length > MAX_VAULT_RADAR_STATE_CHARS) {
					throw new Error("state file is unexpectedly large");
				}
				return normalizeVaultRadarState(JSON.parse(raw));
			} catch (error) {
				console.warn(`Vault Radar ignored unreadable state at ${candidate}:`, error);
			}
		}
		return createEmptyVaultRadarState();
	}

	private async persistVaultRadarState(state: VaultRadarState): Promise<void> {
		if (this.vaultRadarDisposed) {
			throw new Error("Vault Radar was unloaded before the result could be saved.");
		}
		const prepared = prepareVaultRadarStateForPersistence(state);
		const path = this.getVaultRadarStatePath();
		const temporaryPath = `${path}.tmp`;
		const backupPath = `${path}.bak`;
		const adapter = this.app.vault.adapter;
		const serialized = prepared.serialized;

		if (await adapter.exists(temporaryPath)) {
			await adapter.remove(temporaryPath);
		}
		await adapter.write(temporaryPath, serialized);

		let movedPrevious = false;
		try {
			if (await adapter.exists(backupPath)) {
				await adapter.remove(backupPath);
			}
			if (await adapter.exists(path)) {
				await adapter.rename(path, backupPath);
				movedPrevious = true;
			}
			try {
				await adapter.rename(temporaryPath, path);
			} catch (error) {
				if (movedPrevious && !await adapter.exists(path) && await adapter.exists(backupPath)) {
					await adapter.rename(backupPath, path);
				}
				throw error;
			}
			if (movedPrevious && await adapter.exists(backupPath)) {
				try {
					await adapter.remove(backupPath);
				} catch (error) {
					console.warn("Vault Radar left a recoverable backup state file:", error);
				}
			}
		} catch (error) {
			if (await adapter.exists(temporaryPath)) {
				await adapter.remove(temporaryPath);
			}
			throw error;
		}

		if (this.vaultRadarDisposed) {
			throw new Error("Vault Radar was unloaded before the result could be applied.");
		}
		this.vaultRadarState = prepared.state;
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
		debugLog('📂 LLM Helper: Loading plugin settings...');
		const savedData = await this.loadData();

		// Only pick keys declared in the settings interface. data.json may
		// contain large legacy keys (pre-2.x embeddings blobs) that must not
		// be merged into settings and rewritten on every save.
		this.settings = { ...DEFAULT_SETTINGS };
		if (savedData && typeof savedData === "object") {
			for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof OLocalLLMSettings)[]) {
				if (savedData[key] !== undefined) {
					(this.settings as unknown as Record<string, unknown>)[key] = savedData[key];
				}
			}
			const legacyKeys = Object.keys(savedData).filter(
				(key) => !(key in DEFAULT_SETTINGS)
			);
			if (legacyKeys.length > 0) {
				debugLog('🧹 LLM Helper: Removing legacy data.json keys:', legacyKeys);
				await this.saveData(this.settings);
				new Notice("LLM Helper: cleaned up stale data from plugin settings file.");
			}
		}
		this.settings.customPrompt = migrateLegacyDefaultCustomPrompt(this.settings.customPrompt);
		this.settings.workflowDefaults = mergeWorkflowDefaults(savedData?.workflowDefaults);
		this.settings.vaultRadarAutoRun = this.settings.vaultRadarAutoRun === true;
		this.settings.vaultRadarAutoRunEnabledAt = Number.isFinite(this.settings.vaultRadarAutoRunEnabledAt)
			? Math.max(0, this.settings.vaultRadarAutoRunEnabledAt)
			: 0;
		this.settings.vaultRadarMaxNotes = Number.isFinite(this.settings.vaultRadarMaxNotes)
			? Math.min(25, Math.max(3, Math.floor(this.settings.vaultRadarMaxNotes)))
			: DEFAULT_SETTINGS.vaultRadarMaxNotes;
		setDebugLogging(this.settings.showAgentDebug);

		this.settings.serverAddress = normalizeServerAddress(this.settings.serverAddress);
		this.settings.embeddingServerAddress = normalizeOptionalServerAddress(this.settings.embeddingServerAddress);
		this.settings.searxngInstanceUrl = normalizeSearxngInstanceUrl(this.settings.searxngInstanceUrl || "");
		this.rebuildPersonas();

		debugLog('✅ LLM Helper: Final settings after merge:', {
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
		setDebugLogging(this.settings.showAgentDebug);
		await this.saveData(this.settings);

		// Update RAG manager with new settings
		if (this.ragManager) {
			this.ragManager.updateSettings(this.settings);
		}

		this.queueRelatedNotesRefresh(150);
		await this.refreshVaultRadarViews();
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
		const commandId = `${this.manifest.id}:${customPrompt.id}`;
		this.addCommand({
			id: customPrompt.id,
			name: `Prompt: ${customPrompt.title}`,
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false;
				const target = this.getTextActionTarget();
				if (target?.selectedText.length) {
					new Notice("Running: " + customPrompt.title);
					void processText(target.selectedText, customPrompt.prompt, this, target);
				} else {
					new Notice("Please select some text first");
				}
			},
		});
		this.registeredPromptCommands.add(commandId);
	}

	unregisterPromptCommand(id: string) {
		const commandId = `${this.manifest.id}:${id}`;
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
			debugLog("LLM Helper: Skipping manual index, indexing already in progress.");
			return;
		}
		this.isIndexing = true;
		new Notice('Indexing notes for RAG...');
		try {
			await this.ragManager.indexNotes(progress => {
				// You can use the progress value here if needed
				debugLog(`Indexing progress: ${progress * 100}%`);
			});
			new Notice('Notes indexed successfully!');
			this.queueRelatedNotesRefresh(150);
		} catch (error) {
			console.error('Error indexing notes:', error);
			new Notice(error instanceof Error ? error.message : "Failed to index notes. Check console for details.");
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

	async handleDiagnostics(): Promise<void> {
		try {
			const stats = await this.ragManager.getStorageStats();
			new DiagnosticsModal(this.app, [
				["Provider", this.settings.providerType],
				["Chat model", this.settings.llmModel],
				["Embedding model", this.settings.embeddingModelName],
				["Total embeddings", String(stats.totalEmbeddings)],
				["Indexed sources", String(stats.indexedFiles)],
				["Markdown sources", String(stats.sourceCounts.markdown)],
				["PDF sources", String(stats.sourceCounts.pdf)],
				["Image sources", String(stats.sourceCounts.image)],
				["Last indexed", String(stats.lastIndexed)],
				["Storage used", stats.storageUsed],
				["Loaded sources", String(this.ragManager.getIndexedFilesCount())],
				["Total vault files", String(this.app.vault.getFiles().length)],
			]).open();
		} catch (error) {
			console.error("Error getting storage stats:", error);
			new Notice("Error getting storage stats. Check console for details.");
		}
	}

	async showStorageNotification() {
		try {
			// Report the index that actually loaded into memory — disk stats
			// can disagree when a saved index was rejected as incompatible
			// with the current embedding settings.
			const loadedEmbeddings = this.ragManager.getLoadedEmbeddingCount();
			if (loadedEmbeddings > 0) {
				const indexedFiles = this.ragManager.getIndexedFilesCount();
				const stats = await this.ragManager.getStorageStats();
				new Notice(`📚 Loaded ${loadedEmbeddings} embeddings from ${indexedFiles} sources (${stats.storageUsed})`);
			} else {
				new Notice('📝 No usable note index loaded - ready to index notes');
			}
		} catch (error) {
			console.error('Error showing storage notification:', error);
		}
	}
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
		el.createDiv({ text: model });
	}

	onChooseSuggestion(model: string) {
		this.onChoose(model);
	}
}

export class OLLMSettingTab extends PluginSettingTab {
	plugin: OLocalLLMPlugin;
	private indexedFilesCountSetting: Setting | null = null;
	private saveTimeout: number | null = null;
	private indexedCountTimer: number | null = null;

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
			this.saveTimeout = null;
			void this.plugin.saveSettings();
		}, 500);
	}

	// Flush any pending debounced save when settings tab is closed
	hide() {
		if (this.indexedCountTimer !== null) {
			window.clearTimeout(this.indexedCountTimer);
			this.indexedCountTimer = null;
		}
		this.indexedFilesCountSetting = null;
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
			void this.plugin.saveSettings();
		}
	}

	// Definitions are cheap to index; UI construction and I/O stay in render callbacks.
	// Both API generations use the same renderers so validation and save side effects agree.
	getSettingDefinitions() {
		return [
			{
				name: "Connection",
				aliases: ["Provider", "Chat/default server URL", "Chat/default API key", "Embedding server URL", "Embedding API key"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderConnectionSettings(el)),
			},
			{
				name: "Models",
				aliases: ["Chat model", "Embedding model", "Temperature", "Max tokens"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderModelsSettings(el)),
			},
			{
				name: "Chat",
				aliases: ["Persona", "System prompt", "Conversation history", "Render markdown in chat", "Vault Actions", "Show Vault Actions debug JSON"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderChatSettings(el)),
			},
			{
				name: "Vault Radar",
				aliases: ["Automatic daily brief", "Changed notes per run", "Open Vault Radar"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderVaultRadarSettings(el)),
			},
			{
				name: "Workflow Automation",
				aliases: ["Weekly review", "Meeting notes to tasks", "Project status summary", "Default source scope", "Default tags", "Output folder", "Title template", "Target note"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderWorkflowAutomationSettings(el)),
			},
			{
				name: "Output",
				aliases: ["Streaming", "Output mode", "Response formatting", "Prepend text", "Append text", "Extract reasoning", "Reasoning markers"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderOutputSettings(el)),
			},
			{
				name: "Custom Prompt",
				aliases: ["Your prompt"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderCustomPromptSettings(el)),
			},
			{
				name: "Saved Prompts",
				aliases: [],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderSavedPromptsSettings(el)),
			},
			{
				name: "Notes Index (RAG)",
				aliases: ["RAG Top K", "Auto-index interval (minutes)", "Auto Index Notification", "Index PDF attachments", "OCR image attachments", "OCR scanned PDFs", "Index sources", "Indexed sources", "Diagnostics"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderNotesIndexRagSettings(el)),
			},
			{
				name: "Integrations",
				aliases: ["Brave Search API key", "SearXNG instance URL", "Tavily API key", "Search provider"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderIntegrationsSettings(el)),
			},
			{
				name: "About",
				aliases: ["Version"],
				render: (setting: Setting) => this.renderSettingsSection(setting, (el) => this.renderAboutSettings(el)),
			},
		];
	}

	private renderSettingsSection(setting: Setting, render: (el: HTMLElement) => void): void {
		setting.settingEl.addClass("llm-helper-settings-section");
		setting.controlEl.remove();
		render(setting.settingEl.createDiv({ cls: "llm-helper-settings-section-content" }));
	}

	// Obsidian <1.13 uses display(); newer versions render the definitions above.
	display(): void {
		this.renderLegacySettings();
	}

	private renderLegacySettings(): void {
		this.containerEl.empty();
		for (const definition of this.getSettingDefinitions()) {
			if ("render" in definition && definition.render) {
				const setting = new Setting(this.containerEl).setName(definition.name);
				definition.render(setting);
			}
		}
	}

	private refreshSettings(): void {
		if (requireApiVersion("1.13.0")) {
			this.update();
		} else {
			this.renderLegacySettings();
		}
	}

	private renderConnectionSettings(containerEl: HTMLElement): void {

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
						this.refreshSettings();
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
			.setDesc("Optional. Leave blank to inherit the chat/default API key. Use 'not-needed' to send no authorization header.")
			.addText((text) =>
				text
					.setPlaceholder("inherit chat/default key")
					.setValue(this.plugin.settings.embeddingApiKey || "")
					.onChange((value) => {
						this.plugin.settings.embeddingApiKey = value.trim();
						this.debouncedSave();
					})
			);

	}

	private renderModelsSettings(containerEl: HTMLElement): void {

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
						const models = await this.plugin.llmClient.listModels("chat");
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
						new Notice(getLLMErrorMessage(e, "Could not fetch models. Check server URL and connection."));
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
						const models = await this.plugin.llmClient.listModels("embedding");
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
						new Notice(getLLMErrorMessage(e, "Could not fetch models. Check server URL and connection."));
					} finally {
						btn.setDisabled(false);
						btn.setButtonText("Browse");
					}
				}));

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("0 = deterministic, higher = more creative (max 2)")
			.addText((text) =>
				text
					.setPlaceholder("0.7")
					.setValue(this.plugin.settings.temperature.toString())
					.onChange((value) => {
						const parsedValue = parseFloat(value);
						if (!isNaN(parsedValue) && parsedValue >= 0 && parsedValue <= 2) {
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
						if (!isNaN(parsedValue) && parsedValue >= 1) {
							this.plugin.settings.maxTokens = parsedValue;
							this.debouncedSave();
						}
					})
			);

	}

	private renderChatSettings(containerEl: HTMLElement): void {

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
						this.refreshSettings();
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
					if (key in DEFAULT_PERSONAS) {
						new Notice(`"${name}" clashes with a built-in persona. Choose a different name (built-ins can be edited above).`);
						return;
					}
					const saved = this.plugin.settings.savedPersonas || {};
					saved[key] = { displayName: name, systemPrompt: prompt + "\n\n" };
					this.plugin.settings.savedPersonas = saved;
					this.plugin.rebuildPersonas();
					await this.plugin.saveSettings();
					new Notice(`Persona "${name}" added`);
					this.refreshSettings();
				}))
			.addButton(btn => btn
				.setButtonText("Delete selected persona")
				.setClass("mod-warning")
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
					this.refreshSettings();
				}))
			.addButton(btn => btn
				.setButtonText("Restore defaults")
				.onClick(async () => {
					this.plugin.settings.savedPersonas = undefined;
					this.plugin.rebuildPersonas();
					await this.plugin.saveSettings();
					new Notice("Personas restored to defaults");
					this.refreshSettings();
				}));

		new Setting(containerEl)
			.setName("Conversation history")
			.setDesc("Number of previous chat exchanges to include (0-3). One-shot text actions always run independently.")
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
			.setName("Render Markdown in chat")
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


	}

	private renderVaultRadarSettings(containerEl: HTMLElement): void {

		containerEl.createEl("p", {
			text: "Turn recent Markdown changes into a small, cited brief: forgotten commitments, stalled work, useful connections, and a concrete next action. Radar reads notes but never edits them.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Automatic daily brief")
			.setDesc("Off by default. When enabled, once every 24 hours Radar sends bounded excerpts from changed notes and limited prior-card feedback metadata to your configured chat server. Enabling starts the 24-hour clock; it does not run immediately.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.vaultRadarAutoRun)
					.onChange(async (value) => {
						this.plugin.settings.vaultRadarAutoRun = value;
						this.plugin.settings.vaultRadarAutoRunEnabledAt = value ? Date.now() : 0;
						await this.plugin.saveSettings();
						this.plugin.startVaultRadarTimer();
					})
			);

		new Setting(containerEl)
			.setName("Changed notes per run")
			.setDesc("Caps how many recently changed Markdown notes are read in one brief (3–25). Long notes are excerpted and the total prompt is bounded.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "3";
				text.inputEl.max = "25";
				text
					.setValue(String(this.plugin.settings.vaultRadarMaxNotes))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed)) {
							return;
						}
						this.plugin.settings.vaultRadarMaxNotes = Math.min(25, Math.max(3, parsed));
						await this.plugin.saveSettings();
						this.plugin.refreshVaultRadarConfiguration();
					});
			});

		new Setting(containerEl)
			.setName("Open Vault Radar")
			.setDesc("Review the current brief, run a manual scan, and rate or snooze insight cards.")
			.addButton((button) => button
				.setButtonText("Open")
				.setCta()
				.onClick(() => {
					void this.plugin.openVaultRadarView({ focusRunButton: true });
				}));


	}

	private renderWorkflowAutomationSettings(containerEl: HTMLElement): void {

		containerEl.createEl("p", {
			text: "Manual workflow recipes draft note changes from RAG context and still require approval before writing.",
			cls: "setting-item-description",
		});

		this.renderWorkflowDefaultsSetting(containerEl, "weekly-review", "Weekly review");
		this.renderWorkflowDefaultsSetting(containerEl, "meeting-notes-to-tasks", "Meeting notes to tasks");
		this.renderWorkflowDefaultsSetting(containerEl, "project-status-summary", "Project status summary");

	}

	private renderOutputSettings(containerEl: HTMLElement): void {

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
						this.refreshSettings();
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
						this.refreshSettings();
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

	}

	private renderCustomPromptSettings(containerEl: HTMLElement): void {

		new Setting(containerEl)
			.setName("Your prompt")
			.setDesc("Used by 'text: Run custom prompt' command")
			.addText((text) =>
				text
					.setPlaceholder("Create action items from the following:")
					.setValue(this.plugin.settings.customPrompt)
					.onChange((value) => {
						this.plugin.settings.customPrompt = value;
						this.debouncedSave();
					})
			);

	}

	private renderSavedPromptsSettings(containerEl: HTMLElement): void {

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
									// The ID stays stable; re-registering picks up the new title
									this.plugin.refreshCustomPromptCommands();
									await this.plugin.saveSettings();
									new Notice("Prompt updated");
									this.refreshSettings();
								})();
							}).open();
						}))
					.addButton(btn => btn
						.setButtonText("Delete")

						.setClass("mod-warning")
						.onClick(async () => {
							this.plugin.settings.customPrompts = savedPrompts.filter(p => p.id !== sp.id);
							this.plugin.unregisterPromptCommand(sp.id);
							await this.plugin.saveSettings();
							new Notice("Prompt deleted");
							this.refreshSettings();
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
			attr: { type: "text", placeholder: "Prompt title (e.g., translate to Spanish)", style: "width: 100%; margin-bottom: 4px;" }
		});
		const newPromptTextarea = newPromptContainer.createEl("textarea", {
			attr: { placeholder: "Prompt text (e.g., translate the following text to Spanish:)", rows: "3", style: "width: 100%; font-family: monospace; font-size: 0.85em; margin-bottom: 4px;" }
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
						id: generatePromptId(title, now),
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
					this.refreshSettings();
				}));

	}

	private renderNotesIndexRagSettings(containerEl: HTMLElement): void {
		
		// Top K
		new Setting(containerEl)
			.setName("RAG top k")
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
			.setName("Auto index notification")
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
					const progressBar = containerEl.createEl("progress", {
						attr: { value: 0, max: 100 }
					});
					const counterEl = containerEl.createSpan({
						text: "Indexing: 0%",
						cls: "indexing-counter"
					});

					try {
						await this.plugin.ragManager.indexNotes((progress) => {
							progressBar.value = progress * 100;
							counterEl.textContent = `   Indexing: ${Math.round(progress * 100)}%`;
							counterEl.addClass("indexing-counter-small");
						});
						new Notice("Indexing complete!");
						this.updateIndexedFilesCount();
					} catch (error) {
						console.error("Indexing error:", error);
						new Notice(error instanceof Error ? error.message : "Error during indexing. Check console for details.");
					} finally {
						button.setDisabled(false);
						progressBar.remove();
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

	}

	private renderIntegrationsSettings(containerEl: HTMLElement): void {

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
					.setDesc("Required for web search features (Tavily.com)")
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

	}

	private renderAboutSettings(containerEl: HTMLElement): void {

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
			.setDesc("Only used when the default source scope is tag")
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
						.setPlaceholder("Weekly review - YYYY-MM-DD")
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

	updateIndexedFilesCountAsync(): void {
		if (this.indexedCountTimer !== null) window.clearTimeout(this.indexedCountTimer);
		const target = this.indexedFilesCountSetting;
		const checkAndUpdate = () => {
			this.indexedCountTimer = null;
			if (!target || target !== this.indexedFilesCountSetting) return;
			if (this.plugin.ragManager?.isInitialized()) {
				this.updateIndexedFilesCount();
			} else {
				this.indexedCountTimer = window.setTimeout(checkAndUpdate, 100);
			}
		};
		this.indexedCountTimer = window.setTimeout(checkAndUpdate, 50);
	}

	private addHeading(containerEl: HTMLElement, name: string): void {
		new Setting(containerEl).setName(name).setHeading();
	}
}

interface TavilySearchResult {
	title: string;
	content: string;
	url: string;
	published_date?: string;
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

function getLLMErrorMessage(error: unknown, fallback: string): string {
	return error instanceof LLMClientError ? error.message : fallback;
}

async function processText(
	input: unknown,
	iprompt: string,
	plugin: OLocalLLMPlugin,
	target: TextActionTarget,
	mode: TextActionMode = "edit",
) {
	// Reset kill switch state at the beginning of each process
	plugin.isKillSwitchActive = false;

	new Notice("Generating response. This takes a few seconds..");
	plugin.statusBarItemEl?.setText("LLM Helper: Generating response...");

	const personaPrompt = plugin.personasDict[plugin.settings.personas]?.systemPrompt;
	const messages = buildTextActionMessages({
		instruction: iprompt,
		input,
		mode,
		personaPrompt,
	});

	try {
		let responseStr = await plugin.llmClient.complete({
			model: plugin.settings.llmModel,
			messages,
			temperature: plugin.settings.temperature,
			maxTokens: plugin.settings.maxTokens,
			bufferedStream: plugin.settings.stream,
		});

		if (plugin.settings.extractReasoningResponses) {
			const markers = parseReasoningMarkers(plugin.settings.reasoningMarkers || '');
			responseStr = extractActualResponse(responseStr, markers);
		}

		if (!plugin.isKillSwitchActive) {
			// Build the full output and insert it in one operation, so a
			// failed request can never leave dangling format markers behind
			let output = responseStr;
			if (plugin.settings.responseFormatting === true) {
				output = plugin.settings.responseFormatPrepend + output + plugin.settings.responseFormatAppend;
			}
			if (plugin.settings.outputMode === "append") {
				output = target.selectedText + "\n\n" + output;
			}
			if (applyTextActionResult(target, output)) {
				new Notice("Text generation complete. Voila!");
			} else {
				new Notice("Original selection changed; generated text was not inserted.");
			}
		} else {
			new Notice("Text generation stopped by kill switch");
			plugin.isKillSwitchActive = false;
		}
	} catch (error) {
		console.error("Error during request:", error);
		new Notice(getLLMErrorMessage(error, "Error generating text. Check plugin console for details."));
	}
	plugin.statusBarItemEl?.setText("LLM Helper: Ready");
}

export class LLMChatModal extends Modal {
	private renderScope = new ChatRenderScope();
	private activeRequestId = 0;
	private isSubmitting = false;
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
		this.renderScope.reset();
		const { contentEl } = this;

		contentEl.classList.add("llm-chat-modal");

		const chatContainer = contentEl.createDiv({ cls: "llm-chat-container" });
		const chatHistoryEl = chatContainer.createDiv({ cls: "llm-chat-history" });

		chatHistoryEl.classList.add("chatHistoryElStyle");

		// Display existing conversation history (if any)
		chatHistoryEl.createEl("h1", { text: "Chat with your local LLM" });

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
			.setValue(this.result)
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
		this.activeRequestId++;
		this.isSubmitting = false;
		this.renderScope.dispose();
		let { contentEl } = this;
		contentEl.empty();
	}

	updateSubmitButtonState() {
		if (this.isSubmitting || this.result.trim() === "") {
			this.submitButton.setDisabled(true);
			this.submitButton.buttonEl.classList.add("llm-chat-submit-button-disabled");
		} else {
			this.submitButton.setDisabled(false);
			this.submitButton.buttonEl.classList.remove("llm-chat-submit-button-disabled");
		}
	}

	// New method to handle submission
	async handleSubmit() {
		if (this.isSubmitting || this.result.trim() === "") {
			return;
		}

		const chatHistoryEl = this.contentEl.querySelector('.llm-chat-history');
		if (chatHistoryEl) {
			const requestId = ++this.activeRequestId;
			this.isSubmitting = true;
			const message = this.result;
			this.result = "";
			const textInputEl = this.contentEl.querySelector<HTMLInputElement>('.llm-chat-input');
			if (textInputEl) textInputEl.value = "";
			this.updateSubmitButtonState();
			try {
				await processChatInput(
					message,
					this.contentEl,
					chatHistoryEl as HTMLElement,
					this.conversationHistory,
					this.plugin,
					this.initialChatContext,
					this.renderScope,
					() => requestId === this.activeRequestId,
				);
			} finally {
				if (requestId === this.activeRequestId) {
					this.isSubmitting = false;
					this.updateSubmitButtonState();
					this.scrollToBottom();
				}
			}
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
	renderScope: ChatRenderScope,
	isCurrent: () => boolean,
) {
	const userMessageEl = chatHistoryEl.createDiv({ cls: "llmChatMessageStyleUser" });
	userMessageEl.setText(text);

	showThinkingIndicator(chatHistoryEl);
	scrollToBottom(chatContainer);

	try {
		const result = await submitGeneralChat(plugin, text, conversationHistory, initialChatContext);

		if (!isCurrent()) return;
		hideThinkingIndicator(chatHistoryEl);
		const renderedMessage = plugin.vaultAgent.renderAgentResponse(
			chatHistoryEl,
			result.response,
			result.context,
			{
				renderScope,
				messageClassName: "llmChatMessageStyleAI",
				scrollToBottom: () => scrollToBottom(chatContainer),
			},
		);
		recordConversationHistory(conversationHistory, text, renderedMessage, plugin.settings.maxConvHistory);
		new Notice("Chat response ready.");
		scrollToBottom(chatContainer);
	} catch (error) {
		if (!isCurrent()) return;
		console.error("Error during request:", error);
		new Notice(getLLMErrorMessage(error, "Error communicating with LLM server. Check plugin console for details."));
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
		contentEl.createEl("h2", { text: "Edit prompt" });

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

async function tavilySearch(
	query: string,
	topic: string,
	plugin: OLocalLLMPlugin,
): Promise<GroundedSearchResult[]> {
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

	const results = (response.json as TavilySearchResponse)?.results;
	if (!Array.isArray(results)) {
		throw new Error("Tavily search returned an unexpected response format.");
	}
	return results.map((result) => ({
		title: result.title,
		url: result.url,
		snippet: result.content,
		...(result.published_date ? { publishedAt: result.published_date } : {}),
	}));
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

function formatSearxngResults(response: SearxngSearchResponse): GroundedSearchResult[] {
	const results = response.results || [];
	return results
		.filter((result) => result.url && result.title)
		.slice(0, 5)
		.map((result): GroundedSearchResult => {
			const published = result.publishedDate || result.published_date;
			return {
				title: result.title!,
				url: result.url!,
				...(result.content ? { snippet: result.content } : {}),
				...(result.engines?.length ? { engines: result.engines } : {}),
				...(published ? { publishedAt: published } : {}),
			};
		});
}

function getSearchErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

async function searxngSearch(
	query: string,
	topic: string,
	plugin: OLocalLLMPlugin,
): Promise<GroundedSearchResult[]> {
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

	const results = formatSearxngResults(searchResponse);
	if (results.length === 0) {
		throw new Error("SearXNG search returned no usable results.");
	}
	return results;
}

function validateSearchProvider(settings: OLocalLLMSettings): string | null {
	const provider = settings.searchProvider;
	if (provider === "tavily" && !settings.tavilyApiKey) {
		return "Please set your Tavily API key in settings";
	}
	if (provider === "brave" && !settings.braveSearchApiKey) {
		return "Please set your Brave Search API key in settings";
	}
	if (provider === "searxng" && !settings.searxngInstanceUrl) {
		return "Please set your SearXNG instance URL in settings";
	}
	return null;
}

async function processWebSearch(
	query: string,
	plugin: OLocalLLMPlugin,
	target: TextActionTarget,
) {
	const provider = plugin.settings.searchProvider;

	const providerError = validateSearchProvider(plugin.settings);
	if (providerError) {
		new Notice(providerError);
		return;
	}

	new Notice("Searching the web...");

	try {
		let results: GroundedSearchResult[];

		if (provider === "tavily") {
			results = await tavilySearch(query, "general", plugin);
		} else if (provider === "searxng") {
			results = await searxngSearch(query, "general", plugin);
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

			const searchResults = (response.json as { web?: { results?: BraveWebResult[] } })?.web?.results;
			if (!Array.isArray(searchResults)) {
				throw new Error("Brave search returned an unexpected response format.");
			}
			results = searchResults.map((result) => ({
				title: result.title,
				url: result.url,
				snippet: result.description,
				...(result.extra_snippets?.length
					? { additionalSnippets: result.extra_snippets }
					: {}),
			}));
		}
		if (results.length === 0) {
			throw new Error("Web search returned no usable results.");
		}
		const searchMaterial = buildSearchMaterial({ query, results });
		if (searchMaterial.results.length === 0) {
			throw new Error("Web search returned no results with valid source URLs.");
		}

		void processText(
			searchMaterial,
			WEB_SEARCH_SYNTHESIS_PROMPT,
			plugin,
			target,
			"web-search",
		);

	} catch (error) {
		console.error("Web search error:", error);
		new Notice(getSearchErrorMessage(error, "Web search failed. Check console for details."));
	}
}

async function processNewsSearch(
	query: string,
	plugin: OLocalLLMPlugin,
	target: TextActionTarget,
) {
	const provider = plugin.settings.searchProvider;

	const providerError = validateSearchProvider(plugin.settings);
	if (providerError) {
		new Notice(providerError);
		return;
	}

	new Notice("Searching for news...");

	try {
		let results: GroundedSearchResult[];

		if (provider === "tavily") {
			results = await tavilySearch(query, "news", plugin);
		} else if (provider === "searxng") {
			results = await searxngSearch(query, "news", plugin);
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

			const newsResults = (response.json as { results?: BraveNewsResult[] })?.results;
			if (!Array.isArray(newsResults)) {
				throw new Error("Brave news search returned an unexpected response format.");
			}
			results = newsResults.map((result) => ({
				title: result.title,
				url: result.url,
				snippet: result.description,
				...(result.published_time ? { publishedAt: result.published_time } : {}),
			}));
		}
		if (results.length === 0) {
			throw new Error("News search returned no usable results.");
		}
		const runTimestamp = new Date().toISOString();
		const searchMaterial = buildSearchMaterial({ query, results, runTimestamp });
		if (searchMaterial.results.length === 0) {
			throw new Error("News search returned no results with valid source URLs.");
		}

		void processText(
			searchMaterial,
			NEWS_SEARCH_SYNTHESIS_PROMPT,
			plugin,
			target,
			"news-search",
		);
	} catch (error) {
		console.error("News search error:", error);
		new Notice(getSearchErrorMessage(error, "News search failed. Check console for details."));
	}
}
