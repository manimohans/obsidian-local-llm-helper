import { App, Modal, TextComponent, ButtonComponent, Notice, DropdownComponent, setIcon, TFile } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { OLocalLLMSettings } from "../main";
import { RAGManager, RAGQueryScope } from "./rag";
import { type ChatEnvironmentContext, type ConversationEntry, getActiveChatContext, getCurrentOrFallbackChatContext } from "./vaultAgent";

type ScopeOption = "vault" | "current-note" | "current-folder" | "tag";

interface ParsedScopeOverride {
	scope?: RAGQueryScope;
	cleanQuery: string;
}

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
	private scopeSelect: DropdownComponent;
	private scopeValueInput: TextComponent | null = null;
	private scopeMetaEl: HTMLElement | null = null;
	private scopeOption: ScopeOption;
	private scopeDraftValue: string = "";
	private initialScope?: RAGQueryScope;

	constructor(app: App, settings: OLocalLLMSettings, ragManager: RAGManager, plugin: OLocalLLMPlugin, initialScope?: RAGQueryScope) {
		super(app);
		this.pluginSettings = settings;
		this.ragManager = ragManager;
		this.plugin = plugin;
		this.initialScope = initialScope;
		this.initialChatContext = getActiveChatContext(app);
		this.scopeOption = this.getOptionFromScope(initialScope);
		if (initialScope?.mode === "tags" && initialScope.tags?.length) {
			this.scopeDraftValue = initialScope.tags.map(tag => `#${tag.replace(/^#/, "")}`).join(", ");
		}
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
		const scopeLabel = scopeBar.createSpan({ text: "Scope", cls: "rag-chat-scope-label" });
		this.scopeSelect = new DropdownComponent(scopeBar);
		this.scopeSelect.selectEl.addClass("rag-chat-scope-select");
		this.scopeSelect
			.addOption("vault", "Entire vault")
			.addOption("current-note", "Current note")
			.addOption("current-folder", "Current folder")
			.addOption("tag", "Tag")
			.setValue(this.scopeOption)
			.onChange((value: ScopeOption) => {
				this.scopeOption = value;
				this.renderScopeValueInput();
				this.updateScopeMeta();
			});
		scopeLabel.setAttribute("for", this.scopeSelect.selectEl.id);

		this.scopeMetaEl = scopeBar.createDiv({ cls: "rag-chat-scope-meta" });
		this.renderScopeValueInput();
		this.updateScopeMeta();

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
				this.handleSubmit();
			}
		});

		this.submitButton = new ButtonComponent(inputRow)
			.setButtonText("Send")
			.setCta()
			.onClick(() => this.handleSubmit());
		this.submitButton.buttonEl.addClass("rag-chat-submit-btn");

		this.updateSubmitButtonState();
		this.textInput.inputEl.focus();
	}

	private getOptionFromScope(scope?: RAGQueryScope): ScopeOption {
		switch (scope?.mode) {
			case "paths":
				return "current-note";
			case "folder":
				return "current-folder";
			case "tags":
				return "tag";
			default:
				return "vault";
		}
	}

	private renderScopeValueInput() {
		if (!this.scopeMetaEl) {
			return;
		}

		this.scopeMetaEl.empty();
		this.scopeValueInput = null;

		if (this.scopeOption !== "tag") {
			return;
		}

		const tagInputWrap = this.scopeMetaEl.createDiv({ cls: "rag-chat-scope-input-wrap" });
		this.scopeValueInput = new TextComponent(tagInputWrap)
			.setPlaceholder("#project, #meeting-notes")
			.setValue(this.scopeDraftValue)
			.onChange((value) => {
				this.scopeDraftValue = value;
				this.updateScopeMeta();
			});
		this.scopeValueInput.inputEl.addClass("rag-chat-scope-input");
	}

	private updateScopeMeta() {
		if (!this.scopeMetaEl) {
			return;
		}

		this.scopeMetaEl.querySelectorAll(".rag-chat-scope-hint").forEach(el => el.remove());

		if (this.scopeOption === "tag") {
			const hint = this.scopeMetaEl.createDiv({ cls: "rag-chat-scope-hint" });
			const tags = this.parseTags(this.scopeDraftValue);
			hint.setText(tags.length > 0
				? `Filtering indexed notes with ${tags.map(tag => `#${tag}`).join(", ")}`
				: "Type one or more tags separated by commas");
			return;
		}

		const hint = this.scopeMetaEl.createDiv({ cls: "rag-chat-scope-hint" });
		hint.setText(this.describeResolvedScope(this.resolveScopeFromSelection()));
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

		const parsedOverride = this.parseScopeOverride(this.result);
		const selectionScope = this.resolveScopeFromSelection();
		const scope = parsedOverride.scope || selectionScope;
		const query = parsedOverride.cleanQuery;

		const userMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-user" });
		userMsg.createSpan({ text: this.result });

		this.result = "";
		this.textInput.setValue("");
		this.updateSubmitButtonState();

		const thinkingEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-thinking" });
		thinkingEl.innerHTML = `Searching ${this.escapeHtml(this.describeResolvedScope(scope))}<span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>`;
		this.scrollToBottom();

		try {
			const contextSnapshot = getCurrentOrFallbackChatContext(this.app, this.initialChatContext);
			const ragContext = await this.ragManager.getRelevantContext(query, scope);
			const response = await this.plugin.vaultAgent.submitChat({
				message: query,
				conversationHistory: this.conversationHistory,
				context: contextSnapshot,
				ragContext: ragContext.context,
				ragSources: ragContext.sources,
			});

			thinkingEl.remove();

			const renderedMessage = this.plugin.vaultAgent.renderAgentResponse(
				this.chatHistoryEl,
				response,
				contextSnapshot,
				{
					messageClassName: "rag-chat-message rag-chat-message-ai",
					responseTextClassName: "rag-chat-response-text",
					copyButtonClassName: "rag-chat-copy-btn",
					badgeText: this.describeResolvedScope(scope),
					scrollToBottom: () => this.scrollToBottom(),
				},
			);
			this.updateConversationHistory(query, renderedMessage);

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

	private updateConversationHistory(prompt: string, response: string) {
		this.conversationHistory.push({ prompt, response });
		if (this.conversationHistory.length > this.pluginSettings.maxConvHistory) {
			this.conversationHistory.shift();
		}
	}

	private parseScopeOverride(rawQuery: string): ParsedScopeOverride {
		let cleanQuery = rawQuery;
		const notePaths = new Set<string>();
		const folderMatches: string[] = [];
		const tagMatches = new Set<string>();

		cleanQuery = cleanQuery.replace(/@\[\[([^\]]+)\]\]/g, (_match, noteRef: string) => {
			const normalizedRef = noteRef.split("|")[0].trim();
			const file = this.resolveNoteReference(normalizedRef);
			if (file) {
				notePaths.add(file.path);
			}
			return "";
		});

		cleanQuery = cleanQuery.replace(/@folder\(([^)]+)\)/gi, (_match, folderRef: string) => {
			const normalizedFolder = folderRef.trim().replace(/^\/+|\/+$/g, "");
			if (normalizedFolder || folderRef.trim() === "/") {
				folderMatches.push(normalizedFolder);
			}
			return "";
		});

		cleanQuery = cleanQuery.replace(/(^|\s)#([A-Za-z0-9/_-]+)/g, (_match, leadingSpace: string, tagRef: string) => {
			tagMatches.add(tagRef.toLowerCase());
			return leadingSpace;
		});

		const compactQuery = cleanQuery.replace(/\s{2,}/g, " ").trim();
		const finalQuery = compactQuery || "Summarize the scoped notes.";

		if (notePaths.size > 0) {
			return {
				scope: {
					mode: "paths",
					paths: Array.from(notePaths),
					label: notePaths.size === 1 ? Array.from(notePaths)[0] : `${notePaths.size} mentioned notes`
				},
				cleanQuery: finalQuery
			};
		}

		if (folderMatches.length > 0) {
			const folder = folderMatches[folderMatches.length - 1];
			return {
				scope: {
					mode: "folder",
					folder,
					label: folder || "Vault root"
				},
				cleanQuery: finalQuery
			};
		}

		if (tagMatches.size > 0) {
			return {
				scope: {
					mode: "tags",
					tags: Array.from(tagMatches),
					label: Array.from(tagMatches).map(tag => `#${tag}`).join(", ")
				},
				cleanQuery: finalQuery
			};
		}

		return { cleanQuery: finalQuery };
	}

	private resolveScopeFromSelection(): RAGQueryScope {
		switch (this.scopeOption) {
			case "current-note": {
				const file = this.getActiveMarkdownFile();
				return file
					? { mode: "paths", paths: [file.path], label: file.basename }
					: { mode: "vault", label: "Entire vault" };
			}
			case "current-folder": {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					return { mode: "vault", label: "Entire vault" };
				}
				const folder = this.getFolderPath(file);
				return {
					mode: "folder",
					folder,
					label: folder || "Vault root"
				};
			}
			case "tag": {
				const tags = this.parseTags(this.scopeDraftValue);
				return tags.length > 0
					? { mode: "tags", tags, label: tags.map(tag => `#${tag}`).join(", ") }
					: { mode: "vault", label: "Entire vault" };
			}
			default:
				return this.initialScope || { mode: "vault", label: "Entire vault" };
		}
	}

	private describeResolvedScope(scope: RAGQueryScope): string {
		switch (scope.mode) {
			case "paths":
				if ((scope.paths || []).length === 1) {
					return `current note: ${scope.label || scope.paths?.[0]}`;
				}
				return scope.label || `${scope.paths?.length || 0} notes`;
			case "folder":
				return `folder: ${scope.label || scope.folder || "Vault root"}`;
			case "tags":
				return `tags: ${(scope.tags || []).map(tag => `#${tag.replace(/^#/, "")}`).join(", ")}`;
			default:
				return "entire vault";
		}
	}

	private resolveNoteReference(reference: string): TFile | null {
		const exact = this.app.metadataCache.getFirstLinkpathDest(reference, "");
		if (exact) {
			return exact;
		}

		const normalizedReference = reference.replace(/\.md$/i, "").toLowerCase();
		return this.app.vault.getMarkdownFiles().find(file =>
			file.path.toLowerCase() === normalizedReference ||
			file.path.toLowerCase() === `${normalizedReference}.md` ||
			file.basename.toLowerCase() === normalizedReference
		) || null;
	}

	private parseTags(rawValue: string): string[] {
		return rawValue
			.split(",")
			.map(part => part.trim())
			.filter(Boolean)
			.map(tag => tag.replace(/^#/, "").toLowerCase());
	}

	private getActiveMarkdownFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	private getFolderPath(file: TFile): string {
		const lastSlashIndex = file.path.lastIndexOf("/");
		return lastSlashIndex === -1 ? "" : file.path.slice(0, lastSlashIndex);
	}

	private formatResponse(text: string): string {
		return text
			.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
			.replace(/\*(.*?)\*/g, "<em>$1</em>")
			.replace(/\n\n/g, "</p><p>")
			.replace(/\n/g, "<br>");
	}

	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
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
