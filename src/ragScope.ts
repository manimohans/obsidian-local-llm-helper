import { App, DropdownComponent, TextComponent, TFile } from "obsidian";
import type { RAGQueryScope } from "./rag";

export type ScopeOption = "vault" | "current-note" | "current-folder" | "tag";
export type RAGScopeSelectorOption = ScopeOption | "pinned-paths";

export interface ScopeActiveFile {
	path: string;
	basename: string;
}

interface RAGScopeSelectorOptions {
	initialScope?: RAGQueryScope;
	onChange?: (scope: RAGQueryScope) => void;
}

export function getActiveMarkdownFile(app: App): TFile | null {
	return app.workspace.getActiveFile();
}

export function getFolderPath(file: Pick<TFile, "path">): string {
	const lastSlashIndex = file.path.lastIndexOf("/");
	return lastSlashIndex === -1 ? "" : file.path.slice(0, lastSlashIndex);
}

export function parseScopeTags(rawValue: string): string[] {
	return rawValue
		.split(",")
		.map(part => part.trim())
		.filter(Boolean)
		.map(tag => tag.replace(/^#/, "").toLowerCase());
}

export function getScopeOptionFromScope(scope?: RAGQueryScope): RAGScopeSelectorOption {
	switch (scope?.mode) {
		case "paths":
			return normalizePinnedPathScope(scope) ? "pinned-paths" : "current-note";
		case "folder":
			return "current-folder";
		case "tags":
			return "tag";
		default:
			return "vault";
	}
}

export function describeRAGScope(scope: RAGQueryScope): string {
	switch (scope.mode) {
		case "paths": {
			const paths = uniquePaths(scope.paths);
			if (paths.length === 1) {
				return `note: ${scope.label || paths[0]}`;
			}
			return scope.label ? `notes: ${scope.label}` : `${paths.length} notes`;
		}
		case "folder":
			return `folder: ${scope.label || scope.folder || "Vault root"}`;
		case "tags":
			return `tags: ${(scope.tags || []).map(tag => `#${tag.replace(/^#/, "")}`).join(", ")}`;
		default:
			return "entire vault";
	}
}

export function resolveRAGScope(
	option: RAGScopeSelectorOption,
	activeFile: ScopeActiveFile | null,
	tagDraftValue = "",
	pinnedScope?: RAGQueryScope | null,
): RAGQueryScope {
	switch (option) {
		case "pinned-paths": {
			const normalized = normalizePinnedPathScope(pinnedScope);
			return normalized || { mode: "vault", label: "Entire vault" };
		}
		case "current-note":
			return activeFile
				? { mode: "paths", paths: [activeFile.path], label: activeFile.basename }
				: { mode: "vault", label: "Entire vault" };
		case "current-folder": {
			if (!activeFile) {
				return { mode: "vault", label: "Entire vault" };
			}
			const folder = getFolderPath(activeFile);
			return {
				mode: "folder",
				folder,
				label: folder || "Vault root",
			};
		}
		case "tag": {
			const tags = parseScopeTags(tagDraftValue);
			return tags.length > 0
				? { mode: "tags", tags, label: tags.map(tag => `#${tag}`).join(", ") }
				: { mode: "vault", label: "Entire vault" };
		}
		default:
			return { mode: "vault", label: "Entire vault" };
	}
}

export class RAGScopeSelector {
	private scopeSelect: DropdownComponent;
	private scopeMetaEl: HTMLElement;
	private scopeValueInput: TextComponent | null = null;
	private scopeOption: RAGScopeSelectorOption;
	private scopeDraftValue: string = "";
	private pinnedScope: RAGQueryScope | null;

	constructor(
		private app: App,
		parentEl: HTMLElement,
		private options: RAGScopeSelectorOptions = {},
	) {
		this.pinnedScope = normalizePinnedPathScope(options.initialScope);
		this.scopeOption = getScopeOptionFromScope(options.initialScope);
		if (options.initialScope?.mode === "tags" && options.initialScope.tags?.length) {
			this.scopeDraftValue = options.initialScope.tags.map(tag => `#${tag.replace(/^#/, "")}`).join(", ");
		}

		const scopeLabel = parentEl.createSpan({ text: "Scope", cls: "rag-chat-scope-label" });
		this.scopeSelect = new DropdownComponent(parentEl);
		this.scopeSelect.selectEl.addClass("rag-chat-scope-select");
		if (this.pinnedScope) {
			this.scopeSelect.addOption("pinned-paths", getPinnedOptionLabel(this.pinnedScope));
		}
		this.scopeSelect
			.addOption("vault", "Entire vault")
			.addOption("current-note", "Current note")
			.addOption("current-folder", "Current folder")
			.addOption("tag", "Tag")
			.setValue(this.scopeOption)
			.onChange((value: RAGScopeSelectorOption) => {
				this.scopeOption = value;
				this.renderScopeValueInput();
				this.updateScopeMeta();
				this.options.onChange?.(this.getScope());
			});
		scopeLabel.setAttribute("for", this.scopeSelect.selectEl.id);

		this.scopeMetaEl = parentEl.createDiv({ cls: "rag-chat-scope-meta" });
		this.renderScopeValueInput();
		this.updateScopeMeta();
	}

	getScope(): RAGQueryScope {
		return resolveRAGScope(
			this.scopeOption,
			getActiveMarkdownFile(this.app),
			this.scopeDraftValue,
			this.pinnedScope,
		);
	}

	getScopeOption(): RAGScopeSelectorOption {
		return this.scopeOption;
	}

	getTagDraftValue(): string {
		return this.scopeDraftValue;
	}

	updateScopeMeta() {
		this.scopeMetaEl.querySelectorAll(".rag-chat-scope-hint").forEach(el => el.remove());

		if (this.scopeOption === "tag") {
			const hint = this.scopeMetaEl.createDiv({ cls: "rag-chat-scope-hint" });
			const tags = parseScopeTags(this.scopeDraftValue);
			hint.setText(tags.length > 0
				? `Filtering indexed notes with ${tags.map(tag => `#${tag}`).join(", ")}`
				: "Type one or more tags separated by commas");
			return;
		}

		const hint = this.scopeMetaEl.createDiv({ cls: "rag-chat-scope-hint" });
		hint.setText(describeRAGScope(this.getScope()));
	}

	private renderScopeValueInput() {
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
				this.options.onChange?.(this.getScope());
			});
		this.scopeValueInput.inputEl.addClass("rag-chat-scope-input");
	}
}

function normalizePinnedPathScope(scope?: RAGQueryScope | null): RAGQueryScope | null {
	if (scope?.mode !== "paths") {
		return null;
	}
	const paths = uniquePaths(scope.paths);
	if (paths.length === 0) {
		return null;
	}
	return {
		mode: "paths",
		paths,
		label: scope.label?.trim() || (paths.length === 1 ? paths[0] : `${paths.length} notes`),
	};
}

function uniquePaths(paths?: string[]): string[] {
	return Array.from(new Set(
		(paths || []).map(path => path.trim()).filter(Boolean),
	));
}

function getPinnedOptionLabel(scope: RAGQueryScope): string {
	const paths = uniquePaths(scope.paths);
	const label = scope.label || (paths.length === 1 ? paths[0] : `${paths.length} notes`);
	return paths.length === 1 ? `Pinned note: ${label}` : `Pinned notes: ${label}`;
}
