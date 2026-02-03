import { App, Modal, Setting } from "obsidian";

export interface PromptOption {
	label: string;
	prompt: string;
}

const PRESET_PROMPTS: PromptOption[] = [
	{ label: "Fix grammar & spelling", prompt: "Fix any grammar and spelling mistakes in the following text, keeping the original meaning and tone:" },
	{ label: "Make it concise", prompt: "Make the following text more concise while preserving the key information:" },
	{ label: "Expand with more detail", prompt: "Expand the following text with more detail and explanation:" },
	{ label: "Simplify language", prompt: "Simplify the following text to make it easier to understand:" },
	{ label: "Make it formal", prompt: "Rewrite the following text in a more formal, professional tone:" },
	{ label: "Make it casual", prompt: "Rewrite the following text in a more casual, conversational tone:" },
	{ label: "Convert to bullet points", prompt: "Convert the following text into clear bullet points:" },
	{ label: "Improve clarity", prompt: "Improve the clarity and readability of the following text:" },
];

export class PromptPickerModal extends Modal {
	private onSelect: (prompt: string) => void;
	private customPromptInput: HTMLTextAreaElement;

	constructor(app: App, onSelect: (prompt: string) => void) {
		super(app);
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("prompt-picker-modal");

		contentEl.createEl("h2", { text: "Edit with prompt" });
		contentEl.createEl("p", {
			text: "Choose a preset or write your own instruction:",
			cls: "prompt-picker-description"
		});

		// Preset prompts section
		const presetsContainer = contentEl.createDiv({ cls: "prompt-presets-container" });

		for (const preset of PRESET_PROMPTS) {
			const btn = presetsContainer.createEl("button", {
				text: preset.label,
				cls: "prompt-preset-button"
			});
			btn.addEventListener("click", () => {
				this.close();
				this.onSelect(preset.prompt);
			});
		}

		// Custom prompt section
		contentEl.createEl("h3", { text: "Or write a custom instruction:" });

		this.customPromptInput = contentEl.createEl("textarea", {
			cls: "prompt-custom-input",
			attr: {
				placeholder: "e.g., Translate to Spanish, Add emoji, Convert to haiku...",
				rows: "3"
			}
		});

		// Submit custom prompt button
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText("Apply custom prompt")
				.setCta()
				.onClick(() => {
					const customPrompt = this.customPromptInput.value.trim();
					if (customPrompt) {
						this.close();
						this.onSelect(customPrompt + ":");
					}
				}));

		// Focus the custom input
		this.customPromptInput.focus();

		// Allow Enter+Ctrl/Cmd to submit custom prompt
		this.customPromptInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				const customPrompt = this.customPromptInput.value.trim();
				if (customPrompt) {
					this.close();
					this.onSelect(customPrompt + ":");
				}
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
