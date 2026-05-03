import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { RelatedNoteResult } from "./rag";

export const RELATED_NOTES_VIEW_TYPE = "llm-helper-related-notes";

export interface RelatedNotesContext {
	query: string;
	description: string;
	sourcePath?: string;
}

export class RelatedNotesView extends ItemView {
	private plugin: OLocalLLMPlugin;
	private statusEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private contentElRef!: HTMLElement;
	private emptyEl!: HTMLElement;
	private selectedPaths: Set<string> = new Set();
	private currentContext: RelatedNotesContext | null = null;
	private currentResults: RelatedNoteResult[] = [];
	private refreshGeneration = 0;

	constructor(leaf: WorkspaceLeaf, plugin: OLocalLLMPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return RELATED_NOTES_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Related Notes";
	}

	getIcon(): string {
		return "files";
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass("llm-helper-related-notes-view");
		this.renderShell();
		await this.refresh();
	}

	async refresh(context?: RelatedNotesContext | null): Promise<void> {
		const generation = ++this.refreshGeneration;
		const nextContext = context !== undefined
			? context
			: await this.plugin.getRelatedNotesContext();

		if (!this.isLatestRefresh(generation)) {
			return;
		}

		this.currentContext = nextContext;
		this.selectedPaths.clear();
		this.currentResults = [];
		this.renderActions();

		if (!nextContext) {
			this.setStatus("Open a note or select text to surface related notes.");
			this.showEmptyState("No active note context available yet.");
			return;
		}

		if (this.plugin.ragManager.getIndexedFilesCount() === 0) {
			this.setStatus("Index your notes first to use related-note suggestions.");
			this.showEmptyState("No indexed notes found.");
			return;
		}

		this.setStatus(`Finding matches for ${nextContext.description.toLowerCase()}...`);
		this.showEmptyState("Searching...");

		try {
			const results = await this.plugin.ragManager.findRelatedNotes(nextContext.query, {
				excludePaths: nextContext.sourcePath ? [nextContext.sourcePath] : [],
				limit: this.plugin.settings.ragTopK
			});
			if (!this.isLatestRefresh(generation)) {
				return;
			}
			this.currentResults = results;
			this.renderResults();
		} catch (error) {
			if (!this.isLatestRefresh(generation)) {
				return;
			}
			console.error("Related notes refresh failed:", error);
			this.setStatus("Could not load related notes.");
			this.showEmptyState("Search failed. Check the console for details.");
		}
	}

	private renderShell(): void {
		const { contentEl } = this;
		contentEl.empty();

		const headerEl = contentEl.createDiv({ cls: "llm-helper-related-notes-header" });
		const titleWrap = headerEl.createDiv({ cls: "llm-helper-related-notes-title-wrap" });
		const iconEl = titleWrap.createSpan({ cls: "llm-helper-related-notes-icon" });
		setIcon(iconEl, "sparkles");
		const titleText = titleWrap.createDiv({ cls: "llm-helper-related-notes-title-text" });
		titleText.createEl("h2", { text: "Related Notes" });
		this.statusEl = titleText.createDiv({ cls: "llm-helper-related-notes-status" });

		const refreshBtn = headerEl.createEl("button", {
			cls: "clickable-icon llm-helper-related-notes-refresh",
			attr: { "aria-label": "Refresh related notes" }
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			void this.refresh();
		});

		this.actionsEl = contentEl.createDiv({ cls: "llm-helper-related-notes-actions" });
		this.contentElRef = contentEl.createDiv({ cls: "llm-helper-related-notes-results" });
		this.emptyEl = this.contentElRef.createDiv({ cls: "llm-helper-related-notes-empty" });
	}

	private renderResults(): void {
		this.contentElRef.empty();

		if (this.currentResults.length === 0) {
			this.setStatus(`No strong matches found for ${this.currentContext?.description.toLowerCase() || "this context"}.`);
			this.showEmptyState("Try selecting a more specific passage or re-indexing recent notes.");
			return;
		}

		this.setStatus(`Showing ${this.currentResults.length} matches for ${this.currentContext?.description.toLowerCase()}.`);

		for (const result of this.currentResults) {
			const card = this.contentElRef.createDiv({ cls: "llm-helper-related-note-card" });

			const toggle = card.createEl("input", {
				type: "checkbox",
				cls: "llm-helper-related-note-checkbox"
			});
			toggle.addEventListener("change", () => {
				if (toggle.checked) {
					this.selectedPaths.add(result.path);
				} else {
					this.selectedPaths.delete(result.path);
				}
				this.renderActions();
			});

			const body = card.createDiv({ cls: "llm-helper-related-note-body" });

			const titleRow = body.createDiv({ cls: "llm-helper-related-note-title-row" });
			const titleButton = titleRow.createEl("button", {
				text: result.fileName,
				cls: "llm-helper-related-note-open"
			});
			titleButton.addEventListener("click", () => {
				void this.plugin.openFileByPath(result.path);
			});

			titleRow.createSpan({
				text: `${Math.round(result.score * 100)}%`,
				cls: "llm-helper-related-note-score"
			});

			body.createDiv({
				text: result.path,
				cls: "llm-helper-related-note-path"
			});
			body.createDiv({
				text: result.preview,
				cls: "llm-helper-related-note-preview"
			});

			const rowActions = body.createDiv({ cls: "llm-helper-related-note-row-actions" });
			const chatBtn = rowActions.createEl("button", {
				text: "Chat with note",
				cls: "mod-muted"
			});
			chatBtn.addEventListener("click", () => {
				this.plugin.openRAGChat({
					mode: "paths",
					paths: [result.path],
					label: result.fileName
				});
			});
		}

		this.renderActions();
	}

	private renderActions(): void {
		this.actionsEl.empty();

		const helper = this.actionsEl.createDiv({ cls: "llm-helper-related-notes-helper" });
		helper.setText(this.selectedPaths.size > 0
			? `${this.selectedPaths.size} note${this.selectedPaths.size === 1 ? "" : "s"} selected`
			: "Select notes to open a scoped RAG chat");

		const chatSelectedBtn = this.actionsEl.createEl("button", {
			text: "Chat with selected",
			cls: "mod-cta"
		});
		chatSelectedBtn.disabled = this.selectedPaths.size === 0;
		chatSelectedBtn.addEventListener("click", () => {
			if (this.selectedPaths.size === 0) {
				new Notice("Select at least one related note first.");
				return;
			}

			this.plugin.openRAGChat({
				mode: "paths",
				paths: Array.from(this.selectedPaths),
				label: `${this.selectedPaths.size} related notes`
			});
		});
	}

	private setStatus(text: string): void {
		this.statusEl.setText(text);
	}

	private isLatestRefresh(generation: number): boolean {
		return generation === this.refreshGeneration;
	}

	private showEmptyState(text: string): void {
		this.contentElRef.empty();
		this.emptyEl = this.contentElRef.createDiv({ cls: "llm-helper-related-notes-empty" });
		this.emptyEl.setText(text);
	}
}
