import { App, Component, MarkdownRenderer } from "obsidian";

/** Owns Markdown embeds only for the lifetime of the visible conversation. */
export class ChatRenderScope {
	private component: Component | null = null;

	reset(): void {
		this.dispose();
		this.component = new Component();
		this.component.load();
	}

	dispose(): void {
		this.component?.unload();
		this.component = null;
	}

	render(app: App, text: string, container: HTMLElement, sourcePath: string,
		onRendered?: () => void, onError?: (error: unknown) => void): void {
		const component = this.component;
		if (!component) return;
		void MarkdownRenderer.render(app, text, container, sourcePath, component)
			.then(() => {
				if (this.component === component) onRendered?.();
			})
			.catch((error: unknown) => {
				if (this.component === component) onError?.(error);
			})
			.finally(() => {
				// Renderers can register children after a clear/close while awaiting embeds.
				if (this.component !== component) component.unload();
			});
	}
}
