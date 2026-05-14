export interface ProviderEndpointSettings {
	serverAddress: string;
	openAIApiKey?: string;
	embeddingServerAddress?: string;
	embeddingApiKey?: string;
}

export type ModelEndpointTarget = "chat" | "embedding";

export function normalizeServerAddress(address: string): string {
	const trimmed = address.trim();
	if (!trimmed) return trimmed;
	if (!/^https?:\/\//i.test(trimmed)) {
		return "http://" + trimmed;
	}
	return trimmed.replace(/\/+$/, "");
}

export function normalizeOptionalServerAddress(address?: string): string {
	return normalizeServerAddress(address || "");
}

export function getOpenAIBaseUrl(serverAddress: string): string {
	const normalized = normalizeServerAddress(serverAddress);
	if (!normalized) return normalized;
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function buildOpenAIUrl(serverAddress: string, path: string): string {
	const baseUrl = getOpenAIBaseUrl(serverAddress);
	const normalizedPath = path.replace(/^\/+/, "");
	return `${baseUrl}/${normalizedPath}`;
}

export function getChatApiKey(settings: ProviderEndpointSettings): string {
	return settings.openAIApiKey?.trim() || "";
}

export function getEffectiveEmbeddingApiKey(settings: ProviderEndpointSettings): string {
	const explicitEmbeddingKey = settings.embeddingApiKey?.trim();
	return explicitEmbeddingKey || getChatApiKey(settings);
}

export function shouldSendAuthorization(apiKey?: string): boolean {
	const trimmed = apiKey?.trim() || "";
	return trimmed !== "" && trimmed !== "not-needed";
}

export function buildOpenAIHeaders(apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (shouldSendAuthorization(apiKey)) {
		headers["Authorization"] = `Bearer ${apiKey?.trim()}`;
	}
	return headers;
}

export function getEffectiveEmbeddingServerAddress(settings: ProviderEndpointSettings): string {
	const embeddingServer = normalizeOptionalServerAddress(settings.embeddingServerAddress);
	return embeddingServer || normalizeServerAddress(settings.serverAddress);
}

export function getEffectiveEmbeddingBaseUrl(settings: ProviderEndpointSettings): string {
	return getOpenAIBaseUrl(getEffectiveEmbeddingServerAddress(settings));
}

export function getChatCompletionsUrl(settings: ProviderEndpointSettings): string {
	return buildOpenAIUrl(settings.serverAddress, "chat/completions");
}

export function getChatModelsUrl(settings: ProviderEndpointSettings): string {
	return buildOpenAIUrl(settings.serverAddress, "models");
}

export function getEmbeddingModelsUrl(settings: ProviderEndpointSettings): string {
	return buildOpenAIUrl(getEffectiveEmbeddingServerAddress(settings), "models");
}
