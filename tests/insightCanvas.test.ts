import { describe, expect, it, vi } from "vitest";
import {
	buildInsightCanvas,
	getCollisionSafeInsightCanvasPath,
	sanitizeInsightCanvasFilename,
	serializeInsightCanvas,
} from "../src/insightCanvas";
import type { VaultRadarInsightCard } from "../src/vaultRadar";

function card(overrides: Partial<VaultRadarInsightCard> = {}): VaultRadarInsightCard {
	return {
		id: "radar-launch",
		fingerprint: "launch",
		kind: "connection",
		title: "Resolve the launch dependency",
		insight: "The launch plan and dependency note point to the same unresolved blocker.",
		action: "Choose an owner and a resolution date.",
		sourcePaths: ["Projects/Launch.md", "Projects/Dependency.md"],
		confidence: "high",
		...overrides,
	};
}

describe("Insight Canvas builder", () => {
	it("builds a deterministic center, radial file nodes, and evidence edges", () => {
		const input = card();
		const first = buildInsightCanvas(input, input.sourcePaths);
		const second = buildInsightCanvas(input, [...input.sourcePaths].reverse());

		expect(first).toEqual(second);
		expect(first.nodes).toHaveLength(3);
		expect(first.edges).toHaveLength(2);
		expect(first.nodes[0]).toMatchObject({
			type: "text",
			x: -220,
			width: 440,
			color: "6",
		});
		expect(first.nodes[0].height).toBeGreaterThanOrEqual(420);
		expect(first.nodes[0].y).toBe(-first.nodes[0].height / 2);
		expect(first.nodes[0]).toHaveProperty("text", expect.stringContaining("# Resolve the launch dependency"));
		expect(first.nodes.slice(1)).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "file", file: "Projects/Launch.md" }),
			expect.objectContaining({ type: "file", file: "Projects/Dependency.md" }),
		]));
		expect(first.edges.every((edge) => edge.label === "evidence")).toBe(true);
		expect(new Set(first.nodes.map((node) => `${node.x},${node.y}`)).size).toBe(3);
	});

	it("preserves validated source paths that legally begin or end with spaces", () => {
		const document = buildInsightCanvas(card({
			sourcePaths: [" Notes.md", "Notes.md ", "   "],
		}), [" Notes.md", "Notes.md "]);

		expect(document.nodes.slice(1).map((node) => (
			node.type === "file" ? node.file : ""
		))).toEqual([" Notes.md", "Notes.md "]);
	});

	it("grows the insight node deterministically for long Radar cards", () => {
		const shortDocument = buildInsightCanvas(card(), card().sourcePaths);
		const longDocument = buildInsightCanvas(card({
			insight: "Long evidence sentence. ".repeat(70),
			action: "Specific next action. ".repeat(30),
		}), card().sourcePaths);

		expect(longDocument.nodes[0].height).toBeGreaterThan(shortDocument.nodes[0].height);
		expect(longDocument.nodes[0].height).toBeLessThanOrEqual(960);
		expect(longDocument.nodes[0].y).toBe(-longDocument.nodes[0].height / 2);
	});

	it.each([6, 12])("keeps %i radial sources clear of a max-height insight", (sourceCount) => {
		const sourcePaths = Array.from({ length: sourceCount }, (_, index) => `Source ${index + 1}.md`);
		const document = buildInsightCanvas(card({
			insight: "Long evidence sentence. ".repeat(120),
			action: "Specific next action. ".repeat(60),
			sourcePaths,
		}), sourcePaths);
		const center = document.nodes[0];

		expect(center.height).toBe(960);
		for (const source of document.nodes.slice(1)) {
			expect(rectanglesOverlap(source, center)).toBe(false);
		}
	});

	it.each([12, 20])("keeps all %i radial source nodes from overlapping", (sourceCount) => {
		const sourcePaths = Array.from({ length: sourceCount }, (_, index) => `Source ${index + 1}.md`);
		const document = buildInsightCanvas(card({ sourcePaths }), sourcePaths);
		const sources = document.nodes.slice(1);

		for (let first = 0; first < sources.length; first += 1) {
			for (let second = first + 1; second < sources.length; second += 1) {
				expect(rectanglesOverlap(sources[first], sources[second])).toBe(false);
			}
		}
	});

	it("includes only deduplicated card sources that the caller validated", () => {
		const document = buildInsightCanvas(card({
			sourcePaths: ["A.md", "Missing.md", "A.md", "B.md"],
		}), ["B.md", "A.md", "Unrelated.md"]);

		expect(document.nodes.slice(1).map((node) => (
			node.type === "file" ? node.file : ""
		))).toEqual(["A.md", "B.md"]);
		expect(document.edges).toHaveLength(2);
	});

	it("still produces a useful center node if every cited file was removed", () => {
		const document = buildInsightCanvas(card(), []);

		expect(document.nodes).toHaveLength(1);
		expect(document.edges).toEqual([]);
		expect(document.nodes[0]).toHaveProperty("text", expect.stringContaining("Evidence: 0 sources"));
	});

	it("serializes stable valid JSON", () => {
		const document = buildInsightCanvas(card(), ["Projects/Launch.md"]);
		const serialized = serializeInsightCanvas(document);

		expect(JSON.parse(serialized)).toEqual(document);
		expect(serialized).toBe(serializeInsightCanvas(document));
	});

	it("escapes model text before placing it in Markdown-rendered nodes", () => {
		const document = buildInsightCanvas(card({
			title: "Launch ![remote](https://example.com/pixel.png)",
			insight: "![[Private note]] <img src=https://example.com/pixel.png>",
			action: "Use `raw` [link](https://example.com)",
		}), ["Projects/Launch.md"]);
		const center = document.nodes[0];

		expect(center.type).toBe("text");
		if (center.type !== "text") {
			throw new Error("Expected a text node");
		}
		expect(center.text).not.toContain("![remote]");
		expect(center.text).not.toContain("![[Private note]]");
		expect(center.text).not.toContain("<img");
		expect(center.text).toContain("\\!\\[remote\\]");
		expect(center.text).toContain("&lt;img");
	});

	it("uses unique IDs, integer geometry, and referentially valid edges", () => {
		const document = buildInsightCanvas(card(), card().sourcePaths);
		const nodeIds = new Set(document.nodes.map((node) => node.id));

		expect(nodeIds.size).toBe(document.nodes.length);
		for (const node of document.nodes) {
			expect([node.x, node.y, node.width, node.height].every(Number.isInteger)).toBe(true);
		}
		for (const edge of document.edges) {
			expect(nodeIds.has(edge.fromNode)).toBe(true);
			expect(nodeIds.has(edge.toNode)).toBe(true);
		}
	});
});

