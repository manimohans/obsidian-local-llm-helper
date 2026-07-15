import { describe, expect, it, vi } from "vitest";
import {
	LLMClientError,
	type CompletionRequest,
	type OpenAICompatibleClient,
} from "../src/llmClient";
import {
	buildRadarContext,
	createEmptyVaultRadarState,
	getVisibleVaultRadarCards,
	MAX_VAULT_RADAR_NOTE_VERSIONS,
	MAX_VAULT_RADAR_STATE_CHARS,
	normalizeVaultRadarState,
	parseVaultRadarResponse,
	prepareVaultRadarStateForPersistence,
	selectRadarNotes,
	updateVaultRadarCard,
	VaultRadarService,
	type VaultRadarDependencies,
	type VaultRadarSource,
	type VaultRadarState,
} from "../src/vaultRadar";

const DAY = 24 * 60 * 60 * 1000;

function source(id: string, path: string): VaultRadarSource {
	return {
		id,
		path,
		label: path,
		modifiedAt: 1_000,
		excerpt: "A grounded note excerpt.",
	};
}

function storedState(): VaultRadarState {
	return {
		version: 1,
		lastSuccessfulRunAt: 900,
		noteVersions: { "Alpha.md": { modifiedAt: 900, size: 10 } },
		emittedFingerprints: ["old"],
		cards: [{
			id: "radar-old",
			fingerprint: "old",
			kind: "commitment",
			title: "Old commitment",
			insight: "An existing insight",
			sourcePaths: ["Alpha.md"],
			confidence: "high",
			createdAt: 900,
		}],
	};
}

describe("Vault Radar note selection", () => {
	it("selects deterministic recent notes and caps a first run", () => {
		const notes = [
			{ path: "B.md", modifiedAt: 90, size: 20 },
			{ path: "A.md", modifiedAt: 90, size: 10 },
			{ path: "C.md", modifiedAt: 80, size: 30 },
		];
		const selected = selectRadarNotes(notes, createEmptyVaultRadarState(), {
			maxNotes: 2,
			firstRunLookbackMs: 100,
		}, 100);
		expect(selected.map((note) => note.path)).toEqual(["A.md", "B.md"]);
	});

	it("fills a first brief with older notes when only a few are inside the lookback", () => {
		const selected = selectRadarNotes([
			{ path: "Recent.md", modifiedAt: 95, size: 20 },
			{ path: "Older.md", modifiedAt: 40, size: 20 },
		], createEmptyVaultRadarState(), {
			maxNotes: 2,
			firstRunLookbackMs: 10,
		}, 100);
		expect(selected.map((note) => note.path)).toEqual(["Recent.md", "Older.md"]);
	});

	it("keeps overflow changes eligible and ignores notes beyond the run upper bound", () => {
		const state = storedState();
		const notes = [
			{ path: "Alpha.md", modifiedAt: 950, size: 11 },
			{ path: "Beta.md", modifiedAt: 940, size: 12 },
			{ path: "Gamma.md", modifiedAt: 1_100, size: 13 },
		];
		const selected = selectRadarNotes(notes, state, { maxNotes: 1 }, 1_000);
		expect(selected.map((note) => note.path)).toEqual(["Alpha.md"]);
	});
});

