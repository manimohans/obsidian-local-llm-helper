import { describe, expect, it, vi } from "vitest";
import type { Editor, MarkdownView } from "obsidian";
import { applyTextActionResult, captureTextActionTarget } from "../src/textActionTarget";

function createTargetFixture() {
	let mode = "source";
	let filePath = "Draft.md";
	let selectedText = "original text";
	let cursorFrom = { line: 2, ch: 3 };
	let cursorTo = { line: 2, ch: 16 };
	const replaceRange = vi.fn();
	const editor = {
		getSelection: () => selectedText,
		getCursor: (which: "from" | "to") => which === "from" ? cursorFrom : cursorTo,
		getRange: () => selectedText,
		replaceRange,
	} as unknown as Editor;
	const file = { path: filePath };
	const view = {
		file,
		editor,
		getMode: () => mode,
	} as unknown as MarkdownView;

	return {
		view,
		replaceRange,
		setMode: (value: string) => { mode = value; },
		setFilePath: (value: string) => {
			filePath = value;
			file.path = value;
		},
		setSelectedText: (value: string) => { selectedText = value; },
		moveCursor: () => {
			cursorFrom = { line: 9, ch: 0 };
			cursorTo = { line: 9, ch: 0 };
		},
	};
}

describe("text action targets", () => {
	it("replaces the exact captured range when its text is unchanged", () => {
		const fixture = createTargetFixture();
		const target = captureTextActionTarget(fixture.view);
		expect(target).not.toBeNull();

		expect(applyTextActionResult(target!, "replacement")).toBe(true);
		expect(fixture.replaceRange).toHaveBeenCalledWith(
			"replacement",
			{ line: 2, ch: 3 },
			{ line: 2, ch: 16 },
		);
	});

	it("does not write when the original range content changes", () => {
		const fixture = createTargetFixture();
		const target = captureTextActionTarget(fixture.view)!;
		fixture.setSelectedText("edited while waiting");

		expect(applyTextActionResult(target, "replacement")).toBe(false);
		expect(fixture.replaceRange).not.toHaveBeenCalled();
	});

	it.each([
		["the view changes files", (fixture: ReturnType<typeof createTargetFixture>) => fixture.setFilePath("Other.md")],
		["the view leaves source mode", (fixture: ReturnType<typeof createTargetFixture>) => fixture.setMode("preview")],
	])("does not write when %s", (_label, mutate) => {
		const fixture = createTargetFixture();
		const target = captureTextActionTarget(fixture.view)!;
		mutate(fixture);

		expect(applyTextActionResult(target, "replacement")).toBe(false);
		expect(fixture.replaceRange).not.toHaveBeenCalled();
	});

	it("still writes to the captured range after the cursor moves", () => {
		const fixture = createTargetFixture();
		const target = captureTextActionTarget(fixture.view)!;
		fixture.moveCursor();

		expect(applyTextActionResult(target, "replacement")).toBe(true);
		expect(fixture.replaceRange).toHaveBeenCalledWith(
			"replacement",
			{ line: 2, ch: 3 },
			{ line: 2, ch: 16 },
		);
	});
});
