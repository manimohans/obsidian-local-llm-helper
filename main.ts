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
	View,
	requestUrl,
	setIcon,
	TextComponent,
	ButtonComponent,
} from "obsidian";
import { generateAndAppendTags } from "./src/autoTagger";
import { UpdateNoticeModal } from "./src/updateNoticeModal";
import { RAGManager } from './src/rag';
import { BacklinkGenerator } from './src/backlinkGenerator';
import { RAGChatModal } from './src/ragChatModal';
import { PromptPickerModal } from './src/promptPickerModal';
import { Persona, PersonasDict, DEFAULT_PERSONAS, buildPersonasDict, modifyPrompt } from './src/personas';
import { CustomPrompt, generatePromptId, SelectPromptModal } from './src/customPrompts';
import { extractActualResponse, parseReasoningMarkers, DEFAULT_REASONING_MARKERS } from './src/reasoningExtractor';

// Remember to rename these classes and interfaces!

export interface OLocalLLMSettings {
	serverAddress: string;
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
	searchProvider: string;
	tavilyApiKey: string;
	savedPersonas?: { [key: string]: Persona };
	customPrompts?: CustomPrompt[];
	extractReasoningResponses?: boolean;
	reasoningMarkers?: string;
	ragTopK: number;
	autoIndexIntervalMinutes: number;
	autoNotice: boolean;
}

interface ConversationEntry {
	prompt: string;
	response: string;
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "http://localhost:11434",
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
	searchProvider: "tavily",
	tavilyApiKey: "",
	savedPersonas: undefined,
	customPrompts: [],
	extractReasoningResponses: false,
	reasoningMarkers: JSON.stringify(DEFAULT_REASONING_MARKERS, null, 2),
	ragTopK: 5,
	autoIndexIntervalMinutes: 0,   // 0 = disabled
	autoNotice: false,
};

function normalizeServerAddress(address: string): string {
	const trimmed = address.trim();
	if (!trimmed) return trimmed;
	if (!/^https?:\/\//i.test(trimmed)) {
		return "http://" + trimmed;
	}
	// Strip trailing slash
	return trimmed.replace(/\/+$/, '');
}

export default class OLocalLLMPlugin extends Plugin {
	settings: OLocalLLMSettings;
	modal: any;
	conversationHistory: ConversationEntry[] = [];
	isKillSwitchActive: boolean = false;
	autoIndexTimer: number | undefined;
	isIndexing: boolean = false;
	public ragManager: RAGManager;
	private backlinkGenerator: BacklinkGenerator;
	public personasDict: PersonasDict = {};
	private registeredPromptCommands: Set<string> = new Set();

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
		console.log('🔌 LLM Helper: Plugin loading...');
		await this.loadSettings();
		this.registerCustomPromptCommands();
		console.log('⚙️ LLM Helper: Settings loaded:', {
			provider: this.settings.providerType,
			server: this.settings.serverAddress,
			embeddingModel: this.settings.embeddingModelName,
			llmModel: this.settings.llmModel
		});
		this.checkForUpdates();
		// Validate server configuration
		this.validateServerConfiguration();

		console.log('🧠 LLM Helper: Initializing RAGManager...');
		// Initialize RAGManager
		this.ragManager = new RAGManager(this.app.vault, this.settings, this);
		
		// Initialize RAGManager and show user notification about loaded data
		await this.ragManager.initialize();
		this.startAutoIndexTimer();
		
		// Show user-friendly notification about loaded embeddings after a short delay
		// This ensures all UI elements are ready
		setTimeout(() => {
			this.showStorageNotification();
		}, 500);

		// Initialize BacklinkGenerator
		this.backlinkGenerator = new BacklinkGenerator(this.ragManager, this.app.vault);

