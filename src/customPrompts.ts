import { App, FuzzySuggestModal } from "obsidian";

export interface CustomPrompt {
	id: string;
	title: string;
	prompt: string;
	systemPrompt?: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * Generates a safe, unique command ID from a prompt title.
 * e.g. "My Cool Prompt" → "custom-prompt-my-cool-prompt-abc123"
 * The seed (the prompt's createdAt) keeps the ID unique across prompts with
 * identical titles and stable for the lifetime of the prompt.
 */
export function generatePromptId(title: string, seed: number): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "untitled";
	return `custom-prompt-${slug}-${seed.toString(36)}`;
}

/**
 * Fuzzy-searchable modal for selecting a saved custom prompt.
 */
export class SelectPromptModal extends FuzzySuggestModal<CustomPrompt> {
	private prompts: CustomPrompt[];
	private onChoose: (prompt: CustomPrompt) => void;

	constructor(app: App, prompts: CustomPrompt[], onChoose: (prompt: CustomPrompt) => void) {
		super(app);
		this.prompts = prompts;
		this.onChoose = onChoose;
		this.setPlaceholder("Search saved prompts...");
	}

	getItems(): CustomPrompt[] {
		return this.prompts;
	}

	getItemText(item: CustomPrompt): string {
		return item.title;
	}

	onChooseItem(item: CustomPrompt): void {
		this.onChoose(item);
	}
}
