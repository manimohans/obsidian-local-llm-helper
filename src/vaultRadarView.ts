import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type {
	VaultRadarCardAction,
	VaultRadarInsightKind,
	VaultRadarStoredCard,
} from "./vaultRadar";

export const VAULT_RADAR_VIEW_TYPE = "llm-helper-vault-radar";

export interface VaultRadarViewOpenOptions {
	runNow?: boolean;
	focusRunButton?: boolean;
}

const KIND_LABELS: Record<VaultRadarInsightKind, string> = {
	commitment: "Commitment",
	stalled_project: "Stalled project",
	connection: "Connection",
	next_action: "Next action",
};

export class VaultRadarView extends ItemView {
	private readonly plugin: OLocalLLMPlugin;
	private statusEl!: HTMLElement;
	private helperEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private runButton!: HTMLButtonElement;
	private shellMounted = false;
	private pendingOptions: VaultRadarViewOpenOptions | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: OLocalLLMPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VAULT_RADAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Vault Radar";
	}

	getIcon(): string {
		return "radar";
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass("llm-helper-radar-view");
		this.contentEl.addClass("llm-helper-radar-content");
		this.renderShell();
		this.shellMounted = true;
		this.refresh();
		if (this.pendingOptions) {
			const options = this.pendingOptions;
			this.pendingOptions = null;
			this.applyOpenOptions(options);
		}
	}

	onClose(): Promise<void> {
		this.shellMounted = false;
		return Promise.resolve();
	}

	applyOpenOptions(options: VaultRadarViewOpenOptions): void {
		if (!this.shellMounted) {
			this.pendingOptions = options;
			return;
		}
		if (options.focusRunButton) {
			this.runButton.focus();
		}
		if (options.runNow) {
			void this.plugin.runVaultRadar("manual");
		}
	}

	refresh(): void {
		if (!this.shellMounted) {
			return;
		}
		const snapshot = this.plugin.getVaultRadarSnapshot();
		this.contentEl.toggleClass("is-running", snapshot.isRunning);
		this.runButton.disabled = snapshot.isRunning;
		this.runButton.setText(snapshot.isRunning ? "Scanning…" : "Run now");
		this.statusEl.setText(this.buildStatusText(snapshot.state.lastSuccessfulRunAt, snapshot.isRunning));
		this.helperEl.setText(
			this.plugin.settings.vaultRadarAutoRun
				? "Automatic daily brief is on. Uses your configured chat server."
				: "Automatic runs are off. Run manually whenever you want a fresh brief.",
		);

		this.resultsEl.empty();
		if (snapshot.error) {
			this.resultsEl.createDiv({
				text: snapshot.error,
				cls: "llm-helper-radar-error",
				attr: { role: "alert" },
			});
		}

		if (snapshot.cards.length === 0) {
			const empty = this.resultsEl.createDiv({ cls: "llm-helper-radar-empty" });
			if (snapshot.state.lastSuccessfulRunAt) {
				empty.createDiv({ text: snapshot.message || "No active insights right now." });
				empty.createEl("small", {
					text: "Changed notes will be considered on the next run; snoozed insights return automatically.",
				});
			} else {
				empty.createDiv({ text: "Turn recent note changes into a cited, actionable brief." });
				empty.createEl("small", {
					text: "Run now sends bounded excerpts from recent Markdown notes to your configured chat server. It never edits notes.",
				});
			}
			return;
		}

		if (snapshot.message) {
			this.resultsEl.createDiv({
				text: snapshot.message,
				cls: "llm-helper-radar-helper",
			});
		}
		for (const card of snapshot.cards) {
			this.renderCard(card, snapshot.isRunning);
		}
	}

	private renderShell(): void {
		this.contentEl.empty();
		const header = this.contentEl.createDiv({ cls: "llm-helper-radar-header" });
		const titleWrap = header.createDiv({ cls: "llm-helper-radar-title-wrap" });
		const icon = titleWrap.createSpan({ cls: "llm-helper-radar-icon" });
		setIcon(icon, "radar");
		const title = titleWrap.createDiv({ cls: "llm-helper-radar-title" });
		title.createEl("h2", { text: "Vault Radar" });
		this.statusEl = title.createDiv({
			cls: "llm-helper-radar-status",
			attr: { role: "status", "aria-live": "polite" },
		});

		this.runButton = header.createEl("button", {
			text: "Run now",
			cls: "mod-cta llm-helper-radar-run",
			attr: { type: "button" },
		});
		this.runButton.addEventListener("click", () => {
			void this.plugin.runVaultRadar("manual");
		});

		const toolbar = this.contentEl.createDiv({ cls: "llm-helper-radar-toolbar" });
		this.helperEl = toolbar.createDiv({ cls: "llm-helper-radar-helper" });

		this.resultsEl = this.contentEl.createDiv({
			cls: "llm-helper-radar-results",
			attr: { tabindex: "-1" },
		});
	}

	private renderCard(card: VaultRadarStoredCard, disabled: boolean): void {
		const cardEl = this.resultsEl.createEl("article", {
			cls: "llm-helper-radar-card",
			attr: { "data-card-id": card.id },
		});
		const heading = cardEl.createDiv({ cls: "llm-helper-radar-card-heading" });
		const headingText = heading.createDiv();
		headingText.createSpan({ text: KIND_LABELS[card.kind], cls: "llm-helper-radar-type" });
		headingText.createEl("h3", { text: card.title });
		heading.createSpan({
			text: `${card.confidence} confidence`,
			cls: "llm-helper-radar-confidence",
		});

		cardEl.createDiv({ text: card.insight, cls: "llm-helper-radar-card-body" });
		if (card.action) {
			const action = cardEl.createDiv({ cls: "llm-helper-radar-next-action" });
			action.createEl("strong", { text: "Best next action" });
			action.createSpan({ text: card.action });
		}

		cardEl.createDiv({ text: "Sources", cls: "llm-helper-radar-card-meta" });
		const sources = cardEl.createDiv({ cls: "llm-helper-radar-sources" });
		for (const path of card.sourcePaths) {
			const source = sources.createEl("button", {
				text: this.sourceLabel(path),
				cls: "mod-muted llm-helper-radar-source",
				attr: { type: "button", title: path },
			});
			source.disabled = disabled;
			source.addEventListener("click", () => {
				void this.plugin.openFileByPath(path);
			});
		}

		const feedback = cardEl.createDiv({ cls: "llm-helper-radar-feedback" });
		const chat = feedback.createEl("button", {
			text: "Chat with sources",
			cls: "mod-muted",
			attr: { type: "button" },
		});
		chat.disabled = disabled;
		chat.addEventListener("click", () => {
			this.plugin.openRAGChat({
				mode: "paths",
				paths: card.sourcePaths,
				label: `${card.sourcePaths.length} Radar source${card.sourcePaths.length === 1 ? "" : "s"}`,
			});
		});

		this.addFeedbackButton(feedback, card, "Helpful", "helpful", disabled);
		this.addFeedbackButton(feedback, card, "Wrong", "wrong", disabled);
		this.addCardActionButton(feedback, card.id, "Snooze 7d", disabled, () => ({
			type: "snooze",
			until: Date.now() + 7 * 24 * 60 * 60 * 1000,
		}), "Insight snoozed for seven days.");
		this.addCardActionButton(feedback, card.id, "Dismiss", disabled, () => ({
			type: "dismiss",
			at: Date.now(),
		}), "Insight dismissed.");
	}

	private addFeedbackButton(
		container: HTMLElement,
		card: VaultRadarStoredCard,
		label: string,
		value: "helpful" | "wrong",
		disabled: boolean,
	): void {
		const button = container.createEl("button", {
			text: label,
			cls: "mod-muted",
			attr: {
				type: "button",
				"aria-pressed": String(card.feedback === value),
			},
		});
		button.disabled = disabled;
		button.addEventListener("click", () => {
			void this.plugin.recordVaultRadarCardAction(card.id, {
				type: "feedback",
				value,
			});
		});
	}

	private addCardActionButton(
		container: HTMLElement,
		cardId: string,
		label: string,
		disabled: boolean,
		createAction: () => VaultRadarCardAction,
		notice: string,
	): void {
		const button = container.createEl("button", {
			text: label,
			cls: "mod-muted",
			attr: { type: "button" },
		});
		button.disabled = disabled;
		button.addEventListener("click", () => {
			button.disabled = true;
			void this.plugin.recordVaultRadarCardAction(cardId, createAction()).then((saved) => {
				if (saved) {
					new Notice(notice);
					this.resultsEl.focus();
				} else {
					button.disabled = false;
				}
			});
		});
	}

	private buildStatusText(lastSuccessfulRunAt: number | undefined, isRunning: boolean): string {
		if (isRunning) {
			return "Reading changed notes and looking for grounded signals…";
		}
		if (!lastSuccessfulRunAt) {
			return "Your cited brief from recent note changes";
		}
		return `Last checked ${this.formatRelativeTime(lastSuccessfulRunAt)}`;
	}

	private formatRelativeTime(timestamp: number): string {
		const elapsed = Math.max(0, Date.now() - timestamp);
		const minutes = Math.floor(elapsed / 60_000);
		if (minutes < 1) {
			return "just now";
		}
		if (minutes < 60) {
			return `${minutes}m ago`;
		}
		const hours = Math.floor(minutes / 60);
		if (hours < 24) {
			return `${hours}h ago`;
		}
		return `${Math.floor(hours / 24)}d ago`;
	}

	private sourceLabel(path: string): string {
		const name = path.split("/").pop() || path;
		return name.replace(/\.md$/i, "");
	}
}
