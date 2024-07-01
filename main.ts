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
} from "obsidian";

// Remember to rename these classes and interfaces!

interface OLocalLLMSettings {
	serverAddress: string;
	serverPort: string;
	stream: boolean;
	customPrompt: string;
	outputMode: string;
	personas: string;
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "localhost",
	serverPort: "1234",
	stream: false,
	customPrompt: "create a todo list from the following text:",
	outputMode: "replace",
	personas: "default"
};

export default class OLocalLLMPlugin extends Plugin {
	settings: OLocalLLMSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "summarize-selected-text",
			name: "Summarize selected text",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						this.settings.serverAddress,
						this.settings.serverPort,
						"Summarize the following text (maintain verbs and pronoun forms, also retain the markdowns):",
						this.settings.stream,
						this.settings.outputMode,
						this.settings.personas
					);
				}
			},
		});

		this.addCommand({
			id: "makeitprof-selected-text",
			name: "Make selected text sound professional",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						this.settings.serverAddress,
						this.settings.serverPort,
						"Make the following sound professional (maintain verbs and pronoun forms, also retain the markdowns):",
						this.settings.stream,
						this.settings.outputMode,
						this.settings.personas
					);
				}
			},
		});

		this.addCommand({
			id: "actionitems-selected-text",
			name: "Generate action items from selected text",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						this.settings.serverAddress,
						this.settings.serverPort,
						"Generate action items based on the following text (use or numbers based on context):",
						this.settings.stream,
						this.settings.outputMode,
						this.settings.personas
					);
				}
			},
		});

		this.addCommand({
			id: "custom-selected-text",
			name: "Run Custom prompt (from settings) on selected text",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new Notice("Custom prompt: " + this.settings.customPrompt);
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						this.settings.serverAddress,
						this.settings.serverPort,
						this.settings.customPrompt,
						this.settings.stream,
						this.settings.outputMode,
						this.settings.personas
					);
				}
			},
		});

		this.addCommand({
			id: "gentext-selected-text",
			name: "Use SELECTED text as your prompt",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						this.settings.serverAddress,
						this.settings.serverPort,
						"Generate response based on the following text. This is your prompt:",
						this.settings.stream,
						this.settings.outputMode,
						this.settings.personas
					);
				}
			},
		});

		this.addRibbonIcon("brain-cog", "LLM Context", (event) => {
			const menu = new Menu();

			menu.addItem((item) =>
				item
					.setTitle("Summarize")
					.setIcon("sword")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								this.settings.serverAddress,
								this.settings.serverPort,
								"Summarize the following text (maintain verbs and pronoun forms, also retain the markdowns):",
								this.settings.stream,
								this.settings.outputMode,
								this.settings.personas
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Make it professional")
					.setIcon("school")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								this.settings.serverAddress,
								this.settings.serverPort,
								"Make the following sound professional (maintain verbs and pronoun forms, also retain the markdowns):",
								this.settings.stream,
								this.settings.outputMode,
								this.settings.personas
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Use as prompt")
					.setIcon("lightbulb")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								this.settings.serverAddress,
								this.settings.serverPort,
								"Generate response based on the following text. This is your prompt:",
								this.settings.stream,
								this.settings.outputMode,
								this.settings.personas
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Generate action items")
					.setIcon("list-todo")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								this.settings.serverAddress,
								this.settings.serverPort,
								"Generate action items based on the following text (use or numbers based on context):",
								this.settings.stream,
								this.settings.outputMode,
								this.settings.personas
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Custom prompt")
					.setIcon("pencil")
					.onClick(async () => {
						new Notice(
							"Custom prompt: " + this.settings.customPrompt
						);
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								this.settings.serverAddress,
								this.settings.serverPort,
								this.settings.customPrompt,
								this.settings.stream,
								this.settings.outputMode,
								this.settings.personas
							);
						}
					})
			);

			menu.showAtMouseEvent(event);
		});

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("LLM Helper: Ready");

		this.addSettingTab(new OLLMSettingTab(this.app, this));
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

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class OLLMSettingTab extends PluginSettingTab {
	plugin: OLocalLLMPlugin;

	constructor(app: App, plugin: OLocalLLMPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Server address")
			.setDesc("localhost or remote (do not include http://)")
			.addText((text) =>
				text
					.setPlaceholder("Enter details")
					.setValue(this.plugin.settings.serverAddress)
					.onChange(async (value) => {
						this.plugin.settings.serverAddress = value;
						await this.plugin.saveSettings();
					})
			);

		// Add a new setting for another text input
		new Setting(containerEl)
			.setName("Server port")
			.setDesc("Port number for the LLM server")
			.addText((text) =>
				text
					.setPlaceholder("Enter port number")
					.setValue(this.plugin.settings.serverPort) // Assuming there's a serverPort property in settings
					.onChange(async (value) => {
						this.plugin.settings.serverPort = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom prompt")
			.setDesc("create your own prompt - for your specific niche needs")
			.addText((text) =>
				text
					.setPlaceholder(
						"create action items from the following text:"
					)
					.setValue(this.plugin.settings.customPrompt) // Assuming there's a serverPort property in settings
					.onChange(async (value) => {
						this.plugin.settings.customPrompt = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Streaming")
			.setDesc(
				"Enable to receive the response in real-time, word by word."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.stream) // Assume 'stream' exists in your settings
					.onChange(async (value) => {
						this.plugin.settings.stream = value;
						await this.plugin.saveSettings();
					})
			);
		
			new Setting(containerEl)
            .setName("Output Mode")
            .setDesc("Choose how to handle generated text")
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
            .setName("Personas")
            .setDesc("Choose persona for your AI agent")
            .addDropdown((dropdown) =>
                dropdown
					.addOption("default", "Default")
                    .addOption("physics", "Physics expert")
                    .addOption("fitness", "Fitness expert")
					.addOption("developer", "Software Developer")
					.addOption("stoic", "Stoic Philosopher")
					.addOption("productmanager", "Product Manager")
					.addOption("techwriter", "Technical Writer")
					.addOption("creativewriter", "Creative Writer")
					.addOption("tpm", "Technical Program Manager")
					.addOption("engineeringmanager", "Engineering Manager")
					.addOption("executive", "Executive")
					.addOption("officeassistant", "Office Assistant")
                    .setValue(this.plugin.settings.personas)
                    .onChange(async (value) => {
                        this.plugin.settings.personas = value;
                        await this.plugin.saveSettings();
                    })
            );
	}
}

async function processText(
	selectedText: string,
	serverAddress: string,
	serverPort: string,
	prompt: string,
	stream: boolean,
	outputMode: string,
	personas: string
	
) {
	new Notice("Generating response. This takes a few seconds..");
	const statusBarItemEl = document.querySelector(
		".status-bar .status-bar-item"
	);
	if (statusBarItemEl) {
		statusBarItemEl.textContent = "LLM Helper: Generating response...";
	} else {
		console.error("Status bar item element not found");
	}

	if (personas === "default") {
		prompt = "" + prompt;
	} else if (personas === "physics") {
		prompt = "Respond like a distinguished physics scientist. \n " + prompt;
	} else if (personas === "fitness") {
		prompt = "Respond like a distinguished fitness + health expert. \n " + prompt;
	} else if (personas === "developer") {
		prompt = "Respond like a nerdy software developer. \n " + prompt;
	} else if (personas === "stoic") {
		prompt = "Respond like a stoic philosopher. \n " + prompt;
	} else if (personas === "productmanager") {
		prompt = "Respond like a focused and experienced product manager. \n " + prompt;
	} else if (personas === "techwriter") {
		prompt = "Respond like a technical writer. \n " + prompt;
	} else if (personas === "creativewriter") {
		prompt = "Respond like a very creative and experienced writer. \n " + prompt;
	} else if (personas === "tpm") {
		prompt = "Respond like an experienced technical program manager. \n " + prompt;
	} else if (personas === "engineeringmanager") {
		prompt = "Respond like an experienced engineering manager. \n " + prompt;
	} else if (personas === "executive") {
		prompt = "Respond like a top level executive. \n " + prompt;
	} else if (personas === "officeassistant") {
		prompt = "Respond like a courteous and helpful office assistant. \n " + prompt;
	} else {
		prompt = "" + prompt;
	}

	console.log("prompt", prompt + ": " + selectedText);

	const body = {
		model: "",
		messages: [
			{ role: "system", content: "You are my text editor AI agent" },
			{ role: "user", content: prompt + ": " + selectedText },
		],
		temperature: 0.7,
		max_tokens: -1,
		stream,
	};

	try {
		if (outputMode === "append") {
			modifySelectedText(selectedText);
		}
		if (stream) {
			const response = await fetch(
				`http://${serverAddress}:${serverPort}/v1/chat/completions`,
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
			if (!reader) {
				console.error("Reader not found");
			} else {
				const decoder = new TextDecoder();

				const readChunk = async () => {
					const { done, value } = await reader.read();

					if (done) {
						new Notice("Text generation complete. Voila!");
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
				url: `http://${serverAddress}:${serverPort}/v1/chat/completions`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			const statusCode = response.status;

			if (statusCode >= 200 && statusCode < 300) {
				const data = await response.json;
				const summarizedText = data.choices[0].message.content;
				console.log(summarizedText);
				new Notice("Text generated. Voila!");
				modifySelectedText(summarizedText);
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
