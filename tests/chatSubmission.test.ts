import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type Plugin from "../main";
const mocks = vi.hoisted(() => ({ submit: vi.fn(), render: vi.fn(() => "Answer"), run: vi.fn(), save: vi.fn() }));
vi.mock("obsidian", () => ({
	Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, SuggestModal: class {}, FuzzySuggestModal: class {}, ItemView: class {}, Component: class {}, MarkdownView: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
}));
vi.mock("../src/vaultAgent", () => ({ getCurrentOrFallbackChatContext: () => ({}), getActiveChatContext: () => ({}), VaultAgentService: class {} }));
vi.mock("../src/chatSession", async importOriginal => ({ ...await importOriginal<typeof import("../src/chatSession")>(), submitGeneralChat: mocks.submit }));
import { LLMChatModal } from "../main";
import { WorkflowModal } from "../src/workflowModal";

class Element {
	value = "";
	classList = { add() {}, remove() {} };
	children: Element[] = [];
	createDiv() { const el = new Element(); this.children.push(el); return el; }
	createSpan() { return new Element(); }
	setText() {}
	remove() {}
	empty() { this.children = []; }
	querySelector() { return null; }
	removeChild() {}
}
function chat() {
	const modal = new LLMChatModal({} as App, { settings: { maxConvHistory: 5 } } as Plugin);
	const content = new Element(); const history = new Element(); const input = new Element();
	const setDisabled = vi.fn();
	Object.assign(modal, { contentEl: content, plugin: { settings: { maxConvHistory: 5 }, vaultAgent: { renderAgentResponse: mocks.render } },
		submitButton: { setDisabled, buttonEl: new Element() }, renderScope: { dispose: vi.fn() },
	});
	vi.spyOn(content, "querySelector").mockImplementation((selector?: string) => (selector === ".llm-chat-history" ? history : input) as never);
	return { modal, input, history, setDisabled };
}
function workflow() {
	const modal = Object.create(WorkflowModal.prototype) as WorkflowModal;
	// Only UI and external services are replaced; exercise the real submit/clear/close lifecycle.
	const invoke = modal as unknown as { handleSubmit(): Promise<void>; clearConversation(): void; onClose(): void };
	const setDisabled = vi.fn(); const config = { recipeId: "weekly-review", scope: { mode: "vault" } };
	Object.assign(modal, { app: {}, contentEl: new Element(), chatHistoryEl: new Element(), activeRequestId: 0, isSubmitting: false,
		plugin: { workflowRunner: { getRecipe: () => ({ title: "Weekly review" }), runWorkflow: mocks.run }, vaultAgent: { renderAgentResponse: mocks.render } },
		canSubmit: () => true, buildRunConfig: () => config, persistDefaults: mocks.save,
		hideWelcomeMessage: () => {}, showWelcomeMessage: () => {}, scrollToBottom: () => {}, renderScope: { reset() {}, dispose() {} },
		submitButton: { setDisabled, buttonEl: { addClass() {}, removeClass() {} } },
	});
	return { invoke, setDisabled, config };
}
beforeEach(() => { mocks.save.mockResolvedValue(undefined); vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("submission lifecycle", () => {
	it("allows one chat request at a time and preserves a draft typed while waiting", async () => {
		const { modal, input, setDisabled } = chat(); let finish!: (value: unknown) => void;
		mocks.submit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		modal.result = "First question"; const first = modal.handleSubmit();
		modal.result = "Next draft"; input.value = "Next draft"; await modal.handleSubmit();
		expect(mocks.submit).toHaveBeenCalledOnce(); expect(setDisabled).toHaveBeenLastCalledWith(true);
		finish({ response: {}, context: {} }); await first;
		expect(mocks.render).toHaveBeenCalledOnce(); expect(modal.conversationHistory).toEqual([{ prompt: "First question", response: "Answer" }]);
		expect(modal.result).toBe("Next draft"); expect(input.value).toBe("Next draft"); expect(setDisabled).toHaveBeenLastCalledWith(false);
	});
	it("ignores a chat reply after closing and allows another request", async () => {
		const { modal } = chat(); let finish!: (value: unknown) => void;
		mocks.submit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		modal.result = "First"; const first = modal.handleSubmit(); modal.onClose();
		finish({ response: {}, context: {} }); await first; expect(mocks.render).not.toHaveBeenCalled();
		mocks.submit.mockResolvedValueOnce({ response: {}, context: {} }); modal.result = "Second";
		await modal.handleSubmit(); expect(mocks.submit).toHaveBeenCalledTimes(2);
	});
	it("ignores double clicks while saving workflow defaults and while generating", async () => {
		const { invoke, setDisabled } = workflow(); let save!: () => void; let finish!: (value: unknown) => void;
		mocks.save.mockImplementationOnce(() => new Promise<void>(resolve => { save = resolve; }));
		mocks.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const first = invoke.handleSubmit(); await invoke.handleSubmit(); expect(mocks.save).toHaveBeenCalledOnce();
		save(); await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce()); await invoke.handleSubmit();
		expect(mocks.run).toHaveBeenCalledOnce(); expect(setDisabled).toHaveBeenLastCalledWith(true);
		finish({ actions: [] }); await first; expect(mocks.render).toHaveBeenCalledOnce(); expect(setDisabled).toHaveBeenLastCalledWith(false);
	});
	it("handles a settings save failure and lets the user retry the workflow", async () => {
		const { invoke, setDisabled } = workflow(); mocks.save.mockRejectedValueOnce(new Error("Save failed"));
		await expect(invoke.handleSubmit()).resolves.toBeUndefined(); expect(mocks.run).not.toHaveBeenCalled();
		expect(setDisabled).toHaveBeenLastCalledWith(false); mocks.run.mockResolvedValueOnce({ actions: [] });
		await invoke.handleSubmit(); expect(mocks.run).toHaveBeenCalledOnce();
	});
	it("does not start a workflow after clearing while its defaults are saving", async () => {
		const { invoke } = workflow(); let save!: () => void;
		mocks.save.mockImplementationOnce(() => new Promise<void>(resolve => { save = resolve; }));
		const first = invoke.handleSubmit(); invoke.clearConversation(); save(); await first;
		expect(mocks.run).not.toHaveBeenCalled(); mocks.run.mockResolvedValueOnce({ actions: [] });
		await invoke.handleSubmit(); expect(mocks.run).toHaveBeenCalledOnce();
	});
});