describe("Vault Radar model contract", () => {
	it("parses fenced JSON and maps only allowlisted source IDs", () => {
		const cards = parseVaultRadarResponse(
			"```json\n" + JSON.stringify({
				cards: [{
					kind: "connection",
					title: "Two notes point at the same launch risk",
					insight: "The dependency and the launch plan conflict.",
					action: "Resolve the dependency before announcing a date.",
					sourceIds: ["S1", "S2"],
					confidence: "high",
				}],
			}) + "\n```",
			[source("S1", "Plan.md"), source("S2", "Dependency.md")],
		);
		expect(cards).toHaveLength(1);
		expect(cards[0].sourcePaths).toEqual(["Plan.md", "Dependency.md"]);
		expect(cards[0].id).toMatch(/^radar-/);
	});

	it("rejects a response whose cards cite fabricated sources", () => {
		expect(() => parseVaultRadarResponse(JSON.stringify({
			cards: [{
				kind: "commitment",
				title: "Unsupported",
				insight: "This source was not supplied.",
				sourceIds: ["S99"],
				confidence: "high",
			}],
		}), [source("S1", "Plan.md")])).toThrow(/no grounded/i);
	});

	it("requires a connection card to cite at least two distinct notes", () => {
		expect(() => parseVaultRadarResponse(JSON.stringify({
			cards: [{
				kind: "connection",
				title: "Not actually cross-note",
				insight: "A single note cannot prove a cross-note connection.",
				sourceIds: ["S1"],
				confidence: "medium",
			}],
		}), [source("S1", "Plan.md")])).toThrow(/no grounded/i);
	});

	it("bounds the combined prompt context", () => {
		const context = buildRadarContext([
			{ ...source("S1", "A.md"), excerpt: "a".repeat(700) },
			{ ...source("S2", "B.md"), excerpt: "b".repeat(700) },
		], 1_000);
		expect(context).toContain('id="S1"');
		expect(context).not.toContain('id="S2"');
		expect(context.length).toBeLessThanOrEqual(1_000);
	});
});

describe("Vault Radar persisted state", () => {
	it("falls back safely for corrupt or unsupported state", () => {
		expect(normalizeVaultRadarState(null)).toEqual(createEmptyVaultRadarState());
		expect(normalizeVaultRadarState({ version: 99, cards: [{ secret: true }] }))
			.toEqual(createEmptyVaultRadarState());
	});

	it("keeps a full ordinary note-version index within the persistence limit", () => {
		const noteVersions = Object.fromEntries(Array.from(
			{ length: MAX_VAULT_RADAR_NOTE_VERSIONS },
			(_, index) => [
				`Projects/${String(index).padStart(5, "0")}-${"release-notes-".repeat(5)}.md`,
				{ modifiedAt: index + 1, size: index + 10 },
			],
		));
		const normalized = normalizeVaultRadarState({
			version: 1,
			noteVersions,
			emittedFingerprints: [],
			cards: [],
		});
		const prepared = prepareVaultRadarStateForPersistence(normalized);

		expect(Object.keys(prepared.state.noteVersions)).toHaveLength(MAX_VAULT_RADAR_NOTE_VERSIONS);
		expect(prepared.serialized.length).toBeGreaterThan(2_000_000);
		expect(prepared.serialized.length).toBeLessThanOrEqual(MAX_VAULT_RADAR_STATE_CHARS);
	});

	it("prunes only the oldest note versions when a state exceeds its cap", () => {
		const input = normalizeVaultRadarState({
			...storedState(),
			noteVersions: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [
				`Projects/${String(index).padStart(2, "0")}-${"long-path-".repeat(4)}.md`,
				{ modifiedAt: index + 1, size: index + 10 },
			])),
		});
		const newestTen = Object.entries(input.noteVersions).slice(0, 10);
		const exactTenState: VaultRadarState = {
			...input,
			noteVersions: Object.fromEntries(newestTen),
		};
		const cap = JSON.stringify(exactTenState, null, 2).length;

		const prepared = prepareVaultRadarStateForPersistence(input, cap);

		expect(Object.entries(prepared.state.noteVersions)).toEqual(newestTen);
		expect(prepared.state.cards).toEqual(input.cards);
		expect(prepared.state.emittedFingerprints).toEqual(input.emittedFingerprints);
		expect(prepared.serialized.length).toBeLessThanOrEqual(cap);
	});

	it("persists feedback separately from dismiss and honors snooze expiry", () => {
		let state = storedState();
		state = updateVaultRadarCard(state, "radar-old", { type: "feedback", value: "wrong" });
		expect(state.cards[0].feedback).toBe("wrong");
		expect(getVisibleVaultRadarCards(state, 1_000)).toHaveLength(1);

		state = updateVaultRadarCard(state, "radar-old", { type: "snooze", until: 1_000 + DAY });
		expect(getVisibleVaultRadarCards(state, 1_000)).toHaveLength(0);
		expect(getVisibleVaultRadarCards(state, 1_000 + DAY)).toHaveLength(1);

		state = updateVaultRadarCard(state, "radar-old", { type: "dismiss", at: 2_000 });
		expect(getVisibleVaultRadarCards(state, 3_000)).toHaveLength(0);
	});
});

