import { App } from "obsidian";
import type OLocalLLMPlugin from "../main";
import type { AgentResponse, ChatEnvironmentContext, AgentAction } from "./vaultAgent";
import { extractActualResponse, parseReasoningMarkers } from "./reasoningExtractor";
import type { RAGQueryScope, SourceReference } from "./rag";
import type { WorkflowDefaults, WorkflowRecipeDefaults, WorkflowRecipeId } from "./workflowTypes";
import { LLMClientError, OpenAICompatibleClient, type CompletionRequest } from "./llmClient";
import { buildWorkflowUserPrompt, WORKFLOW_SYSTEM_PROMPT } from "./prompts";

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
	summary?: unknown;
	markdown?: unknown;
}

export const WORKFLOW_RECIPES: WorkflowRecipeDefinition[] = [
	{
		id: "weekly-review",
		title: "Weekly review",
		description: "Create a review note from the selected note scope.",
		runLabel: "Draft weekly review",
		targetType: "create-note",
		defaultQuery: "Find supported wins, completed outcomes, unresolved commitments, open loops, owners, due dates, and next actions for a weekly review.",
	},
	{
		id: "meeting-notes-to-tasks",
		title: "Meeting notes to tasks",
		description: "Turn meeting notes into a task update that can be appended to a project note.",
		runLabel: "Draft task update",
		targetType: "append-note",
		defaultQuery: "Find meeting outcomes, decisions, commitments, action items, owners, due dates, follow-ups, and unresolved questions.",
	},
	{
		id: "project-status-summary",
		title: "Project status summary",
		description: "Summarize progress, risks, and next steps for a project note.",
		runLabel: "Draft status summary",
		targetType: "append-note",
		defaultQuery: "Find project status, completed and in-progress work, dependencies, risks, blockers, unresolved decisions, and supported next steps.",
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
		private llmClient: OpenAICompatibleClient,
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
		const completionRequest: CompletionRequest = {
			model: this.plugin.settings.llmModel,
			messages: [
				{
					role: "system",
					content: WORKFLOW_SYSTEM_PROMPT,
				},
				{
					role: "user",
					content: prompt,
				},
			],
			temperature: Math.min(this.plugin.settings.temperature, 0.3),
			maxTokens: this.plugin.settings.maxTokens,
			bufferedStream: false,
		};
		let rawResponse: string;
		try {
			rawResponse = await this.llmClient.complete({
				...completionRequest,
				responseFormat: "json_object",
			});
		} catch (error) {
			if (!(error instanceof LLMClientError) || error.code !== "invalid_request") {
				throw error;
			}
			// Older local OpenAI-compatible servers may not support JSON mode.
			// Their rejected request produced no content, so the strict prompt is
			// safe to retry once without response_format.
			rawResponse = await this.llmClient.complete(completionRequest);
		}
		const markers = parseReasoningMarkers(this.plugin.settings.reasoningMarkers || "");
		rawResponse = extractActualResponse(rawResponse, markers);
		return rawResponse.trim();
	}

	private buildWorkflowPrompt(recipe: WorkflowRecipeDefinition, config: WorkflowRunConfig, noteContext: string, sources: SourceReference[]): string {
		const scopeLabel = config.scope.label || config.scope.mode;
		const resolvedTitle = recipe.id === "weekly-review"
			? this.renderTitleTemplate(config.titleTemplate || "Weekly Review - YYYY-MM-DD")
			: undefined;
		return buildWorkflowUserPrompt({
			recipeId: recipe.id,
			recipeTitle: recipe.title,
			scopeLabel,
			targetNote: recipe.targetType === "append-note" ? config.targetNote?.trim() : undefined,
			outputFolder: recipe.id === "weekly-review" ? config.outputFolder?.trim() || "" : undefined,
			resolvedTitle,
			sourceLabels: sources.map((source) => source.label),
			noteContext,
		});
	}

	private parseWorkflowJson(rawResponse: string): WorkflowLLMEnvelope {
		const fencedMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/i);
		const candidate = fencedMatch?.[1]?.trim() || rawResponse.trim();
		const objectMatch = candidate.match(/\{[\s\S]*\}/);
		const jsonText = objectMatch?.[0] || candidate;

		try {
			const parsed = JSON.parse(jsonText) as unknown;
			if (!this.isRecord(parsed)) {
				throw new Error("Workflow response must be a JSON object.");
			}
			return parsed as WorkflowLLMEnvelope;
		} catch (error) {
			throw new Error(`Workflow returned invalid JSON: ${error instanceof Error ? error.message : "Invalid JSON"}`);
		}
	}

	private buildActions(recipeId: WorkflowRecipeId, envelope: WorkflowLLMEnvelope, config: WorkflowRunConfig): AgentAction[] {
		const markdown = this.requireString(envelope.markdown, "markdown");
		if (recipeId === "weekly-review") {
			const finalTitle = this.renderTitleTemplate(config.titleTemplate || "Weekly Review - YYYY-MM-DD");
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

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

}
