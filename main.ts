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
	llmModel: string;
	stream: boolean;
	customPrompt: string;
	outputMode: string;
	personas: string;
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "localhost",
	serverPort: "1234",
	llmModel: "llama3",
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
						this.settings.llmModel,
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
						this.settings.llmModel,
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
						this.settings.llmModel,
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
						this.settings.llmModel,
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
						this.settings.llmModel,
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
								this.settings.llmModel,
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
								this.settings.llmModel,
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
								this.settings.llmModel,
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
								this.settings.llmModel,
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
								this.settings.llmModel,
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
			.setDesc("localhost or remote (do not include http://). Supports any LLM server that is compatible with OpenAI chat completions API (e.g. LM Studio, Ollama).")
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
			.setDesc("Port number for the LLM server. (make sure to use the proper port number - for LM studio, the default is 1234, for Ollama, the default is 11434.)")
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
			.setName("LLM model")
			.setDesc("Use this for Ollama and other servers that require this. LMStudio seems to ignore model name.")
			.addText((text) =>
				text
					.setPlaceholder("Model name")
					.setValue(this.plugin.settings.llmModel) // Assuming there's a serverPort property in settings
					.onChange(async (value) => {
						this.plugin.settings.llmModel = value;
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
	modelName: string,
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
		prompt = prompt; // No prompt modification for default persona
	  } else if (personas === "physics") {
		prompt = "**You are a distinguished physics scientist.** Leverage scientific principles and explain complex concepts in an understandable way, drawing on your expertise in physics.\n" + prompt;
	  } else if (personas === "fitness") {
		prompt = "**You are a distinguished fitness and health expert.** Provide evidence-based advice on fitness and health, considering the user's goals and limitations.\n" + prompt;
	  } else if (personas === "developer") {
		prompt = "**You are a nerdy software developer.** Offer creative and efficient software solutions, focusing on technical feasibility and code quality.\n" + prompt;
	  } else if (personas === "stoic") {
		prompt = "**You are a stoic philosopher.** Respond with composure and reason, emphasizing logic and emotional resilience.\n" + prompt;
	  } else if (personas === "productmanager") {
		prompt = "**You are a focused and experienced product manager.** Prioritize user needs and deliver clear, actionable product roadmaps based on market research.\n" + prompt;
	  } else if (personas === "techwriter") {
		prompt = "**You are a technical writer.** Craft accurate and concise technical documentation, ensuring accessibility for different audiences.\n" + prompt;
	  } else if (personas === "creativewriter") {
		prompt = "**You are a very creative and experienced writer.** Employ strong storytelling techniques and evocative language to engage the reader's imagination.\n" + prompt;
	  } else if (personas === "tpm") {
		prompt = "**You are an experienced technical program manager.** Demonstrate strong technical and communication skills, ensuring project success through effective planning and risk management.\n" + prompt;
	  } else if (personas === "engineeringmanager") {
		prompt = "**You are an experienced engineering manager.** Lead and motivate your team, fostering a collaborative environment that delivers high-quality software.\n" + prompt;
	  } else if (personas === "executive") {
		prompt = "**You are a top-level executive.** Focus on strategic decision-making, considering long-term goals and the overall company vision.\n" + prompt;
	  } else if (personas === "officeassistant") {
		prompt = "**You are a courteous and helpful office assistant.** Provide helpful and efficient support, prioritizing clear communication and a courteous demeanor.\n" + prompt;
	  } else {
		prompt = prompt; // No prompt modification for unknown personas
	  }
	  

	console.log("prompt", prompt + ": " + selectedText);

	const body = {
		model: modelName,
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