describe("VaultRadarService", () => {
	function harness(options: {
		initial?: VaultRadarState;
		response?: string;
		notes?: Array<{ path: string; modifiedAt: number; size: number }>;
	}) {
		let persisted = options.initial ?? createEmptyVaultRadarState();
		const saveState = vi.fn(async (state: VaultRadarState) => {
			persisted = state;
		});
		const complete = vi.fn(async (_request: CompletionRequest) => (
			options.response ?? JSON.stringify({ cards: [] })
		));
		const client = { complete } as unknown as OpenAICompatibleClient;
		const dependencies: VaultRadarDependencies = {
			listNotes: async () => options.notes ?? [{ path: "Alpha.md", modifiedAt: 950, size: 100 }],
			readNote: async () => "I promised to send the launch brief on Friday. The launch is currently blocked.",
			loadState: async () => persisted,
			saveState,
		};
		const service = new VaultRadarService(
			client,
			() => ({ model: "test-model", maxTokens: 1_000 }),
			dependencies,
			{ now: () => 1_000 },
		);
		return { service, complete, saveState, getPersisted: () => persisted };
	}

	it("stores grounded cards only after a successful completion and parse", async () => {
		const test = harness({
			response: JSON.stringify({
				cards: [{
					kind: "commitment",
					title: "Send the launch brief",
					insight: "A Friday commitment is still open.",
					action: "Send or renegotiate the brief today.",
					sourceIds: ["S1"],
					confidence: "high",
				}],
			}),
		});
		const result = await test.service.run();
		expect(result.status).toBe("generated");
		expect(test.complete).toHaveBeenCalledTimes(1);
		expect(test.complete.mock.calls[0][0]).toMatchObject({
			responseFormat: "json_object",
		});
		expect(test.saveState).toHaveBeenCalledTimes(1);
		expect(test.getPersisted().cards).toHaveLength(1);
		expect(test.getPersisted().noteVersions["Alpha.md"]).toEqual({ modifiedAt: 950, size: 100 });
	});

	it("does not advance state after malformed model output", async () => {
		const initial = createEmptyVaultRadarState();
		const test = harness({ initial, response: "not json" });
		await expect(test.service.run()).rejects.toThrow(/malformed JSON/i);
		expect(test.saveState).not.toHaveBeenCalled();
		expect(test.getPersisted()).toBe(initial);
	});

	it("skips the model and records a successful no-change check", async () => {
		const initial = storedState();
		const test = harness({
			initial,
			notes: [{ path: "Alpha.md", modifiedAt: 900, size: 10 }],
		});
		const result = await test.service.run();
		expect(result.status).toBe("no_changes");
		expect(test.complete).not.toHaveBeenCalled();
		expect(test.saveState).toHaveBeenCalledTimes(1);
		expect(test.getPersisted().lastSuccessfulRunAt).toBe(1_000);
	});

	it("coalesces overlapping runs into one provider call", async () => {
		const test = harness({ response: JSON.stringify({ cards: [] }) });
		const first = test.service.run();
		const second = test.service.run();
		expect(first).toBe(second);
		await Promise.all([first, second]);
		expect(test.complete).toHaveBeenCalledTimes(1);
	});

	it("falls back once when an older server rejects JSON response mode", async () => {
		let persisted = createEmptyVaultRadarState();
		let completionCalls = 0;
		const complete = vi.fn(async (_request: CompletionRequest) => {
			completionCalls += 1;
			if (completionCalls === 1) {
				throw new LLMClientError(
					"invalid_request",
					"completion",
					"Unsupported response format",
					400,
				);
			}
			return JSON.stringify({ cards: [] });
		});
		const service = new VaultRadarService(
			{ complete } as unknown as OpenAICompatibleClient,
			() => ({ model: "legacy-model" }),
			{
				listNotes: async () => [{ path: "Alpha.md", modifiedAt: 950, size: 100 }],
				readNote: async () => "A changed note with enough content to analyze.",
				loadState: async () => persisted,
				saveState: async (state) => { persisted = state; },
			},
			{ now: () => 1_000 },
		);

		await expect(service.run()).resolves.toMatchObject({ status: "no_new_insights" });
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls[0][0]).toMatchObject({ responseFormat: "json_object" });
		expect(complete.mock.calls[1][0]).not.toHaveProperty("responseFormat");
	});

	it("fits 25 long notes with long nested paths inside the exact context limit", async () => {
		let persisted = createEmptyVaultRadarState();
		const paths = Array.from({ length: 25 }, (_, index) => (
			`Projects/${String(index).padStart(2, "0")}-${"nested-folder/".repeat(12)}note.md`
		));
		const notes = paths.map((path, index) => ({
			path,
			modifiedAt: 950 - index,
			size: 10_000,
		}));
		const complete = vi.fn(async (_request: CompletionRequest) => JSON.stringify({ cards: [] }));
		const service = new VaultRadarService(
			{ complete } as unknown as OpenAICompatibleClient,
			() => ({ model: "test-model" }),
			{
				listNotes: async () => notes,
				readNote: async () => "x".repeat(10_000),
				loadState: async () => persisted,
				saveState: async (state) => { persisted = state; },
			},
			{
				now: () => 1_000,
				maxNotes: 25,
				maxContextChars: 36_000,
				maxCharsPerNote: 3_200,
			},
		);

		const result = await service.run();
		const request = complete.mock.calls[0][0] as CompletionRequest;
		const userPrompt = request.messages.find((message) => message.role === "user")?.content ?? "";
		const contextStart = userPrompt.indexOf('<source id="S1">');
		const contextEnd = userPrompt.indexOf("\n\n<end-of-untrusted-sources>");
		const context = userPrompt.slice(contextStart, contextEnd);

		expect(result.status).toBe("no_new_insights");
		expect(result.sources).toHaveLength(25);
		expect(context.length).toBeLessThanOrEqual(36_000);
		expect((context.match(/<source id=/g) ?? [])).toHaveLength(25);
		expect(Object.keys(persisted.noteVersions)).toHaveLength(25);
	});

	it("leaves a source eligible when its pathological path cannot fit", async () => {
		let persisted = createEmptyVaultRadarState();
		const deferredPath = `A-${"nested/".repeat(170)}note.md`;
		const includedPath = "B.md";
		const notes = [
			{ path: deferredPath, modifiedAt: 950, size: 1_000 },
			{ path: includedPath, modifiedAt: 940, size: 1_000 },
		];
		const complete = vi.fn(async (_request: CompletionRequest) => JSON.stringify({ cards: [] }));
		const service = new VaultRadarService(
			{ complete } as unknown as OpenAICompatibleClient,
			() => ({ model: "test-model" }),
			{
				listNotes: async () => notes,
				readNote: async () => "A changed note with enough content to analyze.".repeat(30),
				loadState: async () => persisted,
				saveState: async (state) => { persisted = state; },
			},
			{ now: () => 1_000, maxNotes: 3, maxContextChars: 1_000 },
		);

		const result = await service.run();

		expect(result.sources.map((item) => item.path)).toEqual([includedPath]);
		expect(persisted.noteVersions[includedPath]).toEqual({ modifiedAt: 940, size: 1_000 });
		expect(persisted.noteVersions[deferredPath]).toBeUndefined();
		expect(selectRadarNotes(notes, persisted, { maxNotes: 3 }, 1_100).map((note) => note.path))
			.toEqual([deferredPath]);
	});
});
