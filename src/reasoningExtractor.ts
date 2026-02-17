export interface ReasoningMarker {
	start: string;
	end: string;
}

export const DEFAULT_REASONING_MARKERS: ReasoningMarker[] = [
	{ start: "<think>", end: "</think>" },
	{ start: "<reasoning>", end: "</reasoning>" },
	{ start: "<thought>", end: "</thought>" },
];

/**
 * Strips reasoning/thinking blocks from LLM output.
 * Removes all content between matching marker pairs (including the markers).
 * Trims leading whitespace from the resulting string.
 */
export function extractActualResponse(content: string, markers: ReasoningMarker[]): string {
	let result = content;

	for (const marker of markers) {
		// Escape special regex characters in markers
		const startEsc = marker.start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const endEsc = marker.end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

		// Use dotAll (s) flag so . matches newlines
		const regex = new RegExp(`${startEsc}[\\s\\S]*?${endEsc}`, 'g');
		result = result.replace(regex, '');
	}

	return result.trimStart();
}

/**
 * Parses a JSON string of reasoning markers with fallback to defaults.
 */
export function parseReasoningMarkers(json: string): ReasoningMarker[] {
	try {
		const parsed = JSON.parse(json);
		if (Array.isArray(parsed) && parsed.every(m => m.start && m.end)) {
			return parsed;
		}
	} catch {
		// Fall through to defaults
	}
	return DEFAULT_REASONING_MARKERS;
}
