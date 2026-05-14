import { App, requestUrl } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { AgentResponse, ChatEnvironmentContext, AgentAction } from "./vaultAgent";
import { extractActualResponse, parseReasoningMarkers } from "./reasoningExtractor";
import type { RAGQueryScope } from "./rag";
import type { WorkflowDefaults, WorkflowRecipeDefaults, WorkflowRecipeId } from "./workflowTypes";
import { buildOpenAIHeaders, getChatApiKey, getChatCompletionsUrl } from "./providerSettings";

export interface WorkflowRecipeDefinition {
	id: WorkflowRecipeId;
	title: string;
	description: string;
	runLabel: string;
	targetType: "create-note" | "append-note";
	defaultQuery: string;
}

export interface WorkflowRunConfig {
	recipeId: WorkflowRecipeId;
	scope: RAGQueryScope;
	targetNote?: string;
	outputFolder?: string;
	titleTemplate?: string;
}

interface WorkflowLLMEnvelope {
	title?: unknown;
	summary?: unknown;
	wins?: unknown;
	open_loops?: unknown;
	next_actions?: unknown;
	suggested_tags?: unknown;
	markdown?: unknown;
	follow_ups?: unknown;
	progress?: unknown;
	risks?: unknown;
	blockers?: unknown;
	next_steps?: unknown;
}

export const WORKFLOW_RECIPES: WorkflowRecipeDefinition[] = [
	{
		id: "weekly-review",
		title: "Weekly review",
		description: "Create a review note from the selected note scope.",
		runLabel: "Draft weekly review",
		targetType: "create-note",
		defaultQuery: "Summarize the scoped notes into a weekly review with wins, open loops, and next actions.",
	},
	{
		id: "meeting-notes-to-tasks",
		title: "Meeting notes to tasks",
		description: "Turn meeting notes into a task update that can be appended to a project note.",
		runLabel: "Draft task update",
		targetType: "append-note",
		defaultQuery: "Extract action items and follow-ups from the scoped meeting notes.",
	},
	{
		id: "project-status-summary",
		title: "Project status summary",
		description: "Summarize progress, risks, and next steps for a project note.",
		runLabel: "Draft status summary",
		targetType: "append-note",
		defaultQuery: "Summarize the scoped notes into project progress, risks, blockers, and next steps.",
	},
];

export function createDefaultWorkflowDefaults(): WorkflowDefaults {
	return {
		recipes: {
			"weekly-review": {
				scopeOption: "current-folder",
				tagValue: "",
				targetNote: "",
				outputFolder: "",
				titleTemplate: "Weekly Review - YYYY-MM-DD",
			},
			"meeting-notes-to-tasks": {
				scopeOption: "current-note",
				tagValue: "",
				targetNote: "",
				outputFolder: "",
				titleTemplate: "",
			},
			"project-status-summary": {
				scopeOption: "tag",
				tagValue: "#project",
				targetNote: "",
				outputFolder: "",
				titleTemplate: "",
			},
		},
	};
}

export function mergeWorkflowDefaults(savedDefaults?: Partial<WorkflowDefaults>): WorkflowDefaults {
	const defaults = createDefaultWorkflowDefaults();
	if (!savedDefaults?.recipes) {
		return defaults;
	}

	for (const recipe of WORKFLOW_RECIPES) {
		defaults.recipes[recipe.id] = {
			...defaults.recipes[recipe.id],
			...savedDefaults.recipes[recipe.id],
		};
	}
	return defaults;
}

export class WorkflowRunnerService {
	constructor(
		private app: App,
		private plugin: OLocalLLMPlugin,
	) {}

	getRecipe(recipeId: WorkflowRecipeId): WorkflowRecipeDefinition {
		const recipe = WORKFLOW_RECIPES.find(item => item.id === recipeId);
		if (!recipe) {
			throw new Error(`Unknown workflow recipe: ${recipeId}`);
		}
		return recipe;
	}

