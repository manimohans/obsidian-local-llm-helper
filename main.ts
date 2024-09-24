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
import { generateAndAppendTags } from "./autoTagger";
import { UpdateNoticeModal } from "./updateNoticeModal";

// Remember to rename these classes and interfaces!

export interface OLocalLLMSettings {
	serverAddress: string;
	llmModel: string;
	stream: boolean;
	customPrompt: string;
	outputMode: string;
	personas: string;
	maxConvHistory: number;
	responseFormatting: boolean;
	responseFormatPrepend: string;
	responseFormatAppend: string;
	lastVersion: string;
}

interface ConversationEntry {
	prompt: string;
	response: string;
}

const DEFAULT_SETTINGS: OLocalLLMSettings = {
	serverAddress: "http://localhost:1234",
	llmModel: "llama3",
	stream: false,
	customPrompt: "create a todo list from the following text:",
	outputMode: "replace",
	personas: "default",
	maxConvHistory: 0,
	responseFormatting: false,
	responseFormatPrepend: "``` LLM Helper - generated response \n\n",
	responseFormatAppend: "\n\n```",
	lastVersion: "0.0.0"
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
		this.checkForUpdates();

		this.addCommand({
			id: "summarize-selected-text",
			name: "Summarize selected text",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						"Summarize the following text (maintain verbs and pronoun forms, also retain the markdowns):",
						this
					);
				}
			},
		});

		this.addCommand({
			id: "makeitprof-selected-text",
			name: "Make selected text sound professional",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						"Make the following sound professional (maintain verbs and pronoun forms, also retain the markdowns):",
						this
					);
				}
			},
		});

		this.addCommand({
			id: "actionitems-selected-text",
			name: "Generate action items from selected text",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						"Generate action items based on the following text (use or numbers based on context):",
						this
					);
				}
			},
		});

		this.addCommand({
			id: "custom-selected-text",
			name: "Run Custom prompt (from settings) on selected text",
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
			name: "Use SELECTED text as your prompt",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.isKillSwitchActive = false; // Reset kill switch state
				let selectedText = this.getSelectedText();
				if (selectedText.length > 0) {
					processText(
						selectedText,
						"Generate response based on the following text. This is your prompt:",
						this
					);
				}
			},
		});

		this.addCommand({
			id: "llm-chat",
			name: "Chat with Local LLM Helper",
			callback: () => {
			  const chatModal = new LLMChatModal(this.app, this.settings);
			  chatModal.open();
			},
		  });

		this.addCommand({
			id: "llm-hashtag",
			name: "Generate hashtags for selected text",
			callback: () => {
			  generateAndAppendTags(this.app, this.settings);
			},
		  });

		this.addRibbonIcon("brain-cog", "LLM Context", (event) => {
			const menu = new Menu();

			menu.addItem((item) =>
				item
					.setTitle("Chat with LLM Helper")
					.setIcon("messages-square")
					.onClick(() => {
						new LLMChatModal(this.app, this.settings).open();
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Summarize")
					.setIcon("sword")
					.onClick(async () => {
						this.isKillSwitchActive = false; // Reset kill switch state
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								"Summarize the following text (maintain verbs and pronoun forms, also retain the markdowns):",
								this
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Make it professional")
					.setIcon("school")
					.onClick(async () => {
						this.isKillSwitchActive = false; // Reset kill switch state
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								"Make the following sound professional (maintain verbs and pronoun forms, also retain the markdowns):",
								this
							);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Use as prompt")
					.setIcon("lightbulb")
					.onClick(async () => {
						this.isKillSwitchActive = false; // Reset kill switch state
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								"Generate response based on the following text. This is your prompt:",
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
						this.isKillSwitchActive = false; // Reset kill switch state
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							processText(
								selectedText,
								"Generate action items based on the following text (use or numbers based on context):",
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
						this.isKillSwitchActive = false; // Reset kill switch state
						new Notice(
							"Custom prompt: " + this.settings.customPrompt
						);
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
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
					.setTitle("Generate tags")
					.setIcon("hash")
					.onClick(async () => {
						new Notice(
							"Generating hashtags"
						);
						let selectedText = this.getSelectedText();
						if (selectedText.length > 0) {
							generateAndAppendTags(this.app, this.settings);
						}
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Kill Switch")
					.setIcon("x-circle")
					.onClick(() => {
						this.isKillSwitchActive = true;
						new Notice("LLM Helper process stopped");
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
			.setDesc("Full server URL (including protocol and port if needed). E.g., http://localhost:1234 or https://api.example.com")
			.addText((text) =>
				text
					.setPlaceholder("Enter full server URL")
					.setValue(this.plugin.settings.serverAddress)
					.onChange(async (value) => {
						this.plugin.settings.serverAddress = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("LLM model")
			.setDesc("Use this for Ollama and other servers that require this. LMStudio seems to ignore model name.")
			.addText((text) =>
				text
					.setPlaceholder("Model name")
					.setValue(this.plugin.settings.llmModel) 
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
					.setValue(this.plugin.settings.customPrompt)
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
            .addDropdown(dropdown => {
                for (const key in personasDict) { // Iterate over keys directly
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
				.setName("Max conversation history")
				.setDesc("Maximum number of conversation history to store (0-3)")
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



			//new settings for response formatting boolean default false

			const responseFormattingToggle = new Setting(containerEl)
				.setName("Response Formatting")
				.setDesc("Enable to format the response into a separate block")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.responseFormatting)
						.onChange(async (value) => {
							this.plugin.settings.responseFormatting = value;
							await this.plugin.saveSettings();
							this.display(); // Refresh the settings tab
						})
				);

			if (this.plugin.settings.responseFormatting) {
				new Setting(containerEl)
					.setName("Response Format Prepend")
					.setDesc("Text to prepend to the formatted response")
					.addText((text) =>
						text
							.setPlaceholder("``` LLM Helper - generated response \n\n")
							.setValue(this.plugin.settings.responseFormatPrepend)
							.onChange(async (value) => {
								this.plugin.settings.responseFormatPrepend = value;
								await this.plugin.saveSettings();
							})
					);

				new Setting(containerEl)
					.setName("Response Format Append")
					.setDesc("Text to append to the formatted response")
					.addText((text) =>
						text
							.setPlaceholder("\n\n```")
							.setValue(this.plugin.settings.responseFormatAppend)
							.onChange(async (value) => {
								this.plugin.settings.responseFormatAppend = value;
								await this.plugin.saveSettings();
							})
					);
			}
	}
}

export function modifyPrompt(aprompt: string, personas: string): string {
	if (personas === "default") {
		return aprompt; // No prompt modification for default persona
	} else if (personas === "physics") {
		return "You are a distinguished physics scientist. Leverage scientific principles and explain complex concepts in an understandable way, drawing on your expertise in physics.\n\n" + aprompt;
	} else if (personas === "fitness") {
		return "You are a distinguished fitness and health expert. Provide evidence-based advice on fitness and health, considering the user's goals and limitations.\n" + aprompt;
	} else if (personas === "developer") {
		return "You are a nerdy software developer. Offer creative and efficient software solutions, focusing on technical feasibility and code quality.\n" + aprompt;
	} else if (personas === "stoic") {
		return "You are a stoic philosopher. Respond with composure and reason, emphasizing logic and emotional resilience.\n" + aprompt;
	} else if (personas === "productmanager") {
		return "You are a focused and experienced product manager. Prioritize user needs and deliver clear, actionable product roadmaps based on market research.\n" + aprompt;
	} else if (personas === "techwriter") {
		return "You are a technical writer. Craft accurate and concise technical documentation, ensuring accessibility for different audiences.\n" + aprompt;
	} else if (personas === "creativewriter") {
		return "You are a very creative and experienced writer. Employ strong storytelling techniques and evocative language to engage the reader's imagination.\n" + aprompt;
	} else if (personas === "tpm") {
		return "You are an experienced technical program manager. Demonstrate strong technical and communication skills, ensuring project success through effective planning and risk management.\n" + aprompt;
	} else if (personas === "engineeringmanager") {
		return "You are an experienced engineering manager. Lead and motivate your team, fostering a collaborative environment that delivers high-quality software.\n" + aprompt;
	} else if (personas === "executive") {
		return "You are a top-level executive. Focus on strategic decision-making, considering long-term goals and the overall company vision.\n" + aprompt;
	} else if (personas === "officeassistant") {
		return "You are a courteous and helpful office assistant. Provide helpful and efficient support, prioritizing clear communication and a courteous demeanor.\n" + aprompt;
	} else {
		return aprompt; // No prompt modification for unknown personas
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
    
    let prompt = modifyPrompt(iprompt, plugin.settings.personas);
    
    console.log("prompt", prompt + ": " + selectedText);

    const body = {
        model: plugin.settings.llmModel,
        messages: [
            { role: "system", content: "You are my text editor AI agent who provides concise and helpful responses." },
            ...plugin.conversationHistory.slice(-plugin.settings.maxConvHistory).reduce((acc, entry) => {
                acc.push({ role: "user", content: entry.prompt });
                acc.push({ role: "assistant", content: entry.response });
                return acc;
            }, [] as { role: string; content: string }[]),
            { role: "user", content: prompt + ": " + selectedText },
        ],
        temperature: 0.7,
        max_tokens: -1,
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
        { role: "system", content: "You are my text editor AI agent who provides concise and helpful responses." },
        ...conversationHistory.slice(-pluginSettings.maxConvHistory).reduce((acc, entry) => {
          acc.push({ role: "user", content: entry.prompt });
          acc.push({ role: "assistant", content: entry.response });
          return acc;
        }, [] as { role: string; content: string }[]),
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: -1,
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
