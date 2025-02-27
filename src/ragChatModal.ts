import { App, Modal, TextComponent, ButtonComponent, Notice, setIcon } from "obsidian";
import { OLocalLLMSettings } from "../main";
import { RAGManager } from "./rag";

export class RAGChatModal extends Modal {
	result: string = "";
	pluginSettings: OLocalLLMSettings;
	conversationHistory: { prompt: string; response: string }[] = [];
	submitButton: ButtonComponent;
	ragManager: RAGManager;

	constructor(app: App, settings: OLocalLLMSettings, ragManager: RAGManager) {
		super(app);
		this.pluginSettings = settings;
		this.ragManager = ragManager;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.classList.add("llm-chat-modal");

		const chatContainer = contentEl.createDiv({ cls: "llm-chat-container" });
		const chatHistoryEl = chatContainer.createDiv({ cls: "llm-chat-history" });
		chatHistoryEl.classList.add("chatHistoryElStyle");

		chatHistoryEl.createEl("h1", { text: "Chat with your Notes (RAG)" });

		const inputContainer = contentEl.createDiv({ cls: "llm-chat-input-container" });
		const inputRow = inputContainer.createDiv({ cls: "llm-chat-input-row" });
		inputRow.createSpan({ text: "Ask:", cls: "llm-chat-ask-label" });

		const textInput = new TextComponent(inputRow)
			.setPlaceholder("Ask about your notes...")
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

		this.updateSubmitButtonState();
		this.scrollToBottom();
	}

	private async handleSubmit() {
		if (this.result.trim() === "") return;

		const chatHistoryEl = this.contentEl.querySelector('.llm-chat-history') as HTMLElement;
		if (!chatHistoryEl) return;

		// Add user question to chat
		const userMessageEl = chatHistoryEl.createEl("p", { text: "You: " + this.result });
		userMessageEl.classList.add('llmChatMessageStyleUser');

		// Show thinking indicator
		this.showThinkingIndicator(chatHistoryEl);
		this.scrollToBottom();

		try {
			const response = await this.ragManager.getRAGResponse(this.result);

			// Create response container
			const responseContainer = document.createElement('div');
			responseContainer.classList.add('llmChatMessageStyleAI');

			// Add response text
			const responseTextEl = document.createElement('div');
			responseTextEl.innerHTML = response.response;
			responseContainer.appendChild(responseTextEl);

			// Add sources if available
			if (response.sources.length > 0) {
				const sourcesEl = document.createElement('div');
				sourcesEl.classList.add('rag-sources');
				sourcesEl.innerHTML = "<br>Sources:<br>" + response.sources.map(s => `[[${s}]]`).join('<br>');
				responseContainer.appendChild(sourcesEl);
			}

			// Add copy button
			const copyButton = document.createElement('button');
			copyButton.classList.add('copy-button');
			setIcon(copyButton, 'copy');
			copyButton.addEventListener('click', () => {
				navigator.clipboard.writeText(response.response).then(() => {
					new Notice('Copied to clipboard!');
				});
			});
			responseContainer.appendChild(copyButton);

			// Remove thinking indicator and add response
			this.hideThinkingIndicator(chatHistoryEl);
			chatHistoryEl.appendChild(responseContainer);

			// Clear input and update state
			this.result = "";
			const textInputEl = this.contentEl.querySelector('.llm-chat-input') as HTMLInputElement;
			if (textInputEl) {
				textInputEl.value = "";
			}
			this.updateSubmitButtonState();
			this.scrollToBottom();

		} catch (error) {
			console.error("RAG Chat Error:", error);
			new Notice("Error: " + (error.message || "Unknown error occurred"));
			this.hideThinkingIndicator(chatHistoryEl);
		}
	}

	private updateSubmitButtonState() {
		if (this.result.trim() === "") {
			this.submitButton.setDisabled(true);
			this.submitButton.buttonEl.classList.add("llm-chat-submit-button-disabled");
		} else {
			this.submitButton.setDisabled(false);
			this.submitButton.buttonEl.classList.remove("llm-chat-submit-button-disabled");
		}
	}

	private showThinkingIndicator(chatHistoryEl: HTMLElement) {
		const thinkingIndicatorEl = document.createElement('div');
		thinkingIndicatorEl.classList.add('thinking-indicator');
		thinkingIndicatorEl.innerHTML = 'Searching through your notes...<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span>';
		chatHistoryEl.appendChild(thinkingIndicatorEl);
	}

	private hideThinkingIndicator(chatHistoryEl: HTMLElement) {
		const thinkingIndicatorEl = chatHistoryEl.querySelector('.thinking-indicator');
		if (thinkingIndicatorEl) {
			thinkingIndicatorEl.remove();
		}
	}

	private scrollToBottom() {
		const chatHistoryEl = this.contentEl.querySelector('.llm-chat-history');
		if (chatHistoryEl) {
			chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
