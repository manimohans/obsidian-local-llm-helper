import { App, ButtonComponent, Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { VaultRadarStoredCard } from "./vaultRadar";

export interface InsightCanvasModalState {
	open: boolean;
	creating: boolean;
}

export class InsightCanvasModal extends Modal {
	private isCreating = false;
	private isOpen = false;

	constructor(
		app: App,
		private readonly plugin: OLocalLLMPlugin,
		private readonly card: VaultRadarStoredCard,
		private readonly onClosed?: () => void,
		private readonly onStateChange?: (state: InsightCanvasModalState) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.isOpen = true;
		this.emitState();
		const { contentEl } = this;
		contentEl.addClass("llm-helper-insight-canvas-modal");

		const header = contentEl.createDiv({ cls: "rag-chat-header" });
		const headerIcon = header.createSpan({ cls: "rag-chat-header-icon" });
		setIcon(headerIcon, "map");
		const headerText = header.createDiv({ cls: "rag-chat-header-text" });
		headerText.createEl("h2", { text: "Map this insight" });
		headerText.createEl("span", {
			text: "Create an editable Obsidian Canvas from this card and its cited notes.",
			cls: "rag-chat-subtitle",
		});

		const summary = contentEl.createDiv({ cls: "llm-helper-insight-canvas-summary" });
		summary.createEl("h3", { text: this.card.title });
		summary.createEl("p", { text: this.card.insight });

		const citedSourcePaths = Array.from(new Set(
			this.card.sourcePaths.filter((path) => path.trim().length > 0),
		));
		const availableSourceCount = citedSourcePaths.filter((path) => (
			this.app.vault.getAbstractFileByPath(path) instanceof TFile
		)).length;
		const missingSourceCount = citedSourcePaths.length - availableSourceCount;

		new Setting(contentEl)
			.setName("Destination")
			.setDesc("A new file in the Vault Radar Maps folder. Existing files are never overwritten.");
		new Setting(contentEl)
			.setName("Evidence")
			.setDesc(
				missingSourceCount > 0
					? `${availableSourceCount} available; ${missingSourceCount} missing source${missingSourceCount === 1 ? "" : "s"} will be skipped`
					: `${availableSourceCount} cited source${availableSourceCount === 1 ? "" : "s"}`,
			);

		contentEl.createEl("p", {
			text: "This creates one local .canvas file. Source notes are unchanged, and the plugin makes no additional model or API request. Obsidian may load external embeds when it renders cited notes.",
			cls: "setting-item-description",
		});

		const errorEl = contentEl.createDiv({
			cls: "llm-helper-insight-canvas-error",
			attr: { role: "alert", "aria-live": "polite" },
		});
		const actions = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelButton = new ButtonComponent(actions)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		const createButton = new ButtonComponent(actions)
			.setButtonText("Create and open")
			.setCta()
			.onClick(() => void this.createCanvas(createButton, cancelButton, errorEl));
		if (availableSourceCount === 0) {
			createButton.setDisabled(true);
			errorEl.setText("None of this insight's cited notes are available. Run Vault Radar again to refresh its sources.");
			cancelButton.buttonEl.focus();
		} else {
			createButton.buttonEl.focus();
		}
	}

	onClose(): void {
		this.isOpen = false;
		this.emitState();
		this.contentEl.empty();
		this.onClosed?.();
	}

	private async createCanvas(
		createButton: ButtonComponent,
		cancelButton: ButtonComponent,
		errorEl: HTMLElement,
	): Promise<void> {
		if (this.isCreating) {
			return;
		}
		this.isCreating = true;
		this.emitState();
		errorEl.empty();
		createButton.setDisabled(true).setButtonText("Creating…");
		cancelButton.setDisabled(true);

		try {
			await this.plugin.createInsightCanvas(this.card);
			this.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not create the canvas.";
			if (this.isOpen) {
				errorEl.setText(message);
				createButton.setDisabled(false).setButtonText("Create and open");
				cancelButton.setDisabled(false);
			} else {
				new Notice(message);
			}
		} finally {
			this.isCreating = false;
			this.emitState();
		}
	}

	private emitState(): void {
		this.onStateChange?.({
			open: this.isOpen,
			creating: this.isCreating,
		});
	}
}
