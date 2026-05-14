import { App, ButtonComponent, Modal, Notice, DropdownComponent, TextComponent, setIcon } from "obsidian";
import type OLocalLLMPlugin from "../main";
import { getCurrentOrFallbackChatContext } from "./vaultAgent";
import { RAGScopeSelector, describeRAGScope } from "./ragScope";
import type { WorkflowRecipeId } from "./workflowTypes";
import { WORKFLOW_RECIPES, type WorkflowRunConfig } from "./workflowRunner";
import type { RAGQueryScope } from "./rag";

export class WorkflowModal extends Modal {
	private recipeId: WorkflowRecipeId = "weekly-review";
	private scopeSelector: RAGScopeSelector;
	private scopeBarEl: HTMLElement;
	private chatHistoryEl: HTMLElement;
	private submitButton: ButtonComponent;
	private recipeSelect: DropdownComponent;
	private targetNoteInput: TextComponent | null = null;
	private outputFolderInput: TextComponent | null = null;
	private titleTemplateInput: TextComponent | null = null;
	private dynamicFieldsEl: HTMLElement;
	private welcomeEl: HTMLElement | null = null;
	private recipeHintEl: HTMLElement;

	constructor(app: App, private plugin: OLocalLLMPlugin) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("rag-chat-modal", "workflow-runner-modal");

		const header = contentEl.createDiv({ cls: "rag-chat-header" });
		const headerIcon = header.createSpan({ cls: "rag-chat-header-icon" });
		setIcon(headerIcon, "workflow");
		const headerText = header.createDiv({ cls: "rag-chat-header-text" });
		headerText.createEl("h2", { text: "Run workflow" });
		headerText.createEl("span", {
			text: "Draft a review workflow, then approve each note write manually.",
			cls: "rag-chat-subtitle",
		});

		const recipeBar = contentEl.createDiv({ cls: "workflow-runner-bar" });
		recipeBar.createSpan({ text: "Recipe", cls: "rag-chat-scope-label" });
		this.recipeSelect = new DropdownComponent(recipeBar);
		this.recipeSelect.selectEl.addClass("rag-chat-scope-select");
		for (const recipe of WORKFLOW_RECIPES) {
			this.recipeSelect.addOption(recipe.id, recipe.title);
		}
		this.recipeSelect.setValue(this.recipeId).onChange((value: WorkflowRecipeId) => {
			this.recipeId = value;
			this.recipeHintEl.setText(this.plugin.workflowRunner.getRecipe(value).description);
			this.renderScopeSelector();
			this.renderDynamicFields();
			this.updateSubmitButtonState();
			void this.persistDefaults();
		});
		const recipeHint = recipeBar.createDiv({ cls: "rag-chat-scope-meta" });
		this.recipeHintEl = recipeHint.createDiv({
			text: WORKFLOW_RECIPES.find(recipe => recipe.id === this.recipeId)?.description || "",
			cls: "rag-chat-scope-hint",
		});

		this.scopeBarEl = contentEl.createDiv({ cls: "rag-chat-scope-bar" });
		this.renderScopeSelector();

		this.dynamicFieldsEl = contentEl.createDiv({ cls: "workflow-runner-fields" });
		this.renderDynamicFields();

		const chatContainer = contentEl.createDiv({ cls: "rag-chat-container" });
		this.chatHistoryEl = chatContainer.createDiv({ cls: "rag-chat-history" });
		this.showWelcomeMessage();

		const inputContainer = contentEl.createDiv({ cls: "rag-chat-input-container" });
		const inputRow = inputContainer.createDiv({ cls: "rag-chat-input-row" });

		const clearBtn = new ButtonComponent(inputRow)
			.setIcon("trash-2")
			.setTooltip("Clear results")
			.onClick(() => this.clearConversation());
		clearBtn.buttonEl.addClass("rag-chat-clear-btn");

		this.submitButton = new ButtonComponent(inputRow)
			.setButtonText("Run workflow")
			.setCta()
			.onClick(() => void this.handleSubmit());
		this.submitButton.buttonEl.addClass("rag-chat-submit-btn");

