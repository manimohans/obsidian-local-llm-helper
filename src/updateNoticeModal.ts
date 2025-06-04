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

### 🔧 Major Bug Fixes
- **Fixed Re-embedding Issue**: Embeddings no longer re-generate on every app restart
- **Proper Persistent Storage**: Embeddings now persist correctly across Obsidian restarts
- **Data Separation**: Plugin settings and embeddings are now stored separately to prevent conflicts

### 🚀 New Features
- **Storage Diagnostics**: New command and settings button to check embedding storage status
- **User Notifications**: Shows embedding count and storage info on startup
- **Enhanced Logging**: Comprehensive console logging with emojis for better debugging

### 🔧 Improvements
- **Better Error Handling**: Improved Ollama API integration with proper error messages
- **Default Settings**: Updated to use Ollama port 11434 and mxbai-embed-large model
- **Settings UI**: Indexed file count now updates properly in settings panel

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