		// Add command for RAG Backlinks
		this.addCommand({
			id: 'generate-rag-backlinks',
			name: 'Notes: Generate backlinks',
			callback: this.handleGenerateBacklinks.bind(this),
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
				new Notice("Make sure you have indexed your notes before using this feature.");
				const ragChatModal = new RAGChatModal(this.app, this.settings, this.ragManager);
				ragChatModal.open();
			},
		});

		this.addCommand({
			id: "summarize-selected-text",
			name: "Text: Summarize",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						"Summarize the following text concisely. Preserve markdown formatting:",
						this
					);
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
					processText(
						selectedText,
						"Rewrite the following text to be more professional and polished. Preserve markdown formatting:",
						this
					);
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
					processText(
						selectedText,
						"Generate a clear list of action items from the following text. Use bullet points or numbers as appropriate:",
						this
					);
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
					processText(
						selectedText,
						this.settings.customPrompt,
						this
					);
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
					processText(
						selectedText,
						"Respond to the following prompt:",
						this
					);
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
					processText(selectedText, prompt, this);
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
					processText(selectedText, chosen.prompt, this);
				}).open();
			},
		});

		this.addCommand({
			id: "llm-chat",
			name: "Chat: General",
			callback: () => {
				const chatModal = new LLMChatModal(this.app, this);
				chatModal.open();
			},
		});

		this.addCommand({
			id: "llm-hashtag",
			name: "Text: Generate tags",
			callback: () => {
				generateAndAppendTags(this.app, this.settings);
			},
		});

		this.addCommand({
			id: "web-search-selected-text",
			name: "Web: Search",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false;
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processWebSearch(selectedText, this);
				}
			},
		});

		this.addCommand({
			id: "web-news-search",
			name: "Web: Search news",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processNewsSearch(selectedText, this);
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
						new LLMChatModal(this.app, this).open();
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Chat with notes (RAG)")
					.setIcon("book-open")
					.onClick(() => {
						new Notice("Make sure you have indexed your notes before using this feature.");
						new RAGChatModal(this.app, this.settings, this.ragManager).open();
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
							processText(selectedText, prompt, this);
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
							processText(
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
							processText(
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
							processText(
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
							generateAndAppendTags(this.app, this.settings);
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
							processText(
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
							processText(
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
							processText(selectedText, chosen.prompt, this);
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
							processWebSearch(selectedText, this);
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
							processNewsSearch(selectedText, this);
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

			menu.showAtMouseEvent(event as MouseEvent);
		});

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("LLM Helper: Ready");

		this.addSettingTab(new OLLMSettingTab(this.app, this));
	}

	private validateServerConfiguration(): boolean {
		const serverAddress = this.settings.serverAddress;
		const llmModel = this.settings.llmModel;
		const embeddingModel = this.settings.embeddingModelName;

		console.log(`Configuration - Server: ${serverAddress}, LLM: ${llmModel}, Embeddings: ${embeddingModel}`);
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

	onunload() { }

	startAutoIndexTimer() {
		if (this.autoIndexTimer) {
			clearInterval(this.autoIndexTimer);
			this.autoIndexTimer = undefined;
		}
		const minutes = this.settings.autoIndexIntervalMinutes;
		if (minutes > 0) {
			this.autoIndexTimer = this.registerInterval(
				window.setInterval(async () => {
					if (this.isIndexing) {
						console.log("LLM Helper: Skipping auto-index, indexxing already in progress.");
						return;
					}
					console.log("LLM Helper: Auto-indexing notes...");
					if(this.settings.autoNotice) {
						new Notice("LLM Helper: Auto-indexing notes...");
					}
					this.isIndexing = true;
					try {
						await this.ragManager.indexNotes(() => {});
						if(this.settings.autoNotice) {
							new Notice("LLM Helper: Auto-index complete.");
						}
						console.log("LLM Helper: Auto-index complete.");
					} catch (error) {
						console.log("LLM Helper: Auto-index error:", error);
					} finally {
						this.isIndexing = false;
					}
				}, minutes * 60 * 1000)
			);
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

		this.settings.serverAddress = normalizeServerAddress(this.settings.serverAddress);
		this.rebuildPersonas();

		console.log('✅ LLM Helper: Final settings after merge:', {
			provider: this.settings.providerType,
			server: this.settings.serverAddress,
			embeddingModel: this.settings.embeddingModelName,
			llmModel: this.settings.llmModel,
			hasApiKey: !!this.settings.openAIApiKey,
			hasBraveKey: !!this.settings.braveSearchApiKey
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);

		// Update RAG manager with new settings
		if (this.ragManager) {
			this.ragManager.updateSettings(this.settings);
			this.startAutoIndexTimer();
		}
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
					processText(selectedText, customPrompt.prompt, this);
				}
			},
		});
		this.registeredPromptCommands.add(commandId);
	}

	unregisterPromptCommand(id: string) {
		const commandId = `ollm-helper:${id}`;
		(this.app as any).commands.removeCommand(commandId);
		this.registeredPromptCommands.delete(commandId);
	}

	refreshCustomPromptCommands() {
		// Unregister all existing custom prompt commands
		for (const commandId of this.registeredPromptCommands) {
			(this.app as any).commands.removeCommand(commandId);
		}
		this.registeredPromptCommands.clear();

		// Re-register all
		this.registerCustomPromptCommands();
	}


	async indexNotes() {
		new Notice('Indexing notes for RAG...');

		if (this.isIndexing) {
			console.log("LLM Helper: Skipping auto-index, indexxing already in progress.");
			return;
		}
		this.isIndexing = true;
		try {
			await this.ragManager.indexNotes(progress => {
				// You can use the progress value here if needed
				console.log(`Indexing progress: ${progress * 100}%`);
			});
			new Notice('Notes indexed successfully!');
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
		const backlinks = await this.backlinkGenerator.generateBacklinks(selectedText);

		if (backlinks.length > 0) {
			editor.replaceSelection(`${selectedText}\n\nRelated:\n${backlinks.join('\n')}`);
			new Notice(`Generated ${backlinks.length} backlinks`);
		} else {
			new Notice('No relevant backlinks found');
		}
	}

	async handleDiagnostics() {
		console.log('🔍 === RAG STORAGE DIAGNOSTICS ===');
		
		// Plugin settings diagnostics
		console.log('📋 Plugin Settings:');
		console.log('  Provider:', this.settings.providerType);
		console.log('  Server:', this.settings.serverAddress);
		console.log('  Embedding Model:', this.settings.embeddingModelName);
		console.log('  LLM Model:', this.settings.llmModel);
		
		// RAG storage diagnostics
		try {
			const stats = await this.ragManager.getStorageStats();
			console.log('💾 RAG Storage Stats:');
			console.log('  Total Embeddings:', stats.totalEmbeddings);
			console.log('  Indexed Files:', stats.indexedFiles);
			console.log('  Last Indexed:', stats.lastIndexed);
			console.log('  Storage Used:', stats.storageUsed);
			console.log('  Current Indexed Count:', this.ragManager.getIndexedFilesCount());
			
			// Show user-friendly notice
			new Notice(`RAG Diagnostics: ${stats.totalEmbeddings} embeddings, ${stats.indexedFiles} files. Check console for details.`);
		} catch (error) {
			console.error('❌ Error getting storage stats:', error);
			new Notice('Error getting storage stats. Check console for details.');
		}
		
		// File system diagnostics
		const totalMdFiles = this.app.vault.getMarkdownFiles().length;
		console.log('📁 Vault Stats:');
		console.log('  Total Markdown Files:', totalMdFiles);
		console.log('  Plugin Settings Path:', `${this.manifest.dir}/data.json`);
		console.log('  Embeddings Storage Path:', `${this.manifest.dir}/embeddings.json`);
		
		console.log('🔍 === END DIAGNOSTICS ===');
	}

	async showStorageNotification() {
		try {
			const stats = await this.ragManager.getStorageStats();
			if (stats.totalEmbeddings > 0) {
				new Notice(`📚 Loaded ${stats.totalEmbeddings} embeddings from ${stats.indexedFiles} files (${stats.storageUsed})`);
			} else {
				new Notice('📝 No previous embeddings found - ready to index notes');
			}
		} catch (error) {
			console.error('Error showing storage notification:', error);
		}
	}
}

async function fetchAvailableModels(settings: OLocalLLMSettings): Promise<string[]> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (settings.openAIApiKey && settings.openAIApiKey !== "not-needed") {
		headers["Authorization"] = `Bearer ${settings.openAIApiKey}`;
	}

	const response = await requestUrl({
		url: `${settings.serverAddress}/v1/models`,
		method: "GET",
		headers,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Server returned ${response.status}`);
	}

	const data = response.json;
	if (!data?.data || !Array.isArray(data.data)) {
		throw new Error("Unexpected response format");
	}

	return data.data.map((m: any) => m.id).filter(Boolean).sort();
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
	private saveTimeout: NodeJS.Timeout | null = null;

	constructor(app: App, plugin: OLocalLLMPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Debounced save to prevent lag when typing
	private debouncedSave() {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}
		this.saveTimeout = setTimeout(() => {
			this.plugin.saveSettings();
		}, 500);
	}

	// Flush any pending debounced save when settings tab is closed
	hide() {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
			this.plugin.saveSettings();
		}
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// ═══════════════════════════════════════════════════════════
		// CONNECTION
		// ═══════════════════════════════════════════════════════════
		containerEl.createEl("h3", { text: "Connection" });

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
			.setName("Server URL")
			.setDesc("Ollama: localhost:11434 | LM Studio: localhost:1234 | vLLM: localhost:8000")
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
				.setName("API Key")
				.setDesc("Required for OpenAI. For local servers, use 'not-needed'")
				.addText(text => text
					.setPlaceholder("not-needed")
					.setValue(this.plugin.settings.openAIApiKey || '')
					.onChange((value) => {
						this.plugin.settings.openAIApiKey = value;
						this.debouncedSave();
					})
				);
		}

		// ═══════════════════════════════════════════════════════════
		// MODELS
		// ═══════════════════════════════════════════════════════════
		containerEl.createEl("h3", { text: "Models" });

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
						const models = await fetchAvailableModels(this.plugin.settings);
						if (models.length === 0) {
							new Notice("No models found on server");
							return;
						}
						new ModelPickerModal(this.app, models, (model) => {
							this.plugin.settings.llmModel = model;
							chatModelText.setValue(model);
							this.plugin.saveSettings();
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
						const models = await fetchAvailableModels(this.plugin.settings);
						if (models.length === 0) {
							new Notice("No models found on server");
							return;
						}
						new ModelPickerModal(this.app, models, (model) => {
							this.plugin.settings.embeddingModelName = model;
							embeddingModelText.setValue(model);
							this.plugin.saveSettings();
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
		containerEl.createEl("h3", { text: "Chat" });

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
			const promptSetting = new Setting(containerEl)
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
				.setDisabled(selectedPersonaKey === "default" || DEFAULT_PERSONAS.hasOwnProperty(selectedPersonaKey) && !this.plugin.settings.savedPersonas?.[selectedPersonaKey])
				.onClick(async () => {
					if (DEFAULT_PERSONAS.hasOwnProperty(selectedPersonaKey)) {
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

		// ═══════════════════════════════════════════════════════════
		// OUTPUT
		// ═══════════════════════════════════════════════════════════
		containerEl.createEl("h3", { text: "Output" });

		new Setting(containerEl)
			.setName("Streaming")
			.setDesc("Show response word by word as it generates. Your server must have CORS enabled for streaming to work.")
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
		containerEl.createEl("h3", { text: "Custom Prompt" });

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
		containerEl.createEl("h3", { text: "Saved Prompts" });

		const savedPrompts = this.plugin.settings.customPrompts || [];

		if (savedPrompts.length > 0) {
			for (const sp of savedPrompts) {
				new Setting(containerEl)
					.setName(sp.title)
					.setDesc(sp.prompt.length > 80 ? sp.prompt.substring(0, 80) + "..." : sp.prompt)
					.addButton(btn => btn
						.setButtonText("Edit")
						.onClick(() => {
							new EditPromptModal(this.app, sp, async (updated) => {
								sp.title = updated.title;
								sp.prompt = updated.prompt;
								sp.updatedAt = Date.now();
								// Regenerate ID if title changed
								sp.id = generatePromptId(updated.title);
								this.plugin.refreshCustomPromptCommands();
								await this.plugin.saveSettings();
								new Notice("Prompt updated");
								this.display();
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
		containerEl.createEl("h3", { text: "Notes Index (RAG)" });
		
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
			.setDesc("Automatically re-index notes every N minutes. Set to 0 to disable.")
			.addText(text => text
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
			.setName("Index notes")
			.setDesc("Build searchable index of all notes in vault")
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

					const totalFiles = this.app.vault.getMarkdownFiles().length;
					let processedFiles = 0;

					try {
						await this.plugin.ragManager.indexNotes((progress) => {
							if (this.indexingProgressBar) {
								this.indexingProgressBar.value = progress * 100;
							}
							processedFiles = Math.floor(progress * totalFiles);
							counterEl.textContent = `   Processing: ${processedFiles}/${totalFiles}`;
							counterEl.style.fontSize = 'smaller';
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
			.setName("Indexed files")
			.setDesc("Number of files in current index")
			.addText(text => text
				.setValue("Loading...")
				.setDisabled(true));

		this.updateIndexedFilesCountAsync();

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
		containerEl.createEl("h3", { text: "Integrations" });

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
		containerEl.createEl("h3", { text: "About" });

		new Setting(containerEl)
			.setName("Version")
			.setDesc(`Local LLM Helper v${this.plugin.manifest.version}`)
			.addButton(btn => btn
				.setButtonText("View changelog")
				.onClick(() => {
					new UpdateNoticeModal(this.app, this.plugin.manifest.version).open();
				}));
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
				setTimeout(checkAndUpdate, 100);
			}
		};
		
		// Start checking after a short delay
		setTimeout(checkAndUpdate, 50);
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
	const statusBarItemEl = document.querySelector(
		".status-bar .status-bar-item"
	);
	if (statusBarItemEl) {
		statusBarItemEl.textContent = "LLM Helper: Generating response...";
	} else {
		console.error("Status bar item element not found");
	}

	let prompt = modifyPrompt(iprompt, plugin.settings.personas, plugin.personasDict);

	console.log("prompt", prompt + ": " + selectedText);

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
			modifySelectedText(selectedText + "\n\n");
		}
		if (plugin.settings.responseFormatting === true) {
			modifySelectedText(plugin.settings.responseFormatPrepend);
		}
		if (plugin.settings.stream) {
			const streamHeaders: Record<string, string> = { "Content-Type": "application/json" };
			if (plugin.settings.openAIApiKey && plugin.settings.openAIApiKey !== "not-needed") {
				streamHeaders["Authorization"] = `Bearer ${plugin.settings.openAIApiKey}`;
			}
			const response = await fetch(
				`${plugin.settings.serverAddress}/v1/chat/completions`,
				{
					method: "POST",
					headers: streamHeaders,
					body: JSON.stringify(body),
				}
			);

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error("Authentication failed (401). Check your API key in plugin settings.");
				}
				throw new Error(
					"Error summarizing text (Fetch): " + response.statusText
				);
			}

			const reader = response.body && response.body.getReader();
			let responseStr = "";
			if (!reader) {
				console.error("Reader not found");
			} else {
				const decoder = new TextDecoder();

				const readChunk = async () => {
					if (plugin.isKillSwitchActive) {
						reader.cancel();
						new Notice("Text generation stopped by kill switch");
						plugin.isKillSwitchActive = false; // Reset the kill switch
						return;
					}

					const { done, value } = await reader.read();

					if (done) {
						new Notice("Text generation complete. Voila!");
						// Apply reasoning extraction to accumulated response for conversation history
						let finalResponse = responseStr;
						if (plugin.settings.extractReasoningResponses) {
							const markers = parseReasoningMarkers(plugin.settings.reasoningMarkers || '');
							finalResponse = extractActualResponse(responseStr, markers);
						}
						updateConversationHistory(prompt + ": " + selectedText, finalResponse, plugin.conversationHistory, plugin.settings.maxConvHistory);
						if (plugin.settings.responseFormatting === true) {
							modifySelectedText(plugin.settings.responseFormatAppend);
						}
						return;
					}

					let textChunk = decoder.decode(value);
					const lines = textChunk.split("\n");

					for (const line of lines) {
						if (line.trim()) {
							try {
								let modifiedLine = line.replace(
									/^data:\s*/,
									""
								);
								if (modifiedLine !== "[DONE]") {
									const data = JSON.parse(modifiedLine);
									// Skip delta.reasoning field (separate reasoning stream)
									if (data.choices[0].delta.content) {
										let word =
											data.choices[0].delta.content;
										modifySelectedText(word);
										responseStr += word;
									}
								}
							} catch (error) {
								console.error(
									"Error parsing JSON chunk:",
									error
								);
							}
						}
					}
					readChunk();
				};
				readChunk();
			}
		} else {
			const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };
			if (plugin.settings.openAIApiKey && plugin.settings.openAIApiKey !== "not-needed") {
				reqHeaders["Authorization"] = `Bearer ${plugin.settings.openAIApiKey}`;
			}
			const response = await requestUrl({
				url: `${plugin.settings.serverAddress}/v1/chat/completions`,
				method: "POST",
				headers: reqHeaders,
				body: JSON.stringify(body),
			});

			const statusCode = response.status;

			if (statusCode >= 200 && statusCode < 300) {
				const data = await response.json;
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

				console.log(summarizedText);
				updateConversationHistory(prompt + ": " + selectedText, summarizedText, plugin.conversationHistory, plugin.settings.maxConvHistory);
				new Notice("Text generated. Voila!");
				if (!plugin.isKillSwitchActive) {
					if (plugin.settings.responseFormatting === true) {
						modifySelectedText(summarizedText + plugin.settings.responseFormatAppend);
					} else {
						modifySelectedText(summarizedText);
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

function modifySelectedText(text: any) {
	let view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		new Notice("No active view");
	} else {
		let view_mode = view.getMode();
		switch (view_mode) {
			case "preview":
				new Notice("Cannot summarize in preview");
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
	submitButton: ButtonComponent;

	constructor(app: App, plugin: OLocalLLMPlugin) {
		super(app);
		this.plugin = plugin;
		this.pluginSettings = plugin.settings;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.classList.add("llm-chat-modal");

		const chatContainer = contentEl.createDiv({ cls: "llm-chat-container" });
		const chatHistoryEl = chatContainer.createDiv({ cls: "llm-chat-history" });

		chatHistoryEl.classList.add("chatHistoryElStyle");

		// Display existing conversation history (if any)
		chatHistoryEl.createEl("h1", { text: "Chat with your Local LLM" });

		const personasInfoEl = document.createElement('div');
		personasInfoEl.classList.add("personasInfoStyle");
		const currentPersona = this.plugin.personasDict[this.pluginSettings.personas];
		personasInfoEl.innerText = "Current persona: " + (currentPersona ? currentPersona.displayName : "Default");
		chatHistoryEl.appendChild(personasInfoEl);

		// Update this part to use conversationHistory
		this.conversationHistory.forEach((entry) => {
			const userMessageEl = chatHistoryEl.createEl("p", { text: "You: " + entry.prompt });
			userMessageEl.classList.add('llmChatMessageStyleUser');
			const aiMessageEl = chatHistoryEl.createEl("p", { text: "LLM Helper: " + entry.response });
			aiMessageEl.classList.add('llmChatMessageStyleAI');
		});

		const inputContainer = contentEl.createDiv({ cls: "llm-chat-input-container" });

		const inputRow = inputContainer.createDiv({ cls: "llm-chat-input-row" });

		const askLabel = inputRow.createSpan({ text: "Ask:", cls: "llm-chat-ask-label" });

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
				this.handleSubmit();
			}
		});

		this.submitButton = new ButtonComponent(inputRow)
			.setButtonText("Submit")
			.setCta()
			.onClick(() => this.handleSubmit());
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
				this.pluginSettings.personas,
				this.contentEl,
				chatHistoryEl as HTMLElement,
				this.conversationHistory,
				this.pluginSettings,
				this.plugin.personasDict
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

async function processChatInput(text: string, personas: string, chatContainer: HTMLElement, chatHistoryEl: HTMLElement, conversationHistory: ConversationEntry[], pluginSettings: OLocalLLMSettings, personasDict: PersonasDict) {
	const { contentEl } = this; // Assuming 'this' refers to the LLMChatModal instance

	// Add user's question to conversation history
	conversationHistory.push({ prompt: text, response: "" });
	if (chatHistoryEl) {
		const chatElement = document.createElement('div');
		chatElement.classList.add('llmChatMessageStyleUser');
		chatElement.innerHTML = text;
		chatHistoryEl.appendChild(chatElement);
	}

	showThinkingIndicator(chatHistoryEl);
	scrollToBottom(chatContainer);

	text = modifyPrompt(text, personas, personasDict);
	console.log(text);

	try {
		const body = {
			model: pluginSettings.llmModel,
			messages: [
				{ role: "system", content: "You are a helpful writing assistant. Provide clear, concise responses. When editing text, preserve the author's voice unless asked to change it." },
				...conversationHistory.slice(-pluginSettings.maxConvHistory).reduce((acc, entry) => {
					acc.push({ role: "user", content: entry.prompt });
					acc.push({ role: "assistant", content: entry.response });
					return acc;
				}, [] as { role: string; content: string }[]),
				{ role: "user", content: text },
			],
			temperature: pluginSettings.temperature,
			max_tokens: pluginSettings.maxTokens,
			stream: false, // Set to false for chat window
		};

		const chatHeaders: Record<string, string> = { "Content-Type": "application/json" };
		if (pluginSettings.openAIApiKey && pluginSettings.openAIApiKey !== "not-needed") {
			chatHeaders["Authorization"] = `Bearer ${pluginSettings.openAIApiKey}`;
		}
		const response = await requestUrl({
			url: `${pluginSettings.serverAddress}/v1/chat/completions`,
			method: "POST",
			headers: chatHeaders,
			body: JSON.stringify(body),
		});

		const statusCode = response.status;

		if (statusCode >= 200 && statusCode < 300) {
			const data = await response.json;
			let llmResponse = data.choices[0].message.content;

			// Strip reasoning markers if enabled
			if (pluginSettings.extractReasoningResponses) {
				const markers = parseReasoningMarkers(pluginSettings.reasoningMarkers || '');
				llmResponse = extractActualResponse(llmResponse, markers);
			}

			// Convert LLM response to HTML
			let formattedResponse = llmResponse;
			//conver to html - bold
			formattedResponse = formattedResponse.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
			formattedResponse = formattedResponse.replace(/_(.*?)_/g, "<i>$1</i>");
			formattedResponse = formattedResponse.replace(/\n\n/g, "<br><br>");

			console.log("formattedResponse", formattedResponse);

			// Create response container
			const responseContainer = document.createElement('div');
			responseContainer.classList.add('llmChatMessageStyleAI');

			// Create response text element
			const responseTextEl = document.createElement('div');
			responseTextEl.innerHTML = formattedResponse;
			responseContainer.appendChild(responseTextEl);

			// Create copy button
			const copyButton = document.createElement('button');
			copyButton.classList.add('copy-button');
			setIcon(copyButton, 'copy');
			copyButton.addEventListener('click', () => {
				navigator.clipboard.writeText(llmResponse).then(() => {
					new Notice('Copied to clipboard!');
				});
			});
			responseContainer.appendChild(copyButton);

			// Add response container to chat history
			chatHistoryEl.appendChild(responseContainer);

			// Add LLM response to conversation history with Markdown
			updateConversationHistory(text, formattedResponse, conversationHistory, pluginSettings.maxConvHistory);

			hideThinkingIndicator(chatHistoryEl);

			// Scroll to bottom after response is generated
			scrollToBottom(chatContainer);

		} else {
			throw new Error(
				"Error getting response from LLM server: " + response.text
			);
		}
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
	const thinkingIndicatorEl = document.createElement('div');
	thinkingIndicatorEl.classList.add('thinking-indicator');
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
	thinkingIndicatorEl.innerHTML = tStr[randomIndex] + '<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span>'; // Inline HTML

	chatHistoryEl.appendChild(thinkingIndicatorEl);
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
	const body: any = {
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

	const results = response.json.results;
	return results.map((result: any) =>
		`${result.title}\n${result.content}\nSource: ${result.url}\n\n`
	).join('');
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

	new Notice("Searching the web...");

	try {
		let context: string;

		if (provider === "tavily") {
			context = await tavilySearch(query, "general", plugin);
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

			const searchResults = response.json.web.results;
			context = searchResults.map((result: any) => {
				let snippets = result.extra_snippets ?
					'\nAdditional Context:\n' + result.extra_snippets.join('\n') : '';
				return `${result.title}\n${result.description}${snippets}\nSource: ${result.url}\n\n`;
			}).join('');
		}

		processText(
			`Search results for "${query}":\n\n${context}`,
			"Summarize these search results concisely. Use bullet points for key facts and cite sources inline as [Source](url).",
			plugin
		);

	} catch (error) {
		console.error("Web search error:", error);
		new Notice("Web search failed. Check console for details.");
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

	new Notice("Searching for news...");

	try {
		let context: string;

		if (provider === "tavily") {
			context = await tavilySearch(query, "news", plugin);
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

			const newsResults = response.json.results;
			context = newsResults.map((result: any) =>
				`${result.title}\n${result.description}\nSource: ${result.url}\nPublished: ${result.published_time}\n\n`
			).join('');
		}

		processText(
			`News results for "${query}":\n\n${context}`,
			"Summarize these news results concisely. List key developments as bullet points and cite sources inline as [Source](url).",
			plugin
		);
	} catch (error) {
		console.error("News search error:", error);
		new Notice("News search failed. Check console for details.");
	}
}
