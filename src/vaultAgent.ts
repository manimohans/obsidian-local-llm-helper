import { ChatRenderScope } from "./chatRenderScope";
import { App, MarkdownView, Notice, TFile, setIcon } from "obsidian";
import { extractActualResponse, parseReasoningMarkers } from "./reasoningExtractor";
import type OLocalLLMPlugin from "../main";
import type { SourceReference } from "./rag";
import {
	type ChatMessage,
	type CompletionRequest,
	OpenAICompatibleClient,
} from "./llmClient";
import { buildVaultChatSystemPrompt, buildVaultChatUserMessage } from "./prompts";

export interface ConversationEntry {
	prompt: string;
	response: string;
}

export interface ChatEnvironmentContext {
	activeFilePath?: string;
	activeNoteTitle?: string;
	selectedText?: string;
	selectionFilePath?: string;
}

export interface AgentEnvelope {
	message?: unknown;
	actions?: unknown;
}

export type AgentAction =
	| {
		type: "create_note";
		path?: string;
		title?: string;
		content: string;
	}
	| {
		type: "append_to_note";
		target: string;
		content: string;
	}
	| {
		type: "replace_selection";
		content: string;
	};

export interface PendingAction {
	id: string;
	action?: AgentAction;
	origin: "chat" | "workflow";
	title: string;
	description: string;
	preview: string;
	status: "pending" | "invalid" | "approved" | "rejected" | "failed";
	error?: string;
	resolvedPath?: string;
}

export interface AgentResponse {
	message: string;
	rawResponse: string;
	rawActionJson?: string;
	actions: PendingAction[];
	parseError?: string;
	sources?: SourceReference[];
}

interface AgentExecutionResult {
	success: boolean;
	message: string;
}

interface SubmitChatRequest {
	message: string;
	conversationHistory: ConversationEntry[];
	context: ChatEnvironmentContext;
	ragContext?: string;
	ragSources?: SourceReference[];
}

interface RenderAgentResponseOptions {
	renderScope: ChatRenderScope;
	messageClassName: string;
	responseTextClassName?: string;
	copyButtonClassName?: string;
	badgeText?: string;
	scrollToBottom?: () => void;
}

const ACTION_BLOCK_PATTERN = /^\s*<vault-actions>\s*([\s\S]*?)\s*<\/vault-actions>\s*$/i;
const ANY_ACTION_BLOCK_PATTERN = /<vault-actions>\s*([\s\S]*?)\s*<\/vault-actions>/i;

export function isSafeVaultMarkdownPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
	const parts = normalized.split("/");
	return normalized.toLowerCase().endsWith(".md")
		&& parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."));
}

export class VaultAgentService {
	constructor(
		private app: App,
		private plugin: OLocalLLMPlugin,
		private llmClient: OpenAICompatibleClient,
	) {}

	async submitChat(request: SubmitChatRequest): Promise<AgentResponse> {
		let rawResponse = await this.llmClient.complete(this.buildRequestBody(request));

		if (
			this.plugin.settings.extractReasoningResponses
			|| this.plugin.settings.enableVaultActions
		) {
			const markers = parseReasoningMarkers(this.plugin.settings.reasoningMarkers || "");
			rawResponse = extractActualResponse(rawResponse, markers);
		}

		return this.parseAgentResponse(rawResponse, request.context, request.ragSources);
	}

	private buildRequestBody(request: SubmitChatRequest): CompletionRequest {
		const isRagChat = Boolean(request.ragContext);
		const personaPrompt = this.plugin.personasDict[this.plugin.settings.personas]?.systemPrompt;
		const systemPrompt = buildVaultChatSystemPrompt({
			isRagChat,
			personaPrompt,
			enableVaultActions: this.plugin.settings.enableVaultActions,
		});
		const context: Record<string, string> = {
			activeNotePath: request.context.activeFilePath || "",
			activeNoteTitle: request.context.activeNoteTitle || "",
			selectionFilePath: request.context.selectionFilePath || "",
			selectedText: request.context.selectedText || "",
			retrievedNoteContext: request.ragContext || "",
		};

		const messages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...this.getRecentConversation(request.conversationHistory).flatMap<ChatMessage>((entry) => [
				{ role: "user", content: entry.prompt },
				{ role: "assistant", content: entry.response },
			]),
			{
				role: "user",
				content: buildVaultChatUserMessage({ message: request.message, context }),
			},
		];

