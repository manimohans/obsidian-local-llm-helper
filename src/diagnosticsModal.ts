import { App, Modal, Setting } from "obsidian";

/** Explicit diagnostics stay visible in the app rather than filling the console. */
export class DiagnosticsModal extends Modal {
	constructor(app: App, private rows: [string, string][]) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: "Index diagnostics" });
		for (const [name, value] of this.rows) {
			new Setting(this.contentEl).setName(name).setDesc(value);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
