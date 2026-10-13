import { App, Component, MarkdownRenderer } from "obsidian";

/** Owns Markdown embeds only for the lifetime of the visible conversation. */
export class ChatRenderScope {
	private current: { component: Component; pending: number } | null = null;

	reset(): void {
		this.dispose();
		this.current = { component: new Component(), pending: 0 };
		this.current.component.load();
	}

	dispose(): void {
		const previous = this.current;
		this.current = null;
		if (previous?.pending === 0) previous.component.unload();
	}

	render(app: App, text: string, container: HTMLElement, sourcePath: string,
		onRendered?: () => void, onError?: (error: unknown) => void): void {
		const current = this.current;
		if (!current) return;
		current.pending++;
		void MarkdownRenderer.render(app, text, container, sourcePath, current.component)
			.then(() => {
				if (this.current === current) onRendered?.();
			})
			.catch((error: unknown) => {
				if (this.current === current) onError?.(error);
			})
			.finally(() => {
				current.pending--;
				// Unload once, after all pending renderers have registered their cleanup.
				// Obsidian's unload() ignores subsequent calls on an unloaded component.
				if (this.current !== current && current.pending === 0) current.component.unload();
			});
	}
}
