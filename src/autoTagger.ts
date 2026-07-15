import { App, Editor, EditorPosition, MarkdownView, Notice } from "obsidian";
import type { OLocalLLMSettings } from "../main";
import { LLMClientError, OpenAICompatibleClient } from "./llmClient";

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
		const tags = await generateTags(textToProcess, settings, llmClient);
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

async function generateTags(
	text: string,
	settings: OLocalLLMSettings,
	llmClient: OpenAICompatibleClient,
): Promise<string[]> {
	const prompt = "Generate 3-5 relevant hashtags for the following text. Return only hashtags starting with #, separated by spaces. No explanations:";

	const content = await llmClient.complete({
		model: settings.llmModel,
		messages: [
			{ role: "system", content: "You are a helpful assistant that generates relevant hashtags." },
			{ role: "user", content: `${prompt}\n\n${text}` }
		],
		temperature: settings.temperature,
		maxTokens: settings.maxTokens,
	});
	const generatedTags = content.trim().split(/\s+/);
	// Obsidian tags allow letters (incl. unicode), digits, -, _, and / for nesting
	return generatedTags
		.filter((tag: string) => /^#?[\p{L}\p{N}_][\p{L}\p{N}_/-]*$/u.test(tag))
		.map((tag: string) => tag.startsWith('#') ? tag : `#${tag}`)
		.slice(0, 5);
}

function appendTags(editor: Editor, tags: string[]) {
	if (tags.length === 0) return;
	const lastLine = editor.lastLine();
	const endOfNote: EditorPosition = { line: lastLine, ch: editor.getLine(lastLine).length };
	editor.replaceRange('\n\n' + tags.join(' '), endOfNote);
}