	getDefaults(recipeId: WorkflowRecipeId): WorkflowRecipeDefaults {
		return this.plugin.settings.workflowDefaults.recipes[recipeId];
	}

	async runWorkflow(config: WorkflowRunConfig, context: ChatEnvironmentContext): Promise<AgentResponse> {
		const recipe = this.getRecipe(config.recipeId);
		const ragContext = await this.plugin.ragManager.getRelevantContext(recipe.defaultQuery, config.scope);
		const prompt = this.buildWorkflowPrompt(recipe, config, ragContext.context, ragContext.sources);
		const rawResponse = await this.submitWorkflowPrompt(prompt);
		const parsed = this.parseWorkflowJson(rawResponse);
		const actions = this.buildActions(recipe.id, parsed, config);
		const message = this.buildResultMessage(recipe.id, parsed);
		const pendingActions = await this.plugin.vaultAgent.prepareManualActions(actions, context, "workflow");

		return {
			message,
			rawResponse,
			actions: pendingActions,
			parseError: pendingActions.length === 0 ? "Workflow did not produce any writable output." : undefined,
			sources: ragContext.sources,
		};
	}

	private async submitWorkflowPrompt(prompt: string): Promise<string> {
		const response = await requestUrl({
			url: this.getChatCompletionsUrl(),
			method: "POST",
			headers: buildOpenAIHeaders(getChatApiKey(this.plugin.settings)),
			body: JSON.stringify({
				model: this.plugin.settings.llmModel,
				messages: [
					{
						role: "system",
						content: [
							"You are a workflow drafting assistant inside Obsidian.",
							"Return strict JSON only. Do not wrap the JSON in markdown fences.",
							"The JSON must match the requested workflow schema exactly.",
						].join("\n"),
					},
					{
						role: "user",
						content: prompt,
					},
				],
				temperature: this.plugin.settings.temperature,
				max_tokens: this.plugin.settings.maxTokens,
				stream: false,
			}),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`LLM server returned ${response.status}: ${response.text}`);
		}

		let rawResponse = response.json?.choices?.[0]?.message?.content ?? "";
		if (typeof rawResponse !== "string") {
			throw new Error("Workflow completion returned an unexpected response shape.");
		}
		if (this.plugin.settings.extractReasoningResponses) {
			const markers = parseReasoningMarkers(this.plugin.settings.reasoningMarkers || "");
			rawResponse = extractActualResponse(rawResponse, markers);
		}
		return rawResponse.trim();
	}

	private buildWorkflowPrompt(recipe: WorkflowRecipeDefinition, config: WorkflowRunConfig, noteContext: string, sources: string[]): string {
		const sourceList = sources.length > 0 ? sources.join("\n- ") : "No individual source names available.";
		const scopeLabel = config.scope.label || config.scope.mode;

		if (recipe.id === "weekly-review") {
			const titleTemplate = config.titleTemplate || "Weekly Review - YYYY-MM-DD";
			const outputFolder = config.outputFolder?.trim() || "(vault root)";
			return [
				`Recipe: ${recipe.title}`,
				`Scope: ${scopeLabel}`,
				`Output folder: ${outputFolder}`,
				`Preferred title template: ${titleTemplate}`,
				`Sources:\n- ${sourceList}`,
				`Retrieved note context:\n${noteContext}`,
				"",
				"Return JSON with this schema:",
				"{",
				'  "title": "string",',
				'  "summary": "string",',
				'  "wins": ["string"],',
				'  "open_loops": ["string"],',
				'  "next_actions": ["string"],',
				'  "suggested_tags": ["string"],',
				'  "markdown": "full markdown document body"',
				"}",
				"",
				"Use the provided title template if you need a fallback title.",
			].join("\n");
		}

		if (recipe.id === "meeting-notes-to-tasks") {
			return [
				`Recipe: ${recipe.title}`,
				`Scope: ${scopeLabel}`,
				`Target note: ${config.targetNote || "(missing)"}`,
				`Sources:\n- ${sourceList}`,
				`Retrieved note context:\n${noteContext}`,
				"",
				"Return JSON with this schema:",
				"{",
				'  "summary": "string",',
				'  "next_actions": ["string"],',
				'  "follow_ups": ["string"],',
				'  "markdown": "markdown section to append to the target note"',
				"}",
			].join("\n");
		}

		return [
			`Recipe: ${recipe.title}`,
			`Scope: ${scopeLabel}`,
			`Target note: ${config.targetNote || "(missing)"}`,
			`Sources:\n- ${sourceList}`,
			`Retrieved note context:\n${noteContext}`,
			"",
			"Return JSON with this schema:",
			"{",
			'  "summary": "string",',
			'  "progress": ["string"],',
			'  "risks": ["string"],',
			'  "blockers": ["string"],',
			'  "next_steps": ["string"],',
			'  "markdown": "markdown section to append to the target note"',
			"}",
		].join("\n");
	}

