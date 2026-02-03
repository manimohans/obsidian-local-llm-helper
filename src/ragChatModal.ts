import { App, Modal, TextComponent, ButtonComponent, Notice, setIcon } from "obsidian";
import { OLocalLLMSettings } from "../main";
import { RAGManager } from "./rag";

export class RAGChatModal extends Modal {
	private result: string = "";
	private pluginSettings: OLocalLLMSettings;
	private ragManager: RAGManager;
	private submitButton: ButtonComponent;
	private chatHistoryEl: HTMLElement;
	private welcomeEl: HTMLElement | null = null;
	private textInput: TextComponent;

	constructor(app: App, settings: OLocalLLMSettings, ragManager: RAGManager) {
		super(app);
		this.pluginSettings = settings;
		this.ragManager = ragManager;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("rag-chat-modal");

		// Header
		const header = contentEl.createDiv({ cls: "rag-chat-header" });
		const headerIcon = header.createSpan({ cls: "rag-chat-header-icon" });
		setIcon(headerIcon, "book-open");
		const headerText = header.createDiv({ cls: "rag-chat-header-text" });
		headerText.createEl("h2", { text: "Chat with Notes" });
		const indexedCount = this.ragManager.getIndexedFilesCount();
		const subtitle = indexedCount > 0
			? `Searching across ${indexedCount} indexed files`
			: "No files indexed yet — index notes in settings";
		headerText.createEl("span", { text: subtitle, cls: "rag-chat-subtitle" });

		// Chat container
		const chatContainer = contentEl.createDiv({ cls: "rag-chat-container" });
		this.chatHistoryEl = chatContainer.createDiv({ cls: "rag-chat-history" });

		// Welcome message (shown when empty)
		this.showWelcomeMessage();

		// Input area
		const inputContainer = contentEl.createDiv({ cls: "rag-chat-input-container" });
		const inputRow = inputContainer.createDiv({ cls: "rag-chat-input-row" });

		// Clear button
		const clearBtn = new ButtonComponent(inputRow)
			.setIcon("trash-2")
			.setTooltip("Clear conversation")
			.onClick(() => this.clearConversation());
		clearBtn.buttonEl.addClass("rag-chat-clear-btn");

		// Text input
		this.textInput = new TextComponent(inputRow)
			.setPlaceholder("Ask about your notes...")
			.onChange((value) => {
				this.result = value;
				this.updateSubmitButtonState();
			});
		this.textInput.inputEl.addClass("rag-chat-input");
		this.textInput.inputEl.addEventListener('keypress', (event) => {
			if (event.key === 'Enter' && this.result.trim() !== "") {
				event.preventDefault();
				this.handleSubmit();
			}
		});

		// Submit button
		this.submitButton = new ButtonComponent(inputRow)
			.setButtonText("Send")
			.setCta()
			.onClick(() => this.handleSubmit());
		this.submitButton.buttonEl.addClass("rag-chat-submit-btn");

		this.updateSubmitButtonState();
		this.textInput.inputEl.focus();
	}

	private showWelcomeMessage() {
		this.welcomeEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-welcome" });

		const welcomeContent = this.welcomeEl.createDiv({ cls: "rag-chat-welcome-content" });
		welcomeContent.createEl("p", {
			text: "Ask questions about your notes. I'll find relevant content and answer based on what's in your vault."
		});

		const examples = welcomeContent.createDiv({ cls: "rag-chat-examples" });
		examples.createEl("span", { text: "Try asking:", cls: "rag-chat-examples-label" });

		const exampleQueries = [
			"What are my main topics?",
			"Summarize my notes on...",
			"What did I write about...?",
		];

		for (const query of exampleQueries) {
			const exampleBtn = examples.createEl("button", {
				text: query,
				cls: "rag-chat-example-btn"
			});
			exampleBtn.addEventListener("click", () => {
				this.textInput.setValue(query);
				this.result = query;
				this.updateSubmitButtonState();
				this.textInput.inputEl.focus();
			});
		}
	}

	private hideWelcomeMessage() {
		if (this.welcomeEl) {
			this.welcomeEl.remove();
			this.welcomeEl = null;
		}
	}

	private async handleSubmit() {
		if (this.result.trim() === "") return;

		this.hideWelcomeMessage();

		const query = this.result;

		// Add user message
		const userMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-user" });
		userMsg.createSpan({ text: query });

		// Clear input
		this.result = "";
		this.textInput.setValue("");
		this.updateSubmitButtonState();

		// Show thinking indicator
		const thinkingEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-thinking" });
		thinkingEl.innerHTML = 'Searching notes<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
		this.scrollToBottom();

		try {
			const response = await this.ragManager.getRAGResponse(query);

			// Remove thinking indicator
			thinkingEl.remove();

			// Add AI response
			const aiMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-ai" });

			// Response text
			const responseText = aiMsg.createDiv({ cls: "rag-chat-response-text" });
			responseText.innerHTML = this.formatResponse(response.response);

			// Sources
			if (response.sources.length > 0) {
				const sourcesEl = aiMsg.createDiv({ cls: "rag-chat-sources" });
				sourcesEl.createEl("span", { text: "Sources:", cls: "rag-chat-sources-label" });
				const sourcesList = sourcesEl.createDiv({ cls: "rag-chat-sources-list" });

				for (const source of response.sources) {
					const sourceItem = sourcesList.createDiv({ cls: "rag-chat-source-item" });
					const sourceIcon = sourceItem.createSpan({ cls: "rag-chat-source-icon" });
					setIcon(sourceIcon, "file-text");
					sourceItem.createSpan({ text: source, cls: "rag-chat-source-name" });

					// Make clickable to open file
					sourceItem.addEventListener("click", () => {
						const file = this.app.vault.getAbstractFileByPath(source);
						if (file) {
							this.app.workspace.openLinkText(source, "", false);
						}
					});
				}
			}

			// Copy button
			const copyBtn = aiMsg.createEl("button", { cls: "rag-chat-copy-btn" });
			setIcon(copyBtn, "copy");
			copyBtn.setAttribute("aria-label", "Copy response");
			copyBtn.addEventListener("click", () => {
				navigator.clipboard.writeText(response.response).then(() => {
					new Notice("Copied to clipboard");
				});
			});

			this.scrollToBottom();

		} catch (error) {
			thinkingEl.remove();

			const errorMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-error" });
			errorMsg.createSpan({
				text: error.message || "Failed to get response. Make sure notes are indexed."
			});

			console.error("RAG Chat Error:", error);
			this.scrollToBottom();
		}
	}

	private formatResponse(text: string): string {
		// Basic markdown-like formatting
		return text
			.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
			.replace(/\*(.*?)\*/g, "<em>$1</em>")
			.replace(/\n\n/g, "</p><p>")
			.replace(/\n/g, "<br>");
	}

	private clearConversation() {
		this.chatHistoryEl.empty();
		this.showWelcomeMessage();
	}

	private updateSubmitButtonState() {
		const isEmpty = this.result.trim() === "";
		this.submitButton.setDisabled(isEmpty);
		if (isEmpty) {
			this.submitButton.buttonEl.addClass("rag-chat-submit-disabled");
		} else {
			this.submitButton.buttonEl.removeClass("rag-chat-submit-disabled");
		}
	}

	private scrollToBottom() {
		this.chatHistoryEl.scrollTop = this.chatHistoryEl.scrollHeight;
	}

	onClose() {
		this.contentEl.empty();
	}
}
