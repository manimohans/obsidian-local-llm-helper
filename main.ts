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
	openAIApiKey: "lm-studio"
};

const personasDict: { [key: string]: string } = {
	"default": "Default",
	"physics": "Physics expert",
	"fitness": "Fitness expert",
	"developer": "Software Developer",
	"stoic": "Stoic Philosopher",
	"productmanager": "Product Manager",
	"techwriter": "Technical Writer",
	"creativewriter": "Creative Writer",
	"tpm": "Technical Program Manager",
	"engineeringmanager": "Engineering Manager",
	"executive": "Executive",
	"officeassistant": "Office Assistant"
};

export default class OLocalLLMPlugin extends Plugin {
	settings: OLocalLLMSettings;
	modal: any;
	conversationHistory: ConversationEntry[] = [];
	isKillSwitchActive: boolean = false;
	public ragManager: RAGManager;
	private backlinkGenerator: BacklinkGenerator;

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
			id: "llm-chat",
			name: "Chat: General",
			callback: () => {
				const chatModal = new LLMChatModal(this.app, this.settings);
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
						new LLMChatModal(this.app, this.settings).open();
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

	async loadSettings() {
		console.log('📂 LLM Helper: Loading plugin settings...');
		const savedData = await this.loadData();
		console.log('💾 LLM Helper: Raw saved data:', savedData);
		
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			savedData
		);
		
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
		}
	}


	async indexNotes() {
		new Notice('Indexing notes for RAG...');
		try {
			await this.ragManager.indexNotes(progress => {
				// You can use the progress value here if needed
				console.log(`Indexing progress: ${progress * 100}%`);
			});
			new Notice('Notes indexed successfully!');
		} catch (error) {
			console.error('Error indexing notes:', error);
			new Notice('Failed to index notes. Check console for details.');
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
						this.plugin.settings.serverAddress = value;
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

		new Setting(containerEl)
			.setName("Chat model")
			.setDesc("Model for chat and text processing (e.g., llama3, gpt-4, mistral)")
			.addText((text) =>
				text
					.setPlaceholder("llama3")
					.setValue(this.plugin.settings.llmModel)
					.onChange((value) => {
						this.plugin.settings.llmModel = value;
						this.debouncedSave();
					})
			);

		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc("Model for RAG indexing (e.g., nomic-embed-text, mxbai-embed-large)")
			.addText((text) =>
				text
					.setPlaceholder("mxbai-embed-large")
					.setValue(this.plugin.settings.embeddingModelName)
					.onChange((value) => {
						this.plugin.settings.embeddingModelName = value;
						this.debouncedSave();
					})
			);

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
				for (const key in personasDict) {
					if (personasDict.hasOwnProperty(key)) {
						dropdown.addOption(key, personasDict[key]);
					}
				}
				dropdown.setValue(this.plugin.settings.personas)
					.onChange(async (value) => {
						this.plugin.settings.personas = value;
						await this.plugin.saveSettings();
					});
			});

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
			.setDesc("Show response word by word as it generates")
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
		// NOTES INDEX (RAG)
		// ═══════════════════════════════════════════════════════════
		containerEl.createEl("h3", { text: "Notes Index (RAG)" });

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

		new Setting(containerEl)
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