		this.updateSubmitButtonState();
	}

	private showWelcomeMessage() {
		this.welcomeEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-welcome" });
		const welcomeContent = this.welcomeEl.createDiv({ cls: "rag-chat-welcome-content" });
		welcomeContent.createEl("p", {
			text: "Choose a review workflow, confirm the note scope, and draft one or more approval-ready note changes.",
		});
		const examples = welcomeContent.createDiv({ cls: "rag-chat-examples" });
		examples.createEl("span", { text: "Included recipes", cls: "rag-chat-examples-label" });
		for (const recipe of WORKFLOW_RECIPES) {
			examples.createEl("button", {
				text: recipe.title,
				cls: "rag-chat-example-btn",
			}).addEventListener("click", () => {
				this.recipeId = recipe.id;
				this.recipeSelect.setValue(recipe.id);
				this.recipeHintEl.setText(recipe.description);
				this.renderScopeSelector();
				this.renderDynamicFields();
				this.updateSubmitButtonState();
			});
		}
	}

	private hideWelcomeMessage() {
		if (this.welcomeEl) {
			this.welcomeEl.remove();
			this.welcomeEl = null;
		}
	}

	private renderDynamicFields() {
		this.dynamicFieldsEl.empty();
		this.targetNoteInput = null;
		this.outputFolderInput = null;
		this.titleTemplateInput = null;

		const defaults = this.plugin.workflowRunner.getDefaults(this.recipeId);
		const recipe = this.plugin.workflowRunner.getRecipe(this.recipeId);
		const helper = this.dynamicFieldsEl.createDiv({ cls: "rag-chat-scope-hint workflow-runner-helper" });
		helper.setText(recipe.description);

		if (recipe.targetType === "create-note") {
			const outputRow = this.dynamicFieldsEl.createDiv({ cls: "workflow-runner-field-row" });
			outputRow.createSpan({ text: "Output folder", cls: "rag-chat-scope-label" });
			this.outputFolderInput = new TextComponent(outputRow)
				.setPlaceholder("Reviews")
				.setValue(defaults.outputFolder || "")
				.onChange(() => {
					this.updateSubmitButtonState();
					void this.persistDefaults();
				});
			this.outputFolderInput.inputEl.addClass("rag-chat-scope-input");

			const titleRow = this.dynamicFieldsEl.createDiv({ cls: "workflow-runner-field-row" });
			titleRow.createSpan({ text: "Title template", cls: "rag-chat-scope-label" });
			this.titleTemplateInput = new TextComponent(titleRow)
				.setPlaceholder("Weekly Review - YYYY-MM-DD")
				.setValue(defaults.titleTemplate || "Weekly Review - YYYY-MM-DD")
				.onChange(() => {
					this.updateSubmitButtonState();
					void this.persistDefaults();
				});
			this.titleTemplateInput.inputEl.addClass("rag-chat-scope-input");
		} else {
			const targetRow = this.dynamicFieldsEl.createDiv({ cls: "workflow-runner-field-row" });
			targetRow.createSpan({ text: "Target note", cls: "rag-chat-scope-label" });
			this.targetNoteInput = new TextComponent(targetRow)
				.setPlaceholder("Projects/Current Project.md")
				.setValue(defaults.targetNote || "")
				.onChange(() => {
					this.updateSubmitButtonState();
					void this.persistDefaults();
				});
			this.targetNoteInput.inputEl.addClass("rag-chat-scope-input");
		}
	}

	private renderScopeSelector() {
		this.scopeBarEl.empty();
		this.scopeSelector = new RAGScopeSelector(this.app, this.scopeBarEl, {
			initialScope: this.getInitialScope(),
			onChange: () => {
				this.updateSubmitButtonState();
				void this.persistDefaults();
			},
		});
	}

	private getInitialScope(): RAGQueryScope {
		const defaults = this.plugin.workflowRunner.getDefaults(this.recipeId);
		switch (defaults.scopeOption) {
			case "current-note":
				return { mode: "paths", paths: [] as string[], label: "Current note" };
			case "current-folder":
				return { mode: "folder", folder: "", label: "Current folder" };
			case "tag": {
				const tags = defaults.tagValue
					.split(",")
					.map(tag => tag.trim())
					.filter(Boolean)
					.map(tag => tag.replace(/^#/, "").toLowerCase());
				return tags.length > 0
					? { mode: "tags", tags, label: tags.map(tag => `#${tag}`).join(", ") }
					: { mode: "vault", label: "Entire vault" };
			}
			default:
				return { mode: "vault", label: "Entire vault" };
		}
	}

	private buildRunConfig(): WorkflowRunConfig {
		return {
			recipeId: this.recipeId,
			scope: this.scopeSelector.getScope(),
			targetNote: this.targetNoteInput?.getValue().trim(),
			outputFolder: this.outputFolderInput?.getValue().trim(),
			titleTemplate: this.titleTemplateInput?.getValue().trim(),
		};
	}

	private async handleSubmit() {
		if (!this.canSubmit()) {
			new Notice("Choose a target note before running this workflow.");
			return;
		}

		this.hideWelcomeMessage();
		await this.persistDefaults();

		const config = this.buildRunConfig();
		const recipe = this.plugin.workflowRunner.getRecipe(config.recipeId);
		const scopeLabel = describeRAGScope(config.scope);

		const userMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-user" });
		userMsg.createSpan({ text: `${recipe.title} on ${scopeLabel}` });

		const thinkingEl = this.chatHistoryEl.createDiv({ cls: "rag-chat-thinking" });
		thinkingEl.createSpan({ text: `Drafting ${recipe.title.toLowerCase()} from ${scopeLabel}` });
		this.appendThinkingDots(thinkingEl);
		this.scrollToBottom();
		new Notice(`Running workflow: ${recipe.title}`);

		try {
			const contextSnapshot = getCurrentOrFallbackChatContext(this.app);
			const response = await this.plugin.workflowRunner.runWorkflow(config, contextSnapshot);
			thinkingEl.remove();
			this.plugin.vaultAgent.renderAgentResponse(
				this.chatHistoryEl,
				response,
				contextSnapshot,
				{
					messageClassName: "rag-chat-message rag-chat-message-ai",
					responseTextClassName: "rag-chat-response-text",
					copyButtonClassName: "rag-chat-copy-btn",
					badgeText: `${recipe.title} • ${scopeLabel}`,
					scrollToBottom: () => this.scrollToBottom(),
				},
			);
			new Notice(response.actions.length > 0
				? `${recipe.title} ready for approval.`
				: `${recipe.title} finished with no writable actions.`);
			this.scrollToBottom();
		} catch (error) {
			thinkingEl.remove();
			const errorMsg = this.chatHistoryEl.createDiv({ cls: "rag-chat-message rag-chat-message-error" });
			errorMsg.createSpan({
				text: error instanceof Error ? error.message : "Workflow failed.",
			});
			console.error("Workflow failed:", error);
			new Notice(error instanceof Error ? error.message : "Workflow failed.");
			this.scrollToBottom();
		}
	}

	private async persistDefaults() {
		const defaults = this.plugin.settings.workflowDefaults.recipes[this.recipeId];
		defaults.scopeOption = this.scopeSelector.getScopeOption();
		defaults.tagValue = this.scopeSelector.getTagDraftValue();
		defaults.targetNote = this.targetNoteInput?.getValue().trim() || "";
		defaults.outputFolder = this.outputFolderInput?.getValue().trim() || "";
		defaults.titleTemplate = this.titleTemplateInput?.getValue().trim() || defaults.titleTemplate;
		await this.plugin.saveSettings();
	}

	private canSubmit(): boolean {
		const recipe = this.plugin.workflowRunner.getRecipe(this.recipeId);
		if (recipe.targetType === "append-note") {
			return Boolean(this.targetNoteInput?.getValue().trim());
		}
		return Boolean(this.titleTemplateInput?.getValue().trim() || "Weekly Review - YYYY-MM-DD");
	}

	private updateSubmitButtonState() {
		const disabled = !this.canSubmit();
		this.submitButton.setDisabled(disabled);
		if (disabled) {
			this.submitButton.buttonEl.addClass("rag-chat-submit-disabled");
		} else {
			this.submitButton.buttonEl.removeClass("rag-chat-submit-disabled");
		}
	}

	private clearConversation() {
		this.chatHistoryEl.empty();
		this.showWelcomeMessage();
	}

	private scrollToBottom() {
		this.chatHistoryEl.scrollTop = this.chatHistoryEl.scrollHeight;
	}

	private appendThinkingDots(containerEl: HTMLElement) {
		const dots = containerEl.createSpan({ cls: "dots" });
		dots.createSpan({ cls: "dot" });
		dots.createSpan({ cls: "dot" });
		dots.createSpan({ cls: "dot" });
	}

	onClose() {
		this.contentEl.empty();
	}
}
