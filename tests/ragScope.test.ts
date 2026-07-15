import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	DropdownComponent: class {},
	TextComponent: class {},
	TFile: class {},
}));

import {
	describeRAGScope,
	getScopeOptionFromScope,
	resolveRAGScope,
} from "../src/ragScope";
import type { RAGQueryScope } from "../src/rag";

describe("RAG scope handoff", () => {
	it("keeps an explicit multi-note scope pinned when the active note changes", () => {
		const pinned: RAGQueryScope = {
			mode: "paths",
			paths: ["Projects/Launch.md", "Meetings/Decision.md"],
			label: "2 Radar sources",
		};

		expect(getScopeOptionFromScope(pinned)).toBe("pinned-paths");
		expect(resolveRAGScope(
			"pinned-paths",
			{ path: "Daily/Today.md", basename: "Today" },
			"",
			pinned,
		)).toEqual(pinned);
	});

	it("keeps a single explicit note pinned instead of substituting the active note", () => {
		const pinned: RAGQueryScope = {
			mode: "paths",
			paths: ["Projects/Launch.md"],
			label: "Launch",
		};

		expect(resolveRAGScope(
			"pinned-paths",
			{ path: "Daily/Today.md", basename: "Today" },
			"",
			pinned,
		)).toEqual(pinned);
		expect(describeRAGScope(pinned)).toBe("note: Launch");
	});

	it("treats an empty path sentinel as the dynamic current-note option", () => {
		expect(getScopeOptionFromScope({
			mode: "paths",
			paths: [],
			label: "Current note",
		})).toBe("current-note");
		expect(resolveRAGScope(
			"current-note",
			{ path: "Daily/Today.md", basename: "Today" },
		)).toEqual({
			mode: "paths",
			paths: ["Daily/Today.md"],
			label: "Today",
		});
	});

	it("still resolves vault, folder, and tag choices after a pinned handoff", () => {
		const activeFile = { path: "Projects/Launch/Plan.md", basename: "Plan" };
		const pinned: RAGQueryScope = {
			mode: "paths",
			paths: ["Other.md"],
			label: "Other",
		};

		expect(resolveRAGScope("vault", activeFile, "", pinned))
			.toEqual({ mode: "vault", label: "Entire vault" });
		expect(resolveRAGScope("current-folder", activeFile, "", pinned))
			.toEqual({ mode: "folder", folder: "Projects/Launch", label: "Projects/Launch" });
		expect(resolveRAGScope("tag", activeFile, "#Project, meeting", pinned))
			.toEqual({ mode: "tags", tags: ["project", "meeting"], label: "#project, #meeting" });
	});

	it("describes multi-note scopes without calling them the current note", () => {
		expect(describeRAGScope({
			mode: "paths",
			paths: ["A.md", "B.md"],
			label: "2 related notes",
		})).toBe("notes: 2 related notes");
	});
});
