import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

const state = vi.hoisted(() => ({ modern: true, rows: [] as { name: string; controls: { change?: (value: unknown) => unknown }[] }[] }));
vi.mock("obsidian", () => {
	class Element {
		value = "";
		createDiv() { return new Element(); }
		createEl() { return new Element(); }
		createSpan() { return new Element(); }
		addClass() {}
		remove() {}
		empty() {}
	}
	class Control {
		inputEl = new Element();
		buttonEl = new Element();
		change?: (value: unknown) => unknown;
		setValue() { return this; }
		setPlaceholder() { return this; }
		setDisabled() { return this; }
		setButtonText() { return this; }
		setCta() { return this; }
		setClass() { return this; }
		addOption() { return this; }
		onChange(fn: (value: unknown) => unknown) { this.change = fn; return this; }
		onClick() { return this; }
	}
	class Setting {
		name = "";
		controls: Control[] = [];
		components = this.controls;
		settingEl = new Element();
		controlEl = new Element();
		constructor() { state.rows.push(this); }
		setName(value: string) { this.name = value; return this; }
		setDesc() { return this; }
		setHeading() { return this; }
		addText(fn: (control: Control) => void) { const c = new Control(); this.controls.push(c); fn(c); return this; }
		addToggle(fn: (control: Control) => void) { return this.addText(fn); }
		addDropdown(fn: (control: Control) => void) { return this.addText(fn); }
		addButton(fn: (control: Control) => void) { return this.addText(fn); }
	}
	class PluginSettingTab {
		containerEl = new Element();
		update = vi.fn();
	}
	class Plugin { loadData = vi.fn().mockResolvedValue(null); }
	return { Plugin, PluginSettingTab, Setting, Modal: class {}, SuggestModal: class {}, FuzzySuggestModal: class {}, ItemView: class {}, Component: class {}, MarkdownView: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, requireApiVersion: () => state.modern };
});
import Plugin, { OLLMSettingTab } from "../main";
import { Setting } from "obsidian";

async function setup() {
	const plugin = new Plugin({} as App, {} as PluginManifest);
	await plugin.loadSettings();
	plugin.manifest = { version: "test" } as PluginManifest;
	plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
	plugin.ragManager = { isInitialized: () => true, getIndexedFilesCount: () => 3 } as typeof plugin.ragManager;
	return { plugin, tab: new OLLMSettingTab({} as App, plugin) };
}

beforeEach(() => { vi.useFakeTimers(); state.rows.length = 0; state.modern = true; });
afterEach(() => { vi.useRealTimers(); });

describe("settings API compatibility", () => {
	it("indexes settings search terms without building UI or reading index state", async () => {
		const { plugin, tab } = await setup();
		const definitions = tab.getSettingDefinitions();
		expect(state.rows).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		const terms = definitions.flatMap(def => [def.name, ...def.aliases]);
		for (const name of ["Embedding server URL", "Index PDF attachments", "Automatic daily brief", "Title template", "Search provider"]) expect(terms).toContain(name);
	});

	it("renders the same controls through legacy display and declarative callbacks", async () => {
		const { tab } = await setup();
		tab.display();
		const legacyNames = state.rows.map(row => row.name);
		expect(legacyNames).toContain("Temperature");
		expect(legacyNames).toContain("Index PDF attachments");
		expect(legacyNames).toContain("Version");
		tab.hide();
		state.rows.length = 0;
		for (const def of tab.getSettingDefinitions()) def.render(new Setting(tab.containerEl).setName(def.name));
		expect(state.rows.map(row => row.name)).toEqual(legacyNames);
		tab.hide();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([true, false])("preserves provider side effects and refreshes the correct UI (modern=%s)", async (modern) => {
		state.modern = modern;
		const { plugin, tab } = await setup();
		tab.display();
		const provider = state.rows.find(row => row.name === "Provider")!;
		await provider.controls[0].change!("openai");
		expect(plugin.settings.providerType).toBe("openai");
		expect(plugin.settings.serverAddress).toBe("http://localhost:1234");
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		if (modern) expect(tab.update).toHaveBeenCalledOnce();
		else {
			expect(tab.update).not.toHaveBeenCalled();
			expect(state.rows.some(row => row.name === "Chat/default API key")).toBe(true);
		}
		tab.hide();
	});

	it("retains numeric validation and flushes pending text saves when hidden", async () => {
		const { plugin, tab } = await setup();
		tab.display();
		const temperature = state.rows.find(row => row.name === "Temperature")!.controls[0];
		temperature.change!("100");
		expect(plugin.settings.temperature).toBe(0.7);
		temperature.change!("0.5");
		expect(plugin.settings.temperature).toBe(0.5);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		tab.hide();
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
