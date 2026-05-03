import { App, MarkdownView, Notice, TFile, requestUrl, setIcon } from "obsidian";
import { extractActualResponse, parseReasoningMarkers } from "./reasoningExtractor";
import type OLocalLLMPlugin from "../main";

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
	sources?: string[];
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
	ragSources?: string[];
}

interface RenderAgentResponseOptions {
	messageClassName: string;
	responseTextClassName?: string;
	copyButtonClassName?: string;
	badgeText?: string;
	scrollToBottom?: () => void;
}

const ACTION_BLOCK_PATTERN = /<vault-actions>\s*([\s\S]*?)\s*<\/vault-actions>/i;

export class VaultAgentService {
	constructor(private app: App, private plugin: OLocalLLMPlugin) {}

	async submitChat(request: SubmitChatRequest): Promise<AgentResponse> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.plugin.settings.openAIApiKey && this.plugin.settings.openAIApiKey !== "not-needed") {
			headers["Authorization"] = `Bearer ${this.plugin.settings.openAIApiKey}`;
		}

		const response = await requestUrl({
			url: this.getChatCompletionsUrl(),
			method: "POST",
			headers,
			body: JSON.stringify(this.buildRequestBody(request)),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`LLM server returned ${response.status}: ${response.text}`);
		}

		let rawResponse = response.json?.choices?.[0]?.message?.content ?? "";
		if (typeof rawResponse !== "string") {
			throw new Error("Chat completion returned an unexpected response shape.");
		}

		if (this.plugin.settings.extractReasoningResponses) {
			const markers = parseReasoningMarkers(this.plugin.settings.reasoningMarkers || "");
			rawResponse = extractActualResponse(rawResponse, markers);
		}

		return this.parseAgentResponse(rawResponse, request.context, request.ragSources);
	}

	private buildRequestBody(request: SubmitChatRequest) {
		const isRagChat = Boolean(request.ragContext);
		const systemParts = [
			isRagChat
				? [
					"You are a helpful assistant answering questions based on the user's notes.",
					"Use the retrieved note context to answer the question.",
					"If the context doesn't contain relevant information, say so.",
					"Be concise and cite specific notes when possible.",
				].join("\n")
				: "You are a helpful writing and note-taking assistant inside Obsidian.",
			this.plugin.personasDict[this.plugin.settings.personas]?.systemPrompt?.trim() || "",
			this.plugin.settings.enableVaultActions
				? [
					"Vault actions are enabled.",
					"When the user asks you to create a note, append to a note, or replace the current selection, propose actions instead of claiming the changes were already made.",
					"Never say a vault write was completed unless the user approves it in the UI.",
					"Only emit actions inside a single <vault-actions>...</vault-actions> block.",
					"Inside that block, output strict JSON with shape {\"message\": string, \"actions\": AgentAction[]}.",
					"Allowed actions:",
					"- create_note: {\"type\":\"create_note\",\"path\":string?,\"title\":string?,\"content\":string}",
					"- append_to_note: {\"type\":\"append_to_note\",\"target\":string,\"content\":string}",
					"- replace_selection: {\"type\":\"replace_selection\",\"content\":string}",
					"If the request is ambiguous, ask a clarifying question in normal text and do not emit actions.",
					"If no write is needed, answer normally and do not emit a vault-actions block.",
				].join("\n")
				: "Vault actions are disabled. Answer in plain text only and do not emit vault action JSON.",
		].filter(Boolean);

		const contextParts: string[] = [];
		if (request.context.activeFilePath) {
			contextParts.push(`Active note path: ${request.context.activeFilePath}`);
		}
		if (request.context.activeNoteTitle) {
			contextParts.push(`Active note title: ${request.context.activeNoteTitle}`);
		}
		if (request.context.selectedText) {
			contextParts.push(`Selected text:\n${request.context.selectedText}`);
		}
		if (request.ragContext) {
			contextParts.push(`Retrieved note context:\n${request.ragContext}`);
		}

		const messages: Array<{ role: string; content: string }> = [
			{ role: "system", content: systemParts.join("\n\n") },
			...this.getRecentConversation(request.conversationHistory).flatMap((entry) => [
				{ role: "user", content: entry.prompt },
				{ role: "assistant", content: entry.response },
			]),
		];

		if (contextParts.length > 0) {
			messages.push({
				role: "system",
				content: `Current workspace context:\n${contextParts.join("\n\n")}`,
			});
		}

		messages.push({ role: "user", content: request.message });

		return {
			model: this.plugin.settings.llmModel,
			messages,
			temperature: this.plugin.settings.temperature,
			max_tokens: this.plugin.settings.maxTokens,
			stream: false,
		};
	}

	private getRecentConversation(conversationHistory: ConversationEntry[]): ConversationEntry[] {
		const maxHistory = Math.max(0, this.plugin.settings.maxConvHistory || 0);
		if (maxHistory === 0) {
			return [];
		}
		return conversationHistory.slice(-maxHistory);
	}

	private async parseAgentResponse(rawResponse: string, context: ChatEnvironmentContext, ragSources?: string[]): Promise<AgentResponse> {
		const blockMatch = rawResponse.match(ACTION_BLOCK_PATTERN);
		const rawActionJson = blockMatch?.[1]?.trim();
		const messageOutsideBlock = blockMatch
			? rawResponse.replace(blockMatch[0], "").trim()
			: rawResponse.trim();

		if (!rawActionJson) {
			return {
				message: messageOutsideBlock,
				rawResponse,
				actions: [],
				sources: ragSources,
			};
		}

		let envelope: AgentEnvelope;
		try {
			envelope = JSON.parse(rawActionJson) as AgentEnvelope;
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
		const pendingActions = await Promise.all(
			rawActions.map((action, index) => this.validateAction(action, context, index))
		);

		return {
			message: envelopeMessage || messageOutsideBlock || "I drafted a vault action for your review.",
			rawResponse,
			rawActionJson,
			actions: pendingActions,
			sources: ragSources,
		};
	}

	private async validateAction(rawAction: unknown, context: ChatEnvironmentContext, index: number): Promise<PendingAction> {
		const parsedAction = this.parseAction(rawAction);
		if (!parsedAction.action) {
			return this.invalidAction(index, parsedAction.error, rawAction);
		}

		const action = parsedAction.action;
		const basePending: PendingAction = {
			id: `${Date.now()}-${index}`,
			action,
			title: this.getActionTitle(action),
			description: this.getActionDescription(action),
			preview: this.getActionPreview(action, context),
			status: "pending",
		};

		if (!this.plugin.settings.enableVaultActions) {
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
		if (!this.plugin.settings.enableVaultActions) {
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
				if (!(resolved instanceof TFile)) {
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
		const assistantMessage = this.createAssistantMessage(chatHistoryEl, renderedMessage, options);

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

	private createAssistantMessage(chatHistoryEl: HTMLElement, text: string, options: RenderAgentResponseOptions): HTMLElement {
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
		renderSafeMarkdownishText(responseTextEl, text);
		return responseContainer;
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

		approveBtn.addEventListener("click", async () => {
			approveBtn.disabled = true;
			rejectBtn.disabled = true;
			statusEl.setText("Applying action...");
			const result = await this.executeAction(action, context);
			if (result.success) {
				action.status = "approved";
				statusEl.setText(result.message);
				statusEl.removeClass("is-invalid");
				statusEl.addClass("is-approved");
			} else {
				action.status = "failed";
				statusEl.setText(result.message);
				statusEl.removeClass("is-approved");
				statusEl.addClass("is-invalid");
				rejectBtn.disabled = false;
			}
			scrollToBottom?.();
		});

		rejectBtn.addEventListener("click", () => {
			action.status = "rejected";
			approveBtn.disabled = true;
			rejectBtn.disabled = true;
			statusEl.setText("Action rejected. No changes were made.");
			statusEl.removeClass("is-approved");
			statusEl.addClass("is-rejected");
			scrollToBottom?.();
		});
	}

	private renderSources(container: HTMLElement, sources: string[]) {
		const sourcesEl = container.createDiv({ cls: "rag-chat-sources" });
		sourcesEl.createEl("span", { text: "Sources:", cls: "rag-chat-sources-label" });
		const sourcesList = sourcesEl.createDiv({ cls: "rag-chat-sources-list" });
		for (const source of sources) {
			const item = sourcesList.createDiv({ cls: "rag-chat-source-item" });
			const icon = item.createSpan({ cls: "rag-chat-source-icon" });
			setIcon(icon, "file-text");
			item.createSpan({ text: source, cls: "rag-chat-source-name" });
			item.addEventListener("click", () => {
				this.app.workspace.openLinkText(source, "", false);
			});
		}
	}

	private appendCopyButton(container: HTMLElement, text: string, className?: string) {
		const copyButton = container.createEl("button", { cls: className || "copy-button" });
		setIcon(copyButton, "copy");
		copyButton.setAttribute("aria-label", "Copy response");
		copyButton.addEventListener("click", () => {
			navigator.clipboard.writeText(text).then(() => {
				new Notice("Copied to clipboard");
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

	private invalidAction(index: number, error: string, rawAction: unknown): PendingAction {
		return {
			id: `${Date.now()}-${index}`,
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
		if (parts.some(part => !part || part === "." || part === "..")) {
			return undefined;
		}
		return normalized;
	}

	private async resolveNote(target: string): Promise<{ ok: true; file: TFile } | { ok: false; error: string }> {
		const trimmed = target.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
		if (!trimmed) {
			return { ok: false, error: "Append action is missing a note target." };
		}

		const directCandidates = [trimmed, trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`];
		for (const candidate of directCandidates) {
			const direct = this.app.vault.getAbstractFileByPath(candidate);
			if (direct instanceof TFile) {
				return { ok: true, file: direct };
			}
		}

		const markdownFiles = this.app.vault.getMarkdownFiles();
		const baseName = trimmed.replace(/\.md$/i, "");
		const matches = markdownFiles.filter((file) => file.basename === baseName);
		if (matches.length === 1) {
			return { ok: true, file: matches[0] };
		}
		if (matches.length > 1) {
			return { ok: false, error: `Multiple notes match "${target}". Use the full path.` };
		}
		return { ok: false, error: `Could not find a note matching "${target}".` };
	}

	private getChatCompletionsUrl(): string {
		const serverAddress = this.plugin.settings.serverAddress.replace(/\/+$/, "");
		return serverAddress.endsWith("/v1")
			? `${serverAddress}/chat/completions`
			: `${serverAddress}/v1/chat/completions`;
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
		} catch (_error) {
			return String(value);
		}
	}
}

export function getActiveChatContext(app: App): ChatEnvironmentContext {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.getMode() !== "source" || !("editor" in view)) {
		return {};
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
	if (fallback?.selectedText) {
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
