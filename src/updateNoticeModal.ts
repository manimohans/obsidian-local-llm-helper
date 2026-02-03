import { App, Modal, MarkdownRenderer, Component, Setting } from "obsidian";

// Changelog entries - add new versions at the top
const CHANGELOGS: { version: string; date: string; changes: string }[] = [
	{
		version: "2.3.1",
		date: "2024-02",
		changes: `
**New Features**
- **Redesigned RAG Chat**: New chat interface with welcome message, example queries, and clickable sources
- **Changelog in Settings**: View version history anytime from Settings → About

**RAG Improvements**
- Smarter chunking with overlap for better context preservation
- Incremental indexing - only re-indexes changed files
- Content preprocessing - strips frontmatter and cleans markdown
- Better error messages when notes aren't indexed

**UI/UX**
- Commands organized with prefixes (Text:, Chat:, Web:, Notes:)
- Ribbon menu grouped logically with separators
- Settings page organized into 7 clear sections
- All prompts improved for better LLM output
- Persona prompts rewritten to be more actionable
`,
	},
	{
		version: "2.3.0",
		date: "2024-01",
		changes: `
**New Features**
- **Edit with Prompt**: Edit selected text with preset or custom prompts
  - 8 presets: fix grammar, make concise, expand, simplify, formal/casual tone, bullet points, improve clarity
  - Custom prompt input for one-off instructions

**Security**
- Fixed dependency vulnerabilities (langchain, axios, form-data, js-yaml)

**Improvements**
- Clearer error messages for embedding failures
`,
	},
	{
		version: "2.2.1",
		date: "2024-01",
		changes: `
**Bug Fixes**
- Fixed re-embedding issue that caused embeddings to regenerate on every restart
- Proper persistent storage for embeddings

**Improvements**
- Storage diagnostics command
- Shows embedding count on startup
`,
	},
	{
		version: "2.2.0",
		date: "2024-01",
		changes: `
**New Features**
- Multi-provider support: Ollama, OpenAI, LM Studio
- Easy provider switching in settings
- Configurable temperature and max tokens

**Improvements**
- Code refactoring with src/ directory structure
`,
	},
];

export class UpdateNoticeModal extends Modal {
	private component: Component;

	constructor(app: App, private version: string) {
		super(app);
		this.component = new Component();
	}

	onOpen() {
		const { contentEl } = this;
		this.component.load();

		contentEl.addClass("llm-update-modal");

		// Header
		contentEl.createEl("h2", { text: `Updated to v${this.version}` });

		// Current version changelog
		const currentChangelog = CHANGELOGS.find(c => c.version === this.version);
		if (currentChangelog) {
			const currentSection = contentEl.createDiv({ cls: "llm-changelog-current" });
			MarkdownRenderer.render(
				this.app,
				currentChangelog.changes,
				currentSection,
				"",
				this.component
			);
		}

		// Previous versions (collapsible)
		const previousVersions = CHANGELOGS.filter(c => c.version !== this.version);
		if (previousVersions.length > 0) {
			const detailsEl = contentEl.createEl("details", { cls: "llm-changelog-previous" });
			detailsEl.createEl("summary", { text: "Previous versions" });

			for (const changelog of previousVersions) {
				const versionSection = detailsEl.createDiv({ cls: "llm-changelog-version" });
				versionSection.createEl("h4", { text: `v${changelog.version}` });
				MarkdownRenderer.render(
					this.app,
					changelog.changes,
					versionSection,
					"",
					this.component
				);
			}
		}

		// Footer with buttons
		const footer = contentEl.createDiv({ cls: "llm-changelog-footer" });

		new Setting(footer)
			.addButton(btn => btn
				.setButtonText("View on GitHub")
				.onClick(() => {
					window.open("https://github.com/manimohans/obsidian-local-llm-helper/releases", "_blank");
				}))
			.addButton(btn => btn
				.setButtonText("Got it")
				.setCta()
				.onClick(() => {
					this.close();
				}));
	}

	onClose() {
		this.component.unload();
		this.contentEl.empty();
	}
}