		return {
			model: this.plugin.settings.llmModel,
			messages,
			temperature: this.plugin.settings.temperature,
			maxTokens: this.plugin.settings.maxTokens,
			bufferedStream: false,
		};
	}

	private getRecentConversation(conversationHistory: ConversationEntry[]): ConversationEntry[] {
		const maxHistory = Math.max(0, this.plugin.settings.maxConvHistory || 0);
		if (maxHistory === 0) {
			return [];
		}
		return conversationHistory.slice(-maxHistory);
	}

	private async parseAgentResponse(rawResponse: string, context: ChatEnvironmentContext, ragSources?: SourceReference[]): Promise<AgentResponse> {
		const blockMatch = rawResponse.match(ACTION_BLOCK_PATTERN);
		const mixedBlockMatch = blockMatch ? undefined : rawResponse.match(ANY_ACTION_BLOCK_PATTERN);
		if (mixedBlockMatch) {
			return {
				message: "I could not safely prepare a vault action because the action block was mixed with other response text.",
				rawResponse,
				rawActionJson: mixedBlockMatch[1]?.trim(),
				actions: [],
				parseError: "Vault action block must be the only response content.",
				sources: ragSources,
			};
		}
		const rawActionJson = blockMatch?.[1]?.trim();
		const messageOutsideBlock = blockMatch ? "" : rawResponse.trim();

		if (!rawActionJson) {
			return {
				message: messageOutsideBlock,
				rawResponse,
				actions: [],
				sources: ragSources,
			};
		}

		let parsedEnvelope: unknown;
		try {
			parsedEnvelope = JSON.parse(rawActionJson) as unknown;
		} catch (error) {
			return {
				message: messageOutsideBlock || "I could not safely prepare a vault action because the action payload was invalid.",
				rawResponse,
				rawActionJson,
				actions: [],
				parseError: error instanceof Error ? error.message : "Invalid JSON",
				sources: ragSources,
			};
		}
		if (!this.isRecord(parsedEnvelope)) {
			return {
				message: messageOutsideBlock || "I could not safely prepare a vault action because the action payload was not a JSON object.",
				rawResponse,
				rawActionJson,
				actions: [],
				parseError: "Action payload must be a JSON object.",
				sources: ragSources,
			};
		}
		const envelope = parsedEnvelope as AgentEnvelope;

		const envelopeMessage = typeof envelope.message === "string" ? envelope.message.trim() : "";
		if (!this.plugin.settings.enableVaultActions) {
			return {
				message: envelopeMessage || messageOutsideBlock || "Vault actions are disabled. I did not prepare any note changes.",
				rawResponse,
				rawActionJson,
				actions: [],
				sources: ragSources,
			};
		}

		const rawActions = Array.isArray(envelope.actions) ? envelope.actions : [];
		const pendingActions = await this.prepareManualActions(rawActions, context, "chat");

		return {
			message: envelopeMessage || messageOutsideBlock || "I drafted a vault action for your review.",
			rawResponse,
			rawActionJson,
			actions: pendingActions,
			sources: ragSources,
		};
	}

	async prepareManualActions(rawActions: unknown[], context: ChatEnvironmentContext, origin: "chat" | "workflow"): Promise<PendingAction[]> {
		return Promise.all(rawActions.map((action, index) => this.validateAction(action, context, index, origin)));
	}

	private async validateAction(rawAction: unknown, context: ChatEnvironmentContext, index: number, origin: "chat" | "workflow"): Promise<PendingAction> {
		const parsedAction = this.parseAction(rawAction);
		if (!parsedAction.action) {
			return this.invalidAction(index, parsedAction.error, rawAction, origin);
		}

		const action = parsedAction.action;
		const basePending: PendingAction = {
			id: `${Date.now()}-${index}`,
			action,
			origin,
			title: this.getActionTitle(action),
			description: this.getActionDescription(action),
			preview: this.getActionPreview(action, context),
			status: "pending",
		};

		if (origin === "chat" && !this.plugin.settings.enableVaultActions) {
			return {
				...basePending,
				status: "invalid",
				error: "Vault Actions are disabled in settings.",
			};
		}

		if (action.type === "create_note") {
			const path = this.normalizeCreatePath(action);
			if (!path) {
				return { ...basePending, status: "invalid", error: "Create note action is missing a valid path or title." };
			}
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing) {
				return { ...basePending, status: "invalid", error: `A note already exists at ${path}.` };
			}
			return { ...basePending, resolvedPath: path };
		}

		if (action.type === "append_to_note") {
			const target = await this.resolveNote(action.target);
			if (!target.ok) {
				return { ...basePending, status: "invalid", error: target.error };
			}
			return { ...basePending, resolvedPath: target.file.path };
		}

		if (action.type === "replace_selection") {
			if (!context.selectionFilePath || !context.selectedText) {
				return { ...basePending, status: "invalid", error: "No active editor selection was captured for this request." };
			}
			return { ...basePending, resolvedPath: context.selectionFilePath };
		}

		return { ...basePending, status: "invalid", error: "Unsupported action type." };
	}

	async executeAction(pendingAction: PendingAction, context: ChatEnvironmentContext): Promise<AgentExecutionResult> {
		if (pendingAction.origin === "chat" && !this.plugin.settings.enableVaultActions) {
			return { success: false, message: "Vault Actions are disabled in settings." };
		}
		if (pendingAction.status === "invalid") {
			return { success: false, message: pendingAction.error || "Action is invalid." };
		}
		if (!pendingAction.action) {
			return { success: false, message: "Action payload is missing or invalid." };
		}

		try {
			if (pendingAction.action.type === "create_note") {
				const path = pendingAction.resolvedPath || this.normalizeCreatePath(pendingAction.action);
				if (!path) {
					return { success: false, message: "Create note action is missing a valid destination." };
				}
				if (this.app.vault.getAbstractFileByPath(path)) {
					return { success: false, message: `A note already exists at ${path}.` };
				}
				await this.app.vault.create(path, pendingAction.action.content);
				await this.app.workspace.openLinkText(path, "", false);
				return { success: true, message: `Created note: ${path}` };
			}

			if (pendingAction.action.type === "append_to_note") {
				const resolved = pendingAction.resolvedPath
					? this.app.vault.getAbstractFileByPath(pendingAction.resolvedPath)
					: null;
				if (!(resolved instanceof TFile) || !isSafeVaultMarkdownPath(resolved.path)) {
					return { success: false, message: "The approved target note is no longer available. Re-run the request." };
				}
				const existing = await this.app.vault.cachedRead(resolved);
				const nextContent = existing.trimEnd()
					? `${existing.trimEnd()}\n\n${pendingAction.action.content}`
					: pendingAction.action.content;
				await this.app.vault.modify(resolved, nextContent);
				return { success: true, message: `Appended content to ${resolved.path}` };
			}

			if (pendingAction.action.type === "replace_selection") {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || view.getMode() !== "source" || !("editor" in view)) {
					return { success: false, message: "No editable markdown selection is active." };
				}
				if (!view.file || view.file.path !== context.selectionFilePath) {
					return { success: false, message: "The active note changed before approval. Re-run the request from the target note." };
				}
				const currentSelection = view.editor.getSelection();
				if (!currentSelection || currentSelection !== context.selectedText) {
					return { success: false, message: "The selected text changed before approval. Re-run the request with the current selection." };
				}
				view.editor.replaceSelection(pendingAction.action.content);
				return { success: true, message: `Replaced the current selection in ${view.file.path}` };
			}

			return { success: false, message: "Unsupported action type." };
		} catch (error) {
			console.error("Vault action execution failed:", error);
			return {
				success: false,
				message: error instanceof Error ? error.message : "Failed to execute action.",
			};
		}
	}

	renderAgentResponse(
		chatHistoryEl: HTMLElement,
		response: AgentResponse,
		context: ChatEnvironmentContext,
		options: RenderAgentResponseOptions,
	): string {
		const renderedMessage = response.message || "I drafted a vault action for your review.";
		const assistantMessage = this.createAssistantMessage(chatHistoryEl, renderedMessage, context, options);

		if (response.parseError) {
			this.appendStatusMessage(assistantMessage, `Invalid action payload: ${response.parseError}`, "failed");
		}

		if (response.rawActionJson && this.plugin.settings.showAgentDebug) {
			const debugEl = assistantMessage.createEl("pre", { cls: "vault-action-debug" });
			debugEl.setText(response.rawActionJson);
		}

		if (response.actions.length > 0) {
			const actionsContainer = assistantMessage.createDiv({ cls: "vault-action-list" });
			for (const action of response.actions) {
				this.renderPendingAction(actionsContainer, action, context, options.scrollToBottom);
			}
		}

		if (response.sources?.length) {
			this.renderSources(assistantMessage, response.sources);
		}

		const copyText = renderedMessage || response.rawResponse;
		this.appendCopyButton(assistantMessage, copyText, options.copyButtonClassName);

		options.scrollToBottom?.();
		return renderedMessage;
	}

	private createAssistantMessage(
		chatHistoryEl: HTMLElement,
		text: string,
		context: ChatEnvironmentContext,
		options: RenderAgentResponseOptions,
	): HTMLElement {
		const responseContainer = chatHistoryEl.createDiv({ cls: options.messageClassName });
		if (options.badgeText) {
			const badgeRow = responseContainer.createDiv({ cls: "rag-chat-badge-row" });
			badgeRow.createSpan({
				text: options.badgeText,
				cls: "rag-chat-scope-badge",
			});
		}

		const responseTextEl = options.responseTextClassName
			? responseContainer.createDiv({ cls: options.responseTextClassName })
			: responseContainer.createDiv();
		this.renderResponseText(responseTextEl, text, context, options);
		return responseContainer;
	}

	private renderResponseText(
		container: HTMLElement,
		text: string,
		context: ChatEnvironmentContext,
		options: RenderAgentResponseOptions,
	): void {
		if (!this.plugin.settings.renderMarkdownInChat) {
			renderSafeMarkdownishText(container, text);
			return;
		}

		container.addClass("markdown-rendered", "llm-helper-chat-markdown");
		options.renderScope.render(this.app, text, container, context.activeFilePath || "",
			options.scrollToBottom, (error) => {
				console.error("Markdown rendering failed:", error);
				container.empty();
				renderSafeMarkdownishText(container, text);
				options.scrollToBottom?.();
			});
	}

	private renderPendingAction(
		container: HTMLElement,
		action: PendingAction,
		context: ChatEnvironmentContext,
		scrollToBottom?: () => void,
	) {
		const card = container.createDiv({ cls: "vault-action-card" });
		const header = card.createDiv({ cls: "vault-action-header" });
		header.createEl("strong", { text: action.title });
		header.createSpan({ text: action.description, cls: "vault-action-description" });

		const preview = card.createEl("pre", { cls: "vault-action-preview" });
		preview.setText(action.preview);

		const statusEl = card.createDiv({ cls: "vault-action-status" });
		if (action.status === "invalid") {
			statusEl.setText(action.error || "Invalid action");
			statusEl.addClass("is-invalid");
			return;
		}

		const buttonRow = card.createDiv({ cls: "vault-action-buttons" });
		const approveBtn = buttonRow.createEl("button", { text: "Approve", cls: "mod-cta" });
		const rejectBtn = buttonRow.createEl("button", { text: "Reject" });

		approveBtn.addEventListener("click", () => {
			void (async () => {
				approveBtn.disabled = true;
				rejectBtn.disabled = true;
				statusEl.setText("Applying action...");
				const result = await this.executeAction(action, context);
				if (result.success) {
					action.status = "approved";
					statusEl.setText(result.message);
					statusEl.removeClass("is-invalid");
					statusEl.addClass("is-approved");
					new Notice(result.message);
				} else {
					action.status = "failed";
					statusEl.setText(result.message);
					statusEl.removeClass("is-approved");
					statusEl.addClass("is-invalid");
					rejectBtn.disabled = false;
					new Notice(result.message);
				}
				scrollToBottom?.();
			})();
		});

		rejectBtn.addEventListener("click", () => {
			action.status = "rejected";
			approveBtn.disabled = true;
			rejectBtn.disabled = true;
			statusEl.setText("Action rejected. No changes were made.");
			statusEl.removeClass("is-approved");
			statusEl.addClass("is-rejected");
			new Notice("Action rejected. No changes were made.");
			scrollToBottom?.();
		});
	}

	private renderSources(container: HTMLElement, sources: SourceReference[]) {
		const sourcesEl = container.createDiv({ cls: "rag-chat-sources" });
		sourcesEl.createSpan({ text: "Sources:", cls: "rag-chat-sources-label" });
		const sourcesList = sourcesEl.createDiv({ cls: "rag-chat-sources-list" });
		for (const source of sources) {
			const item = sourcesList.createDiv({ cls: "rag-chat-source-item" });
			const icon = item.createSpan({ cls: "rag-chat-source-icon" });
			setIcon(icon, source.sourceType === "image" ? "image" : "file-text");
			const sourceText = item.createDiv({ cls: "rag-chat-source-text" });
			const file = this.app.vault.getAbstractFileByPath(source.path);
			sourceText.createSpan({
				text: source.label,
				cls: "rag-chat-source-name",
			});
			if (file instanceof TFile) {
				sourceText.createSpan({ text: source.path, cls: "rag-chat-source-path" });
			}
			item.addEventListener("click", () => {
				void this.plugin.openFileByPath(source.path);
			});
		}
	}

	private appendCopyButton(container: HTMLElement, text: string, className?: string) {
		const copyButton = container.createEl("button", { cls: className || "copy-button" });
		setIcon(copyButton, "copy");
		copyButton.setAttribute("aria-label", "Copy response");
		copyButton.addEventListener("click", () => {
			void navigator.clipboard.writeText(text).then(() => {
				new Notice("Copied to clipboard");
			}).catch(() => {
				new Notice("Could not copy to clipboard");
			});
		});
	}

	private appendStatusMessage(container: HTMLElement, message: string, status: "approved" | "failed" | "rejected") {
		const statusEl = container.createDiv({ cls: "vault-action-status" });
		statusEl.setText(message);
		statusEl.addClass(status === "approved" ? "is-approved" : "is-invalid");
	}

	private parseAction(rawAction: unknown): { action?: AgentAction; error: string } {
		if (!this.isRecord(rawAction)) {
			return { error: "Action must be a JSON object." };
		}

		const type = rawAction.type;
		if (type === "create_note") {
			const content = this.asString(rawAction.content);
			if (!content || !content.trim()) {
				return { error: "Create note action is missing content." };
			}
			const path = this.asString(rawAction.path);
			const title = this.asString(rawAction.title);
			if (!path && !title) {
				return { error: "Create note action is missing a path or title." };
			}
			return {
				action: {
					type,
					path,
					title,
					content,
				},
				error: "",
			};
		}

		if (type === "append_to_note") {
			const target = this.asString(rawAction.target);
			const content = this.asString(rawAction.content);
			if (!target || !target.trim()) {
				return { error: "Append action is missing a note target." };
			}
			if (!content || !content.trim()) {
				return { error: "Append action is missing content." };
			}
			return {
				action: {
					type,
					target,
					content,
				},
				error: "",
			};
		}

		if (type === "replace_selection") {
			const content = this.asString(rawAction.content);
			if (!content || !content.trim()) {
				return { error: "Replace selection action is missing replacement content." };
			}
			return {
				action: {
					type,
					content,
				},
				error: "",
			};
		}

		return { error: typeof type === "string" ? `Unsupported action type: ${type}` : "Action is missing a string type." };
	}

	private invalidAction(index: number, error: string, rawAction: unknown, origin: "chat" | "workflow"): PendingAction {
		return {
			id: `${Date.now()}-${index}`,
			origin,
			title: "Invalid action",
			description: "Ignored",
			preview: this.safePreview(rawAction),
			status: "invalid",
			error,
		};
	}

	private getActionTitle(action: AgentAction): string {
		if (action.type === "create_note") return "Create note";
		if (action.type === "append_to_note") return "Append to note";
		return "Replace selection";
	}

	private getActionDescription(action: AgentAction): string {
		if (action.type === "create_note") {
			return this.normalizeCreatePath(action) || action.title || "New note";
		}
		if (action.type === "append_to_note") {
			return action.target;
		}
		return "Active selection";
	}

	private getActionPreview(action: AgentAction, context: ChatEnvironmentContext): string {
		if (action.type === "create_note") {
			const path = this.normalizeCreatePath(action) || "(missing path)";
			return `Path: ${path}\n\n${action.content}`;
		}
		if (action.type === "append_to_note") {
			return `Target: ${action.target}\n\n${action.content}`;
		}
		return `Original selection:\n${context.selectedText || "(no selection captured)"}\n\nReplacement:\n${action.content}`;
	}

	private normalizeCreatePath(action: Extract<AgentAction, { type: "create_note" }>): string | undefined {
		const rawPath = (action.path || action.title || "").trim();
		if (!rawPath) return undefined;

		const withoutBrackets = rawPath.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
		const withExtension = withoutBrackets.toLowerCase().endsWith(".md") ? withoutBrackets : `${withoutBrackets}.md`;
		const normalized = withExtension.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
		const parts = normalized.split("/");
		if (!isSafeVaultMarkdownPath(normalized) || parts.some(part => !part)) {
			return undefined;
		}
		return normalized;
	}

	private async resolveNote(target: string): Promise<{ ok: true; file: TFile } | { ok: false; error: string }> {
		const trimmed = target.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
		if (!trimmed) {
			return { ok: false, error: "Append action is missing a note target." };
		}
		const pathParts = trimmed.replace(/\\/g, "/").split("/");
		if (pathParts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
			return { ok: false, error: "Append target must be a Markdown note outside hidden folders." };
		}

		const directCandidates = [trimmed, ...(trimmed.endsWith(".md") ? [] : [`${trimmed}.md`])];
		for (const candidate of directCandidates) {
			const direct = this.app.vault.getAbstractFileByPath(candidate);
			if (direct instanceof TFile) {
				if (!isSafeVaultMarkdownPath(direct.path)) {
					return { ok: false, error: "Append target must be a Markdown note outside hidden folders." };
				}
				return { ok: true, file: direct };
			}
		}

		const markdownFiles = this.app.vault.getMarkdownFiles();
		const baseName = trimmed.replace(/\.md$/i, "");
		const matches = markdownFiles.filter((file) =>
			file.basename === baseName && isSafeVaultMarkdownPath(file.path));
		if (matches.length === 1) {
			return { ok: true, file: matches[0] };
		}
		if (matches.length > 1) {
			return { ok: false, error: `Multiple notes match "${target}". Use the full path.` };
		}
		return { ok: false, error: `Could not find a note matching "${target}".` };
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private asString(value: unknown): string | undefined {
		return typeof value === "string" ? value : undefined;
	}

	private safePreview(value: unknown): string {
		try {
			return JSON.stringify(value, null, 2) || String(value);
		} catch {
			return String(value);
		}
	}
}

