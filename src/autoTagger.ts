import { App, Editor, EditorPosition, MarkdownView, Notice, requestUrl } from "obsidian";
import { OLocalLLMSettings } from "../main";

export async function generateAndAppendTags(app: App, settings: OLocalLLMSettings) {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		new Notice("No active Markdown view");
		return;
	}

	const editor = view.editor;
	const selectedText = editor.getSelection();
	const fullText = editor.getValue();
	const cursorPosition = editor.getCursor();

	const textToProcess = selectedText || fullText;

	try {
		const tags = await generateTags(textToProcess, settings);
		appendTags(editor, tags, cursorPosition);
		new Notice("Tags generated and appended");
	} catch (error) {
		console.error("Error generating tags:", error);
		new Notice("Error generating tags. Check the console for details.");
	}
}

async function generateTags(text: string, settings: OLocalLLMSettings): Promise<string[]> {
	const prompt = "Generate 1-5 hashtags for the following text. Return only the hashtags, separated by spaces:";

	const body = {
		model: settings.llmModel,
		messages: [
			{ role: "system", content: "You are a helpful assistant that generates relevant hashtags." },
			{ role: "user", content: `${prompt}\n\n${text}` }
		],
		temperature: settings.temperature,
		max_tokens: settings.maxTokens
	};

	const response = await requestUrl({
		url: `${settings.serverAddress}/v1/chat/completions`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});

	if (response.status !== 200) {
		throw new Error(`Error from LLM server: ${response.status} ${response.text}`);
	}

	const data = await response.json;
	const generatedTags = data.choices[0].message.content.trim().split(/\s+/);
	return generatedTags
		.filter((tag: string) => /^#?[a-zA-Z0-9]+$/.test(tag))
		.map((tag: string) => tag.startsWith('#') ? tag : `#${tag}`)
		.slice(0, 5);
}

function appendTags(editor: Editor, tags: string[], cursorPosition: EditorPosition) {
	const tagsString = '\n\n' + tags.join(' ');
	editor.replaceRange(tagsString, cursorPosition);
}
