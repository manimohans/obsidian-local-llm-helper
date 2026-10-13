import type { VaultRadarInsightCard } from "./vaultRadar";

export type InsightCanvasSide = "top" | "right" | "bottom" | "left";

export const INSIGHT_CANVAS_FOLDER = "Vault Radar Maps";

export interface InsightCanvasTextNode {
	id: string;
	type: "text";
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
}

export interface InsightCanvasFileNode {
	id: string;
	type: "file";
	file: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export type InsightCanvasNode = InsightCanvasTextNode | InsightCanvasFileNode;

export interface InsightCanvasEdge {
	id: string;
	fromNode: string;
	fromSide: InsightCanvasSide;
	toNode: string;
	toSide: InsightCanvasSide;
	toEnd: "arrow";
	color?: string;
	label: string;
}

export interface InsightCanvasDocument {
	nodes: InsightCanvasNode[];
	edges: InsightCanvasEdge[];
}

export interface InsightCanvasBuildOptions {
	centerX?: number;
	centerY?: number;
	maxSources?: number;
}

export type InsightCanvasPathExists = (path: string) => boolean | Promise<boolean>;

const CENTER_WIDTH = 440;
const CENTER_MIN_HEIGHT = 420;
const CENTER_MAX_HEIGHT = 960;
const CENTER_WRAP_COLUMNS = 44;
const CENTER_LINE_HEIGHT = 22;
const CENTER_VERTICAL_PADDING = 80;
const CENTER_PARAGRAPH_GAP = 12;
const FILE_WIDTH = 300;
const FILE_HEIGHT = 300;
const MIN_RADIAL_RADIUS = 520;
const RADIAL_NODE_GAP = 60;
const DEFAULT_MAX_SOURCES = 20;
const MAX_FILENAME_BYTES = 255;
const CANVAS_EXTENSION = ".canvas";
const MAX_COLLISION_ATTEMPTS = 10_000;
const DEFAULT_FILENAME = "Vault Radar Insight";

export function buildInsightCanvas(
	card: VaultRadarInsightCard,
	existingSourcePaths: Iterable<string>,
	options: InsightCanvasBuildOptions = {},
): InsightCanvasDocument {
	const centerX = finiteNumberOr(options.centerX, 0);
	const centerY = finiteNumberOr(options.centerY, 0);
	const maxSources = clampInteger(options.maxSources, 1, 100, DEFAULT_MAX_SOURCES);
	const validatedPaths = new Set(normalizePaths(existingSourcePaths));
	const sourcePaths = normalizePaths(card.sourcePaths)
		.filter((path) => validatedPaths.has(path))
		.slice(0, maxSources);
	const documentKey = stableHash([
		card.fingerprint,
		card.id,
		card.title,
		...sourcePaths,
	].join("|"));
	const centerId = `insight-${documentKey}`;
	const centerText = buildCenterText(card, sourcePaths.length);
	const centerHeight = estimateCenterHeight(centerText);
	const centerNode: InsightCanvasTextNode = {
		id: centerId,
		type: "text",
		text: centerText,
		x: Math.round(centerX - CENTER_WIDTH / 2),
		y: Math.round(centerY - centerHeight / 2),
		width: CENTER_WIDTH,
		height: centerHeight,
		color: "6",
	};

	const nodes: InsightCanvasNode[] = [centerNode];
	const edges: InsightCanvasEdge[] = [];
	if (sourcePaths.length === 0) {
		return { nodes, edges };
	}

	const radius = Math.max(
		MIN_RADIAL_RADIUS,
		Math.ceil(
			Math.hypot(CENTER_WIDTH / 2, centerHeight / 2)
			+ Math.hypot(FILE_WIDTH / 2, FILE_HEIGHT / 2)
			+ RADIAL_NODE_GAP,
		),
		getSourceClearanceRadius(sourcePaths.length),
	);
	for (const [index, path] of sourcePaths.entries()) {
		const angle = 2 * Math.PI * index / sourcePaths.length;
		const nodeCenterX = centerX + radius * Math.cos(angle);
		const nodeCenterY = centerY + radius * Math.sin(angle);
		const sourceId = `${centerId}-source-${String(index + 1).padStart(2, "0")}`;
		nodes.push({
			id: sourceId,
			type: "file",
			file: path,
			x: Math.round(nodeCenterX - FILE_WIDTH / 2),
			y: Math.round(nodeCenterY - FILE_HEIGHT / 2),
			width: FILE_WIDTH,
			height: FILE_HEIGHT,
		});
		const sides = getEdgeSides(nodeCenterX - centerX, nodeCenterY - centerY);
		edges.push({
			id: `${centerId}-edge-${String(index + 1).padStart(2, "0")}`,
			fromNode: sourceId,
			fromSide: sides.source,
			toNode: centerId,
			toSide: sides.center,
			toEnd: "arrow",
			color: "6",
			label: "evidence",
		});
	}

	return { nodes, edges };
}

export function serializeInsightCanvas(document: InsightCanvasDocument): string {
	return JSON.stringify(document, null, 2);
}

export function sanitizeInsightCanvasFilename(title: string): string {
	const withoutExtension = title.trim().replace(/\.canvas$/i, "");
	let sanitized = withoutExtension
		.normalize("NFKC")
		.split("").map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("")
		.replace(/[<>:#"/\\|?*[\]]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^[. ]+|[. ]+$/g, "");
	if (!sanitized || sanitized === "." || sanitized === "..") {
		sanitized = DEFAULT_FILENAME;
	}
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)) {
		sanitized = `Insight - ${sanitized}`;
	}
	sanitized = truncateUtf8(
		sanitized,
		MAX_FILENAME_BYTES - utf8ByteLength(CANVAS_EXTENSION),
	)
		.replace(/[. ]+$/g, "");
	return sanitized || DEFAULT_FILENAME;
}

export async function getCollisionSafeInsightCanvasPath(
	folder: string,
	title: string,
	pathExists: InsightCanvasPathExists,
): Promise<string> {
	const normalizedFolder = normalizeFolder(folder);
	const baseName = sanitizeInsightCanvasFilename(title);
	for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
		const suffix = attempt === 1 ? "" : ` ${attempt}`;
		const availableBaseBytes = Math.max(
			1,
			MAX_FILENAME_BYTES - utf8ByteLength(suffix) - utf8ByteLength(CANVAS_EXTENSION),
		);
		const truncatedBase = truncateUtf8(baseName, availableBaseBytes)
			.replace(/[. ]+$/g, "") || truncateUtf8(DEFAULT_FILENAME, availableBaseBytes);
		const filename = `${truncatedBase}${suffix}${CANVAS_EXTENSION}`;
		const candidate = normalizedFolder ? `${normalizedFolder}/${filename}` : filename;
		if (!await pathExists(candidate)) {
			return candidate;
		}
	}
	throw new Error("Could not find an available Insight Canvas filename.");
}

