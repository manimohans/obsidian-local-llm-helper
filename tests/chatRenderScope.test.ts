import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

const mocks = vi.hoisted(() => ({ components: [] as { load: ReturnType<typeof vi.fn>; unload: ReturnType<typeof vi.fn> }[], render: vi.fn() }));
vi.mock("obsidian", () => ({
	Component: class {
		load = vi.fn();
		unload = vi.fn();
		constructor() { mocks.components.push(this); }
	},
	MarkdownRenderer: { render: mocks.render },
}));
import { ChatRenderScope } from "../src/chatRenderScope";
const app = {} as App;
const container = {} as HTMLElement;
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

afterEach(() => { mocks.components.length = 0; });

describe("chat Markdown lifecycle", () => {
	it("owns rendered embeds and unloads them when the conversation clears", async () => {
		mocks.render.mockResolvedValue(undefined);
		const scope = new ChatRenderScope();
		scope.reset();
		const rendered = vi.fn();
		scope.render(app, "[[Note]]", container, "Context.md", rendered);
		await settle();
		expect(mocks.render).toHaveBeenCalledWith(app, "[[Note]]", container, "Context.md", mocks.components[0]);
		expect(rendered).toHaveBeenCalledOnce();
		scope.reset();
		expect(mocks.components[0].unload).toHaveBeenCalledOnce();
		expect(mocks.components[1].load).toHaveBeenCalledOnce();
		scope.dispose();
		expect(mocks.components[1].unload).toHaveBeenCalledOnce();
	});

	it("cleans up late embed registration after closing and ignores stale callbacks", async () => {
		let finish!: () => void;
		mocks.render.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
		const scope = new ChatRenderScope();
		scope.reset();
		const rendered = vi.fn();
		scope.render(app, "![[Note]]", container, "", rendered);
		scope.dispose();
		finish();
		await settle();
		expect(rendered).not.toHaveBeenCalled();
		expect(mocks.components[0].unload).toHaveBeenCalledTimes(2);
		scope.render(app, "late response", container, "");
		expect(mocks.render).toHaveBeenCalledOnce();
	});

	it("reports current render failures but ignores failures from a cleared conversation", async () => {
		const error = new Error("Bad embed");
		mocks.render.mockRejectedValue(error);
		const scope = new ChatRenderScope();
		scope.reset();
		const onError = vi.fn();
		scope.render(app, "bad", container, "", undefined, onError);
		await settle();
		expect(onError).toHaveBeenCalledWith(error);
		onError.mockClear();
		scope.render(app, "bad", container, "", undefined, onError);
		scope.reset();
		await settle();
		expect(onError).not.toHaveBeenCalled();
		scope.dispose();
	});
});