export function modifyPrompt(aprompt: string, personas: string): string {
	const personaPrompts: { [key: string]: string } = {
		"physics": "You are a physics expert. Explain using scientific principles. Include equations when helpful. Make complex topics accessible.\n\n",
		"fitness": "You are a fitness expert. Give evidence-based advice. Consider safety and individual limitations. Be practical.\n\n",
		"developer": "You are a senior software developer. Write clean, maintainable code. Consider edge cases and explain technical tradeoffs.\n\n",
		"stoic": "You are a stoic philosopher. Focus on what's within one's control. Offer perspective and encourage rational thinking over emotional reactions.\n\n",
		"productmanager": "You are a product manager. Focus on user needs. Prioritize ruthlessly. Think in outcomes and metrics, not features.\n\n",
		"techwriter": "You are a technical writer. Be precise and structured. Define jargon. Write for the least technical reader.\n\n",
		"creativewriter": "You are a creative writer. Use vivid language and strong imagery. Show rather than tell.\n\n",
		"tpm": "You are a technical program manager. Break down complexity. Identify dependencies and risks. Bridge technical and non-technical audiences.\n\n",
		"engineeringmanager": "You are an engineering manager. Balance technical excellence with team health. Think about scalability. Communicate with empathy.\n\n",
		"executive": "You are a C-level executive. Think strategically. Focus on business impact. Be concise with clear recommendations.\n\n",
		"officeassistant": "You are an office assistant. Be helpful and organized. Anticipate needs. Provide actionable next steps.\n\n",
	};

	const prefix = personaPrompts[personas];
	return prefix ? prefix + aprompt : aprompt;
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

	let prompt = modifyPrompt(iprompt, plugin.settings.personas);

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
			const response = await fetch(
				`${plugin.settings.serverAddress}/v1/chat/completions`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}
			);

			if (!response.ok) {
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
						updateConversationHistory(prompt + ": " + selectedText, responseStr, plugin.conversationHistory, plugin.settings.maxConvHistory);
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
			const response = await requestUrl({
				url: `${plugin.settings.serverAddress}/v1/chat/completions`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			const statusCode = response.status;

			if (statusCode >= 200 && statusCode < 300) {
				const data = await response.json;
				const summarizedText = data.choices[0].message.content;
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
		new Notice(
			"Error summarizing text: Check plugin console for more details!"
		);
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
	conversationHistory: ConversationEntry[] = [];
	submitButton: ButtonComponent;

	constructor(app: App, settings: OLocalLLMSettings) {
		super(app);
		this.pluginSettings = settings;
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
		personasInfoEl.innerText = "Current persona: " + personasDict[this.pluginSettings.personas];
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
				this.pluginSettings
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

async function processChatInput(text: string, personas: string, chatContainer: HTMLElement, chatHistoryEl: HTMLElement, conversationHistory: ConversationEntry[], pluginSettings: OLocalLLMSettings) {
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

	text = modifyPrompt(text, personas);
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

		const response = await requestUrl({
			url: `${pluginSettings.serverAddress}/v1/chat/completions`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		const statusCode = response.status;

		if (statusCode >= 200 && statusCode < 300) {
			const data = await response.json;
			const llmResponse = data.choices[0].message.content;

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
		new Notice(
			"Error communicating with LLM Helper: Check plugin console for details!"
		);
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


//TODO: add a button to clear the chat history
//TODO: add a button to save the chat history to a obsidian file

//TODO: kill switch

async function processWebSearch(query: string, plugin: OLocalLLMPlugin) {
	if (!plugin.settings.braveSearchApiKey) {
		new Notice("Please set your Brave Search API key in settings");
		return;
	}

	new Notice("Searching the web...");

	try {
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
		const context = searchResults.map((result: any) => {
			let snippets = result.extra_snippets ?
				'\nAdditional Context:\n' + result.extra_snippets.join('\n') : '';
			return `${result.title}\n${result.description}${snippets}\nSource: ${result.url}\n\n`;
		}).join('');

		processText(
			`Based on these comprehensive search results about "${query}":\n\n${context}`,
			"You are a helpful assistant. Analyze these detailed search results and provide a thorough, well-structured response. Include relevant source citations and consider multiple perspectives if available.",
			plugin
		);

	} catch (error) {
		console.error("Web search error:", error);
		new Notice("Web search failed. Check console for details.");
	}
}

async function processNewsSearch(query: string, plugin: OLocalLLMPlugin) {
	try {
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
		const context = newsResults.map((result: any) =>
			`${result.title}\n${result.description}\nSource: ${result.url}\nPublished: ${result.published_time}\n\n`
		).join('');

		processText(
			`Based on these news results about "${query}":\n\n${context}`,
			"Analyze these news results and provide a comprehensive summary with key points and timeline. Include source citations.",
			plugin
		);
	} catch (error) {
		console.error("News search error:", error);
		new Notice("News search failed. Check console for details.");
	}
}
