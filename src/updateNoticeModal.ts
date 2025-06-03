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
- **OpenAI/LM Studio Support**: Now supports OpenAI-compatible providers alongside Ollama
- **Provider Switching**: Easy switching between Ollama and OpenAI providers in settings
- **Enhanced Configuration**: Temperature and max tokens are now user-configurable

### 🔧 Improvements
- **Code Organization**: Refactored codebase with better file structure (moved to src/)
- **Fixed Tooltip Inconsistency**: Server URL field now has consistent naming
- **Security Update**: Updated axios to fix security vulnerability

### 🤖 Provider Options
- Ollama (default)
- OpenAI 
- LM Studio (local OpenAI-compatible)

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
