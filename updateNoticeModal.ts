import { App, Modal, MarkdownRenderer, Component } from "obsidian";

export class UpdateNoticeModal extends Modal {
    constructor(app: App, private version: string) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: `Local LLM Helper updated to v${this.version}` });
        
        const changelogMd = `
## What's New
- Chat window UX improvements
- Reformat markdown in chat responses
- Hashtag generation for selected text
- Bug fix and performance improvements

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