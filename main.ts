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
	serverPort:string;
	llmModel:string;
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "localhost",
	serverPort: "1234",
	llmModel: "TheBloke/Mistral-7B-Instruct-v0.2-GGUF",
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
							processText(selectedText, this.settings.serverAddress, this.settings.serverPort,
								this.settings.llmModel, "Summarize the following text (maintain verbs and pronoun forms, also retain the markdowns):");
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
							processText(selectedText, this.settings.serverAddress, this.settings.serverPort,
								this.settings.llmModel, "Make the following sound professional (maintain verbs and pronoun forms, also retain the markdowns):");
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
							processText(selectedText, this.settings.serverAddress, this.settings.serverPort,
								this.settings.llmModel, "Generate text based on the following text:");
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
    }
}


async function processText(selectedText: string, serverAddress: string, serverPort: string, modelName: string, prompt:string) {
  new Notice("Generating response. This takes a few seconds..");
  const body = {
    model: modelName, // Replace with your model name (optional)
    messages: [
      { role: "system", content: "You are my text editor AI agent" }, // Optional prompt for the server
      { role: "user", content: prompt+": " +selectedText },
    ],
    temperature: 0.7, // Adjust temperature as needed
    max_tokens: -1, // Set max response length or -1 for unlimited (optional)
    stream: false, // Enable receiving response in chunks (optional)
  };

  try {
	const response = await requestUrl({
	  url: `http://${serverAddress}:${serverPort}/v1/chat/completions`,
	  method: "POST",
	  headers: { "Content-Type": "application/json" },
	  body: JSON.stringify(body),
	});

	const statusCode = response.status;

    if (statusCode >= 200 && statusCode < 300) {
      const data = await response.json;
	  console.log(data);
      // Process the response data (assuming it contains the summarized text)
      const summarizedText = data.choices[0].message.content; // Assuming first choice is the summary
	  console.log(modelName, serverAddress, serverPort);
	  console.log(summarizedText);
	  new Notice("Text generated. Voila!");
      replaceSelectedText(summarizedText);
    } else {
      console.error("Error summarizing text:", response.text);
	  new Notice("Error summarizing text: Check plugin console for more details!");
    }
  } catch (error) {
    console.error("Error during request:", error);
	new Notice("Error summarizing text: Check plugin console for more details!");
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