export function getActiveChatContext(app: App): ChatEnvironmentContext {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || !view.file) {
		const file = app.workspace.getActiveFile();
		return file
			? {
				activeFilePath: file.path,
				activeNoteTitle: file.basename,
			}
			: {};
	}

	if (view.getMode() !== "source" || !("editor" in view)) {
		return {
			activeFilePath: view.file.path,
			activeNoteTitle: view.file.basename,
		};
	}

	const selectedText = view.editor.getSelection() || undefined;
	return {
		activeFilePath: view.file?.path,
		activeNoteTitle: view.file?.basename,
		selectedText,
		selectionFilePath: selectedText ? view.file?.path : undefined,
	};
}

export function getCurrentOrFallbackChatContext(app: App, fallback?: ChatEnvironmentContext): ChatEnvironmentContext {
	const current = getActiveChatContext(app);
	if (current.selectedText) {
		return current;
	}
	if (fallback?.selectedText && (!current.activeFilePath || current.activeFilePath === fallback.selectionFilePath)) {
		return fallback;
	}
	if (current.activeFilePath) {
		return current;
	}
	return fallback || {};
}

export function renderSafeMarkdownishText(container: HTMLElement, text: string): void {
	const normalized = text || "";
	const paragraphs = normalized.split(/\n{2,}/);
	for (const paragraph of paragraphs) {
		const paragraphEl = container.createEl("p");
		const lines = paragraph.split("\n");
		for (const [index, line] of lines.entries()) {
			if (index > 0) {
				paragraphEl.createEl("br");
			}
			paragraphEl.createSpan({ text: line });
		}
	}
}
