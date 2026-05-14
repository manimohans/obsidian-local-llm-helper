import { App, Modal, TextComponent, ButtonComponent, setIcon, Notice } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { OLocalLLMSettings } from "../main";
import { RAGManager, RAGQueryScope } from "./rag";
import { type ChatEnvironmentContext, type ConversationEntry, getActiveChatContext } from "./vaultAgent";
import { RAGScopeSelector, describeRAGScope } from "./ragScope";
import { appendThinkingDots, parseRAGScopeOverride, submitNotesChat, updateConversationHistory } from "./chatSession";

export class RAGChatModal extends Modal {
	private result: string = "";
	private pluginSettings: OLocalLLMSettings;
	private plugin: OLocalLLMPlugin;
	private ragManager: RAGManager;
	private submitButton: ButtonComponent;
	private chatHistoryEl: HTMLElement;
	private welcomeEl: HTMLElement | null = null;
	private textInput: TextComponent;
	private conversationHistory: ConversationEntry[] = [];
	private initialChatContext: ChatEnvironmentContext;
	private scopeSelector: RAGScopeSelector;
	private initialScope?: RAGQueryScope;

	constructor(app: App, settings: OLocalLLMSettings, ragManager: RAGManager, plugin: OLocalLLMPlugin, initialScope?: RAGQueryScope) {
		super(app);
		this.pluginSettings = settings;
		this.ragManager = ragManager;
		this.plugin = plugin;
		this.initialScope = initialScope;
		this.initialChatContext = getActiveChatContext(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("rag-chat-modal");

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

		const scopeBar = contentEl.createDiv({ cls: "rag-chat-scope-bar" });
		this.scopeSelector = new RAGScopeSelector(this.app, scopeBar, {
			initialScope: this.initialScope,
		});

		const chatContainer = contentEl.createDiv({ cls: "rag-chat-container" });
		this.chatHistoryEl = chatContainer.createDiv({ cls: "rag-chat-history" });

		this.showWelcomeMessage();

		const inputContainer = contentEl.createDiv({ cls: "rag-chat-input-container" });
		const inputRow = inputContainer.createDiv({ cls: "rag-chat-input-row" });

		const clearBtn = new ButtonComponent(inputRow)
			.setIcon("trash-2")
			.setTooltip("Clear conversation")
			.onClick(() => this.clearConversation());
		clearBtn.buttonEl.addClass("rag-chat-clear-btn");

		this.textInput = new TextComponent(inputRow)
			.setPlaceholder("Ask about your notes... Use @[[Note Name]], @folder(path), or #tag")
			.onChange((value) => {
				this.result = value;
				this.updateSubmitButtonState();
			});
		this.textInput.inputEl.addClass("rag-chat-input");
		this.textInput.inputEl.addEventListener("keypress", (event) => {
			if (event.key === "Enter" && this.result.trim() !== "") {
				event.preventDefault();
				void this.handleSubmit();
			}
		});

		this.submitButton = new ButtonComponent(inputRow)
			.setButtonText("Send")
			.setCta()
			.onClick(() => void this.handleSubmit());
		this.submitButton.buttonEl.addClass("rag-chat-submit-btn");

		this.updateSubmitButtonState();
		this.textInput.inputEl.focus();
	}

	private showWelcomeMessage() {
		this.welcomeEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-welcome" });

		const welcomeContent = this.welcomeEl.createDiv({ cls: "rag-chat-welcome-content" });
		welcomeContent.createEl("p", {
			text: "Ask questions about your notes. You can search the whole vault, the current note, a folder, or tagged notes."
		});

		const examples = welcomeContent.createDiv({ cls: "rag-chat-examples" });
		examples.createEl("span", { text: "Try asking:", cls: "rag-chat-examples-label" });

		const exampleQueries = [
			"What are my main topics?",
			"Summarize @[[Daily Notes]]",
			"What decisions did I capture in #meetings?",
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

		const parsedOverride = parseRAGScopeOverride(this.app, this.result);
		const selectionScope = this.scopeSelector.getScope();
		const scope = parsedOverride.scope || selectionScope;
		const query = parsedOverride.cleanQuery;
		const badgeText = describeRAGScope(scope);

		const userMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-user" });
		userMsg.createSpan({ text: this.result });

		this.result = "";
		this.textInput.setValue("");
		this.updateSubmitButtonState();

		const thinkingEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-thinking" });
		thinkingEl.createSpan({ text: `Searching ${badgeText}` });
		appendThinkingDots(thinkingEl);
		this.scrollToBottom();

		try {
			const result = await submitNotesChat(this.plugin, query, this.conversationHistory, this.initialChatContext, scope, badgeText);

			thinkingEl.remove();

			const renderedMessage = this.plugin.vaultAgent.renderAgentResponse(
				this.chatHistoryEl,
				result.response,
				result.context,
				{
					messageClassName: "rag-chat-message rag-chat-message-ai",
					responseTextClassName: "rag-chat-response-text",
					copyButtonClassName: "rag-chat-copy-btn",
					badgeText,
					scrollToBottom: () => this.scrollToBottom(),
				},
			);
			updateConversationHistory(this.conversationHistory, query, renderedMessage, this.pluginSettings.maxConvHistory);
			new Notice("Notes chat response ready.");

			this.scrollToBottom();
		} catch (error) {
			thinkingEl.remove();

			const errorMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-error" });
			errorMsg.createSpan({
				text: error instanceof Error ? error.message : "Failed to get response. Make sure notes are indexed."
			});

			console.error("RAG Chat Error:", error);
			new Notice(error instanceof Error ? error.message : "Notes chat failed. Make sure notes are indexed.");
			this.scrollToBottom();
		}
	}

	private clearConversation() {
		this.conversationHistory = [];
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
