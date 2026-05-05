import type { ScopeOption } from "./ragScope";

export type WorkflowRecipeId =
	| "weekly-review"
	| "meeting-notes-to-tasks"
	| "project-status-summary";

export interface WorkflowRecipeDefaults {
	scopeOption: ScopeOption;
	tagValue: string;
	targetNote: string;
	outputFolder: string;
	titleTemplate: string;
}

export interface WorkflowDefaults {
	recipes: Record<WorkflowRecipeId, WorkflowRecipeDefaults>;
}

