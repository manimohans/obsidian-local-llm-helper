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
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "localhost",
	serverPort: "1234",
	llmModel: "TheBloke/Mistral-7B-Instruct-v0.2-GGUF",
	stream: false,
};

export default class OLocalLLMPlugin extends Plugin {
	settings: OLocalLLMSettings;

	async onload() {
		await this.loadSettings();

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
								this.settings.stream
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
								this.settings.stream
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Generate text")
					.setIcon("lightbulb")
					.onClick(async () => {
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								this.settings.serverAddress,
								this.settings.serverPort,
								this.settings.llmModel,
								"Generate text based on the following text:",
								this.settings.stream
							);
						}
					})
			);

			menu.showAtMouseEvent(event);
		});

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Local LLM Helper running");

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
			.setName("LLM model")
			.setDesc("currently works with LM Studio - find model name there")
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
	}
}

async function processText(
	selectedText: string,
	serverAddress: string,
	serverPort: string,
	modelName: string,
	prompt: string,
	stream: boolean
) {
	new Notice("Generating response. This takes a few seconds..");
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

			const reader = response.body.getReader();
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
							let modifiedLine = line.replace(/^data:\s*/, "");
							if (modifiedLine !== "[DONE]") {
								const data = JSON.parse(modifiedLine);
								if (data.choices[0].delta.content) {
									let word = data.choices[0].delta.content;
									replaceSelectedText(word);
								}
							}
						} catch (error) {
							console.error("Error parsing JSON chunk:", error);
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
				replaceSelectedText(summarizedText);
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
}

function replaceSelectedText(text: any) {
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