	private parseWorkflowJson(rawResponse: string): WorkflowLLMEnvelope {
		const fencedMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/i);
		const candidate = fencedMatch?.[1]?.trim() || rawResponse.trim();
		const objectMatch = candidate.match(/\{[\s\S]*\}/);
		const jsonText = objectMatch?.[0] || candidate;

		try {
			return JSON.parse(jsonText) as WorkflowLLMEnvelope;
		} catch (error) {
			throw new Error(`Workflow returned invalid JSON: ${error instanceof Error ? error.message : "Invalid JSON"}`);
		}
	}

	private buildActions(recipeId: WorkflowRecipeId, envelope: WorkflowLLMEnvelope, config: WorkflowRunConfig): AgentAction[] {
		const markdown = this.requireString(envelope.markdown, "markdown");
		if (recipeId === "weekly-review") {
			const rawTitle = this.asOptionalString(envelope.title);
			const fallbackTitle = this.renderTitleTemplate(config.titleTemplate || "Weekly Review - YYYY-MM-DD");
			const finalTitle = rawTitle?.trim() || fallbackTitle;
			const basePath = [config.outputFolder?.trim(), finalTitle].filter(Boolean).join("/");
			return [{
				type: "create_note",
				path: basePath || finalTitle,
				content: markdown,
			}];
		}

		const targetNote = config.targetNote?.trim();
		if (!targetNote) {
			throw new Error("Choose a target note before running this workflow.");
		}

		return [{
			type: "append_to_note",
			target: targetNote,
			content: markdown,
		}];
	}

	private buildResultMessage(recipeId: WorkflowRecipeId, envelope: WorkflowLLMEnvelope): string {
		const summary = this.asOptionalString(envelope.summary)?.trim();
		const defaultMessages: Record<WorkflowRecipeId, string> = {
			"weekly-review": "Weekly review draft ready for approval.",
			"meeting-notes-to-tasks": "Meeting task update ready for approval.",
			"project-status-summary": "Project status summary ready for approval.",
		};
		return summary ? `${defaultMessages[recipeId]}\n\n${summary}` : defaultMessages[recipeId];
	}

	private renderTitleTemplate(template: string): string {
		const now = new Date();
		const yyyy = String(now.getFullYear());
		const mm = String(now.getMonth() + 1).padStart(2, "0");
		const dd = String(now.getDate()).padStart(2, "0");
		return template.replace(/YYYY-MM-DD/g, `${yyyy}-${mm}-${dd}`);
	}

	private requireString(value: unknown, field: string): string {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
		throw new Error(`Workflow output is missing "${field}".`);
	}

	private asOptionalString(value: unknown): string | undefined {
		return typeof value === "string" ? value : undefined;
	}

	private getChatCompletionsUrl(): string {
		return getChatCompletionsUrl(this.plugin.settings);
	}
}
