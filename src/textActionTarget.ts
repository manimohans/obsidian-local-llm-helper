import type { Editor, EditorPosition, MarkdownView } from "obsidian";

export interface TextActionTarget {
	view: MarkdownView;
	editor: Editor;
	filePath: string;
	from: EditorPosition;
	to: EditorPosition;
	selectedText: string;
}

export function captureTextActionTarget(view: MarkdownView | null): TextActionTarget | null {
	if (!view?.file || view.getMode() !== "source") {
		return null;
	}

	const editor = view.editor;
	return {
		view,
		editor,
		filePath: view.file.path,
		from: { ...editor.getCursor("from") },
		to: { ...editor.getCursor("to") },
		selectedText: editor.getSelection(),
	};
}

export function applyTextActionResult(target: TextActionTarget, text: string): boolean {
	if (
		target.view.file?.path !== target.filePath
		|| target.view.getMode() !== "source"
		|| target.view.editor !== target.editor
		|| target.editor.getRange(target.from, target.to) !== target.selectedText
	) {
		return false;
	}

	target.editor.replaceRange(text, target.from, target.to);
	return true;
}