function buildCenterText(card: VaultRadarInsightCard, sourceCount: number): string {
	const parts = [
		`# ${escapeMarkdownInline(card.title.trim() || "Vault Radar insight")}`,
		`**${formatInsightKind(card.kind)} · ${capitalize(card.confidence)} confidence**`,
		escapeMarkdownLiteral(card.insight.trim()),
	];
	if (card.action?.trim()) {
		parts.push(`## Best next action\n${escapeMarkdownLiteral(card.action.trim())}`);
	}
	parts.push(
		`Evidence: ${sourceCount} source${sourceCount === 1 ? "" : "s"}`,
	);
	return parts.join("\n\n");
}

function estimateCenterHeight(text: string): number {
	const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);
	const estimatedLines = paragraphs.reduce((total, paragraph) => (
		total + paragraph.split("\n").reduce((lineTotal, line) => (
			lineTotal + Math.max(1, Math.ceil(Array.from(line).length / CENTER_WRAP_COLUMNS))
		), 0)
	), 0);
	const paragraphSpacing = Math.max(0, paragraphs.length - 1) * CENTER_PARAGRAPH_GAP;
	const estimatedHeight = CENTER_VERTICAL_PADDING
		+ estimatedLines * CENTER_LINE_HEIGHT
		+ paragraphSpacing;
	const roundedHeight = Math.ceil(estimatedHeight / 20) * 20;
	return Math.min(CENTER_MAX_HEIGHT, Math.max(CENTER_MIN_HEIGHT, roundedHeight));
}

function escapeMarkdownInline(value: string): string {
	return escapeMarkdownLiteral(value.replace(/\s+/g, " ").trim());
}

function escapeMarkdownLiteral(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/[\\`*_[\]{}()#+\-.!|]/g, "\\$&");
}

function formatInsightKind(kind: VaultRadarInsightCard["kind"]): string {
	return capitalize(kind.replace(/_/g, " "));
}

function capitalize(value: string): string {
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function getEdgeSides(
	deltaX: number,
	deltaY: number,
): { source: InsightCanvasSide; center: InsightCanvasSide } {
	if (Math.abs(deltaX) >= Math.abs(deltaY)) {
		return deltaX >= 0
			? { source: "left", center: "right" }
			: { source: "right", center: "left" };
	}
	return deltaY >= 0
		? { source: "top", center: "bottom" }
		: { source: "bottom", center: "top" };
}

function getSourceClearanceRadius(sourceCount: number): number {
	if (sourceCount <= 1) {
		return 0;
	}
	const minimumChord = Math.hypot(FILE_WIDTH, FILE_HEIGHT) + RADIAL_NODE_GAP;
	return Math.ceil(minimumChord / (2 * Math.sin(Math.PI / sourceCount)));
}

function normalizePaths(paths: Iterable<string>): string[] {
	return Array.from(new Set(
		Array.from(paths)
			.filter((path) => path.trim().length > 0),
	));
}

function truncateUtf8(value: string, maxBytes: number): string {
	let result = "";
	let byteCount = 0;
	for (const character of value) {
		const characterBytes = utf8ByteLength(character);
		if (byteCount + characterBytes > maxBytes) {
			break;
		}
		result += character;
		byteCount += characterBytes;
	}
	return result;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function normalizeFolder(folder: string): string {
	const normalized = folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!normalized) {
		return "";
	}
	const parts = normalized.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error("Insight Canvas folder must be a vault-relative path without traversal segments.");
	}
	return parts.join("/");
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function finiteNumberOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInteger(
	value: number | undefined,
	minimum: number,
	maximum: number,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
