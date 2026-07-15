import { App, Editor, EditorPosition, MarkdownView, Notice } from "obsidian";
import type { OLocalLLMSettings } from "../main";
import { LLMClientError, OpenAICompatibleClient } from "./llmClient";
import { buildTagMessages } from "./prompts";

export async function generateAndAppendTags(
	app: App,
	settings: OLocalLLMSettings,
	llmClient: OpenAICompatibleClient,
) {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		new Notice("No active Markdown view");
		return;
	}

	const editor = view.editor;
	const selectedText = editor.getSelection();
	const fullText = editor.getValue();

	const textToProcess = selectedText || fullText;

	try {
		const tags = await generateTags(textToProcess, fullText, settings, llmClient);
		if (tags.length === 0) {
			new Notice("No valid tags were generated. Try again or adjust the text.");
			return;
		}
		appendTags(editor, tags);
		new Notice("Tags generated and appended");
	} catch (error) {
		console.error("Error generating tags:", error);
		new Notice(error instanceof LLMClientError
			? error.message
			: "Error generating tags. Check the console for details.");
	}
}

export async function generateTags(
	text: string,
	fullNoteText: string,
	settings: OLocalLLMSettings,
	llmClient: OpenAICompatibleClient,
): Promise<string[]> {
	const content = await llmClient.complete({
		model: settings.llmModel,
		messages: buildTagMessages(text, extractExistingTags(fullNoteText)),
		temperature: settings.temperature,
		maxTokens: settings.maxTokens,
	});
	return excludeExistingTags(parseGeneratedTags(content), fullNoteText);
}

export function parseGeneratedTags(content: string): string[] {
	const hashtagPattern = /#[\p{L}\p{N}_][\p{L}\p{M}\p{N}_/-]*/gu;
	const candidates = content.match(hashtagPattern) ?? [];

	const unique = new Map<string, string>();
	for (const tag of candidates) {
		const normalized = tag.startsWith("#") ? tag : `#${tag}`;
		const key = normalized.toLowerCase();
		if (!unique.has(key)) {
			unique.set(key, normalized);
		}
	}
	return Array.from(unique.values()).slice(0, 5);
}

export function excludeExistingTags(tags: string[], noteText: string): string[] {
	const existing = new Set(
		extractExistingTags(noteText).map((tag) => tag.toLowerCase()),
	);
	return tags.filter((tag) => !existing.has(tag.toLowerCase()));
}

export function extractExistingTags(noteText: string): string[] {
	const hashtagPattern = /#[\p{L}\p{N}_][\p{L}\p{M}\p{N}_/-]*/gu;
	return noteText.match(hashtagPattern) ?? [];
}

function appendTags(editor: Editor, tags: string[]) {
	if (tags.length === 0) return;
	const lastLine = editor.lastLine();
	const endOfNote: EditorPosition = { line: lastLine, ch: editor.getLine(lastLine).length };
	editor.replaceRange('\n\n' + tags.join(' '), endOfNote);
}
