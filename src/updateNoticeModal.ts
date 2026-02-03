import { App, Modal, MarkdownRenderer, Component } from "obsidian";

export class UpdateNoticeModal extends Modal {
	constructor(app: App, private version: string) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: `Local LLM Helper updated to v${this.version}` });

		const changelogMd = `
## What's New in v${this.version}

### 🚀 New Features
- **Edit with Prompt**: New command to edit selected text with preset or custom prompts
  - Access via Command Palette or Ribbon Menu
  - 8 preset prompts: fix grammar, make concise, expand, simplify, formal/casual tone, bullet points, improve clarity
  - Custom prompt input for one-off instructions

### 🔒 Security Updates
- Fixed all dependency vulnerabilities (langchain, axios, form-data, js-yaml)
- Updated to TypeScript 5.x

### 🔧 Improvements
- **Better Error Messages**: Clearer error messages when embeddings fail (e.g., wrong model type loaded)

[Full Changelog](https://github.com/manimohans/obsidian-local-llm-helper/releases)
        `;

		const dummyComponent = new Component();
		MarkdownRenderer.render(this.app, changelogMd, contentEl, "", dummyComponent);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
