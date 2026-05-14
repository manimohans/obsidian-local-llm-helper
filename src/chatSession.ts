import { App, TFile } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { RAGQueryScope } from "./rag";
import {
	type AgentResponse,
	type ChatEnvironmentContext,
	type ConversationEntry,
	getCurrentOrFallbackChatContext,
} from "./vaultAgent";

export interface ParsedScopeOverride {
	scope?: RAGQueryScope;
	cleanQuery: string;
}

export interface ChatSubmitResult {
	response: AgentResponse;
	context: ChatEnvironmentContext;
	renderedPrompt: string;
	badgeText?: string;
}

export function updateConversationHistory(
	conversationHistory: ConversationEntry[],
	prompt: string,
	response: string,
	maxConvHistoryLength: number,
): void {
	conversationHistory.push({ prompt, response });
	if (conversationHistory.length > maxConvHistoryLength) {
		conversationHistory.shift();
	}
}

export function appendThinkingDots(containerEl: HTMLElement): void {
	const dots = containerEl.createSpan({ cls: "dots" });
	dots.createSpan({ cls: "dot" });
	dots.createSpan({ cls: "dot" });
	dots.createSpan({ cls: "dot" });
}

export async function submitGeneralChat(
	plugin: OLocalLLMPlugin,
	message: string,
	conversationHistory: ConversationEntry[],
	initialChatContext: ChatEnvironmentContext,
): Promise<ChatSubmitResult> {
	const context = getCurrentOrFallbackChatContext(plugin.app, initialChatContext);
	const response = await plugin.vaultAgent.submitChat({
		message,
		conversationHistory,
		context,
	});

	return {
		response,
		context,
		renderedPrompt: message,
	};
}

export async function submitNotesChat(
	plugin: OLocalLLMPlugin,
	message: string,
	conversationHistory: ConversationEntry[],
	initialChatContext: ChatEnvironmentContext,
	scope: RAGQueryScope,
	badgeText: string,
): Promise<ChatSubmitResult> {
	const context = getCurrentOrFallbackChatContext(plugin.app, initialChatContext);
	const ragContext = await plugin.ragManager.getRelevantContext(message, scope);
	const response = await plugin.vaultAgent.submitChat({
		message,
		conversationHistory,
		context,
		ragContext: ragContext.context,
		ragSources: ragContext.sources,
	});

	return {
		response,
		context,
		renderedPrompt: message,
		badgeText,
	};
}

export function parseRAGScopeOverride(app: App, rawQuery: string): ParsedScopeOverride {
	let cleanQuery = rawQuery;
	const notePaths = new Set<string>();
	const folderMatches: string[] = [];
	const tagMatches = new Set<string>();

	cleanQuery = cleanQuery.replace(/@\[\[([^\]]+)\]\]/g, (_match, noteRef: string) => {
		const normalizedRef = noteRef.split("|")[0].trim();
		const file = resolveNoteReference(app, normalizedRef);
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
				label: notePaths.size === 1 ? Array.from(notePaths)[0] : `${notePaths.size} mentioned notes`,
			},
			cleanQuery: finalQuery,
		};
	}

	if (folderMatches.length > 0) {
		const folder = folderMatches[folderMatches.length - 1];
		return {
			scope: {
				mode: "folder",
				folder,
				label: folder || "Vault root",
			},
			cleanQuery: finalQuery,
		};
	}

	if (tagMatches.size > 0) {
		return {
			scope: {
				mode: "tags",
				tags: Array.from(tagMatches),
				label: Array.from(tagMatches).map(tag => `#${tag}`).join(", "),
			},
			cleanQuery: finalQuery,
		};
	}

	return { cleanQuery: finalQuery };
}

function resolveNoteReference(app: App, reference: string): TFile | null {
	const exact = app.metadataCache.getFirstLinkpathDest(reference, "");
	if (exact) {
		return exact;
	}

	const normalizedReference = reference.replace(/\.md$/i, "").toLowerCase();
	return app.vault.getMarkdownFiles().find(file =>
		file.path.toLowerCase() === normalizedReference ||
		file.path.toLowerCase() === `${normalizedReference}.md` ||
		file.basename.toLowerCase() === normalizedReference
	) || null;
}