function rectanglesOverlap(
	first: { x: number; y: number; width: number; height: number },
	second: { x: number; y: number; width: number; height: number },
): boolean {
	return first.x < second.x + second.width
		&& first.x + first.width > second.x
		&& first.y < second.y + second.height
		&& first.y + first.height > second.y;
}

describe("Insight Canvas paths", () => {
	it.each([
		["  Launch: plan?.canvas  ", "Launch plan"],
		["Launch #[plan]", "Launch plan"],
		["../..", "Vault Radar Insight"],
		["CON", "Insight - CON"],
		["Project   decision", "Project decision"],
	])("sanitizes %j to a portable filename", (input, expected) => {
		expect(sanitizeInsightCanvasFilename(input)).toBe(expected);
	});

	it("bounds long filenames by UTF-8 bytes while retaining unicode", () => {
		const sanitized = sanitizeInsightCanvasFilename(`🚀 ${"launch".repeat(40)}`);

		expect(sanitized.startsWith("🚀")).toBe(true);
		expect(new TextEncoder().encode(`${sanitized}.canvas`).length).toBeLessThanOrEqual(255);
	});

	it("does not split a trailing unicode code point at the byte limit", () => {
		const sanitized = sanitizeInsightCanvasFilename("🚀".repeat(97));

		expect(new TextEncoder().encode(`${sanitized}.canvas`).length).toBeLessThanOrEqual(255);
		expect(sanitized.endsWith("🚀")).toBe(true);
	});

	it("reserves UTF-8 bytes for collision suffixes and the extension", async () => {
		const path = await getCollisionSafeInsightCanvasPath(
			"Vault Radar Maps",
			"界".repeat(200),
			(candidate) => !candidate.endsWith(" 100.canvas"),
		);
		const pathParts = path.split("/");
		const filename = pathParts[pathParts.length - 1] || "";

		expect(filename.endsWith(" 100.canvas")).toBe(true);
		expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(255);
	});

	it("returns the first collision-free vault-relative path", async () => {
		const existing = new Set([
			"Vault Radar Maps/Launch plan.canvas",
			"Vault Radar Maps/Launch plan 2.canvas",
		]);
		const pathExists = vi.fn(async (path: string) => existing.has(path));

		await expect(getCollisionSafeInsightCanvasPath(
			"/Vault Radar Maps/",
			"Launch: plan",
			pathExists,
		)).resolves.toBe("Vault Radar Maps/Launch plan 3.canvas");
		expect(pathExists).toHaveBeenCalledTimes(3);
	});

	it("rejects a traversal folder", async () => {
		await expect(getCollisionSafeInsightCanvasPath(
			"Vault Radar Maps/../Private",
			"Launch plan",
			() => false,
		)).rejects.toThrow(/without traversal/i);
	});
});
