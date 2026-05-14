import { ButtonComponent, ItemView, MarkdownView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { RAGQueryScope } from "./rag";
import {
	appendThinkingDots,
	parseRAGScopeOverride,
	submitGeneralChat,
	submitNotesChat,
	updateConversationHistory,
} from "./chatSession";
import { RAGScopeSelector, describeRAGScope } from "./ragScope";
import { type ChatEnvironmentContext, type ConversationEntry, getActiveChatContext } from "./vaultAgent";

export const CHAT_VIEW_TYPE = "llm-helper-chat";

export type ChatViewMode = "general" | "notes";

export interface ChatViewOpenOptions {
	mode?: ChatViewMode;
	initialScope?: RAGQueryScope;
	initialContext?: ChatEnvironmentContext;
	focusInput?: boolean;
}

export class ChatView extends ItemView {
	private plugin: OLocalLLMPlugin;
	private mode: ChatViewMode = "general";
	private result = "";
	private conversationHistory: ConversationEntry[] = [];
	private initialChatContext: ChatEnvironmentContext;
	private headerStatusEl!: HTMLElement;
	private modeGeneralBtn!: HTMLButtonElement;
	private modeNotesBtn!: HTMLButtonElement;
	private scopeContainerEl!: HTMLElement;
	private chatHistoryEl!: HTMLElement;
	private welcomeEl: HTMLElement | null = null;
	private targetChipEl!: HTMLElement;
	private statusBannerEl!: HTMLElement;
	private textInput!: HTMLTextAreaElement;
	private submitButton!: ButtonComponent;
	private scopeSelector: RAGScopeSelector | null = null;
	private pendingInitialScope?: RAGQueryScope;
	private isGenerating = false;
	private activeRequestId = 0;
	private activeThinkingEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: OLocalLLMPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.initialChatContext = getActiveChatContext(this.app);
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "LLM Chat";
	}

	getIcon(): string {
		return "messages-square";
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass("llm-helper-chat-view");
		this.renderShell();
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
			if (leaf?.view instanceof MarkdownView) {
				this.initialChatContext = getActiveChatContext(this.app);
				this.renderHeaderStatus();
				this.renderTargetChip();
			}
		}));
		this.applyOpenOptions({ mode: this.mode, initialScope: this.pendingInitialScope });
	}

	async onClose(): Promise<void> {
		this.conversationHistory = [];
		this.contentEl.empty();
	}

	applyOpenOptions(options: ChatViewOpenOptions = {}): void {
		if (!this.chatHistoryEl) {
			this.pendingInitialScope = options.initialScope;
			if (options.mode) {
				this.mode = options.mode;
			}
			if (options.initialContext) {
				this.initialChatContext = options.initialContext;
			}
			return;
		}

		this.mode = options.mode || this.mode;
		this.pendingInitialScope = options.initialScope;
		if (options.initialContext) {
			this.initialChatContext = options.initialContext;
		}
		this.renderModeControls();
		this.renderScopeSelector();
		this.renderHeaderStatus();
		this.renderTargetChip();
		this.renderReadinessBanner();
		this.renderWelcomeState();
		this.updateInputPlaceholder();
		this.updateSubmitButtonState();

		if (options.focusInput !== false) {
			this.textInput.focus();
		}
	}

	private renderShell(): void {
		const { contentEl } = this;
		contentEl.empty();

		const headerEl = contentEl.createDiv({ cls: "llm-helper-chat-header" });
		const titleWrap = headerEl.createDiv({ cls: "llm-helper-chat-title-wrap" });
		const iconEl = titleWrap.createSpan({ cls: "llm-helper-chat-icon" });
		setIcon(iconEl, "messages-square");
		const titleText = titleWrap.createDiv({ cls: "llm-helper-chat-title-text" });
		titleText.createEl("h2", { text: "LLM Chat" });
		this.headerStatusEl = titleText.createDiv({ cls: "llm-helper-chat-status" });

		const clearBtn = headerEl.createEl("button", {
			cls: "clickable-icon llm-helper-chat-header-action",
			attr: { "aria-label": "Clear chat" },
		});
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => this.clearConversation());

		const modeEl = contentEl.createDiv({ cls: "llm-helper-chat-mode-toggle" });
		this.modeGeneralBtn = modeEl.createEl("button", { text: "General" });
		this.modeNotesBtn = modeEl.createEl("button", { text: "Notes" });
		this.modeGeneralBtn.addEventListener("click", () => this.applyOpenOptions({ mode: "general" }));
		this.modeNotesBtn.addEventListener("click", () => this.applyOpenOptions({ mode: "notes" }));

		this.scopeContainerEl = contentEl.createDiv({ cls: "llm-helper-chat-scope" });

		const chatContainer = contentEl.createDiv({ cls: "llm-helper-chat-container" });
		this.chatHistoryEl = chatContainer.createDiv({ cls: "llm-helper-chat-history rag-chat-history" });

		const inputContainer = contentEl.createDiv({ cls: "llm-helper-chat-input-container" });
		const composerMeta = inputContainer.createDiv({ cls: "llm-helper-chat-composer-meta" });
		this.targetChipEl = composerMeta.createSpan({ cls: "llm-helper-chat-target-chip" });
		this.statusBannerEl = inputContainer.createDiv({ cls: "llm-helper-chat-status-banner is-hidden" });
		const inputRow = inputContainer.createDiv({ cls: "llm-helper-chat-input-row" });

		this.textInput = inputRow.createEl("textarea", {
			cls: "llm-helper-chat-input rag-chat-input",
			attr: {
				rows: "1",
				"aria-label": "Chat message",
			},
		});
		this.textInput.addEventListener("input", () => {
			this.result = this.textInput.value;
			this.resizeComposer();
			this.updateSubmitButtonState();
		});
		this.textInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey && this.result.trim() !== "") {
				event.preventDefault();
				void this.handleSubmit();
			}
		});

		this.submitButton = new ButtonComponent(inputRow)
			.setButtonText("Send")
			.setCta()
			.onClick(() => {
				if (this.isGenerating) {
					this.stopGeneration();
					return;
				}
				void this.handleSubmit();
			});
		this.submitButton.buttonEl.addClass("llm-helper-chat-submit", "rag-chat-submit-btn");

		inputContainer.createDiv({
			text: "LLM Helper can make mistakes. Verify important output.",
			cls: "llm-helper-chat-disclaimer",
		});
	}

	private renderModeControls(): void {
		this.modeGeneralBtn.toggleClass("is-active", this.mode === "general");
		this.modeNotesBtn.toggleClass("is-active", this.mode === "notes");
		this.modeGeneralBtn.setAttribute("aria-pressed", String(this.mode === "general"));
		this.modeNotesBtn.setAttribute("aria-pressed", String(this.mode === "notes"));
	}

	private renderScopeSelector(): void {
		this.scopeContainerEl.empty();
		this.scopeSelector = null;
		this.scopeContainerEl.toggleClass("is-hidden", this.mode !== "notes");
		if (this.mode !== "notes") {
			return;
		}

		this.scopeSelector = new RAGScopeSelector(this.app, this.scopeContainerEl, {
			initialScope: this.pendingInitialScope,
			onChange: () => {
				this.renderHeaderStatus();
				this.renderTargetChip();
			},
		});
	}

	private renderHeaderStatus(): void {
		if (this.mode === "general") {
			const currentPersona = this.plugin.personasDict[this.plugin.settings.personas];
			this.headerStatusEl.setText(`General chat${currentPersona ? ` - ${currentPersona.displayName}` : ""}`);
			return;
		}

		const indexedCount = this.plugin.ragManager.getIndexedFilesCount();
		if (indexedCount === 0) {
			this.headerStatusEl.setText("Index notes to chat across your vault.");
			return;
		}
		const scopeText = this.scopeSelector ? describeRAGScope(this.scopeSelector.getScope()) : "entire vault";
		this.headerStatusEl.setText(`${indexedCount} indexed files - ${scopeText}`);
	}

	private renderTargetChip(): void {
		if (this.mode === "notes") {
			const scope = this.scopeSelector?.getScope() || ({ mode: "vault", label: "Entire vault" } as RAGQueryScope);
			this.targetChipEl.setText(describeRAGScope(scope));
			return;
		}

		if (this.initialChatContext.selectedText && this.initialChatContext.activeNoteTitle) {
			this.targetChipEl.setText(`Selection in ${this.initialChatContext.activeNoteTitle}`);
			return;
		}
		if (this.initialChatContext.activeNoteTitle) {
			this.targetChipEl.setText(`Active note: ${this.initialChatContext.activeNoteTitle}`);
			return;
		}
		this.targetChipEl.setText("General chat");
	}

	private renderReadinessBanner(): void {
		if (this.mode === "notes" && this.plugin.ragManager.getIndexedFilesCount() === 0) {
			this.setStatusBanner("Index notes before asking across your vault.", "warning");
			return;
		}
		this.clearStatusBanner();
	}

	private setStatusBanner(text: string, tone: "warning" | "error" | "info"): void {
		this.statusBannerEl.setText(text);
		this.statusBannerEl.removeClass("is-hidden", "is-warning", "is-error", "is-info");
		this.statusBannerEl.addClass(`is-${tone}`);
	}

	private clearStatusBanner(): void {
		this.statusBannerEl.empty();
		this.statusBannerEl.removeClass("is-warning", "is-error", "is-info");
		this.statusBannerEl.addClass("is-hidden");
	}

	private renderWelcomeState(): void {
		if (this.conversationHistory.length > 0) {
			return;
		}

		if (this.chatHistoryEl.children.length > 0 && !this.welcomeEl) {
			return;
		}

		this.showWelcomeMessage();
	}

	private showWelcomeMessage(): void {
		this.chatHistoryEl.empty();
		this.welcomeEl = this.chatHistoryEl.createDiv({ cls: "llm-helper-chat-empty" });
		const message = this.mode === "notes" && this.plugin.ragManager.getIndexedFilesCount() === 0
			? "Index notes to chat across your vault."
			: this.mode === "notes"
				? "Ask about your notes, current note, folder, or tags."
				: "Ask about the active note or selection.";
		this.welcomeEl.setText(message);
	}

	private hideWelcomeMessage(): void {
		if (this.welcomeEl) {
			this.welcomeEl.remove();
			this.welcomeEl = null;
		}
	}

	private async handleSubmit(): Promise<void> {
		if (this.isGenerating || this.result.trim() === "") {
			return;
		}

		this.hideWelcomeMessage();
		this.clearStatusBanner();
		const rawMessage = this.result;
		const userMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-user" });
		userMsg.createSpan({ text: rawMessage });

		this.result = "";
		this.textInput.value = "";
		this.resizeComposer();
		this.updateSubmitButtonState();

		const requestId = ++this.activeRequestId;
		this.setGenerating(true);
		const thinkingEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-thinking" });
		this.activeThinkingEl = thinkingEl;
		this.scrollToBottom();

		try {
			const result = this.mode === "notes"
				? await this.submitNotesMessage(rawMessage, thinkingEl)
				: await this.submitGeneralMessage(rawMessage, thinkingEl);
			if (requestId !== this.activeRequestId) {
				return;
			}
			thinkingEl.remove();
			this.activeThinkingEl = null;

			const renderedMessage = this.plugin.vaultAgent.renderAgentResponse(
				this.chatHistoryEl,
				result.response,
				result.context,
				{
					messageClassName: "rag-chat-message rag-chat-message-ai",
					responseTextClassName: "rag-chat-response-text",
					copyButtonClassName: "rag-chat-copy-btn",
					badgeText: result.badgeText,
					scrollToBottom: () => this.scrollToBottom(),
				},
			);
			updateConversationHistory(
				this.conversationHistory,
				result.renderedPrompt,
				renderedMessage,
				this.plugin.settings.maxConvHistory,
			);
			this.scrollToBottom();
		} catch (error) {
			if (requestId !== this.activeRequestId) {
				return;
			}
			thinkingEl.remove();
			this.activeThinkingEl = null;
			const errorMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-error" });
			const errorText = error instanceof Error ? error.message : "Chat failed. Check the console for details.";
			errorMsg.createSpan({
				text: errorText,
			});
			console.error("Sidebar chat error:", error);
			this.setStatusBanner(this.getFriendlyErrorMessage(errorText), "error");
			new Notice(errorText);
			this.scrollToBottom();
		} finally {
			if (requestId === this.activeRequestId) {
				this.setGenerating(false);
			}
		}
	}

	private async submitGeneralMessage(rawMessage: string, thinkingEl: HTMLElement) {
		thinkingEl.createSpan({ text: "Thinking" });
		appendThinkingDots(thinkingEl);
		return submitGeneralChat(this.plugin, rawMessage, this.conversationHistory, this.initialChatContext);
	}

	private async submitNotesMessage(rawMessage: string, thinkingEl: HTMLElement) {
		const parsedOverride = parseRAGScopeOverride(this.app, rawMessage);
		const selectedScope = this.scopeSelector?.getScope() || ({ mode: "vault", label: "Entire vault" } as RAGQueryScope);
		const scope = parsedOverride.scope || selectedScope;
		const query = parsedOverride.cleanQuery;
		const badgeText = describeRAGScope(scope);

		thinkingEl.createSpan({ text: `Searching ${badgeText}` });
		appendThinkingDots(thinkingEl);
		return submitNotesChat(this.plugin, query, this.conversationHistory, this.initialChatContext, scope, badgeText);
	}

	private clearConversation(): void {
		this.conversationHistory = [];
		this.chatHistoryEl.empty();
		this.showWelcomeMessage();
		this.textInput.focus();
		this.renderReadinessBanner();
	}

	private updateInputPlaceholder(): void {
		const placeholder = this.mode === "notes"
			? "Ask about your notes..."
			: "Ask about the active note or selection...";
		this.textInput.setAttribute("placeholder", placeholder);
	}

	private updateSubmitButtonState(): void {
		const isEmpty = this.result.trim() === "";
		this.submitButton.setDisabled(!this.isGenerating && isEmpty);
		this.submitButton.buttonEl.toggleClass("rag-chat-submit-disabled", !this.isGenerating && isEmpty);
	}

	private setGenerating(isGenerating: boolean): void {
		this.isGenerating = isGenerating;
		this.submitButton.setButtonText(isGenerating ? "Stop" : "Send");
		this.submitButton.buttonEl.toggleClass("is-generating", isGenerating);
		this.updateSubmitButtonState();
	}

	private stopGeneration(): void {
		this.activeRequestId += 1;
		this.setGenerating(false);
		this.activeThinkingEl?.remove();
		this.activeThinkingEl = null;
		this.setStatusBanner("Response stopped.", "info");
		this.textInput.focus();
	}

	private resizeComposer(): void {
		this.textInput.style.height = "auto";
		this.textInput.style.height = `${Math.min(this.textInput.scrollHeight, 140)}px`;
	}

	private getFriendlyErrorMessage(errorText: string): string {
		if (errorText.includes("401") || errorText.toLowerCase().includes("unauthorized")) {
			return "Authentication failed. Check your API key in settings.";
		}
		if (errorText.toLowerCase().includes("failed to fetch") || errorText.toLowerCase().includes("network")) {
			return "Could not reach the model server. Check your provider settings.";
		}
		return "Chat failed. Check model settings or console details.";
	}

	private scrollToBottom(): void {
		this.chatHistoryEl.scrollTop = this.chatHistoryEl.scrollHeight;
	}
}
