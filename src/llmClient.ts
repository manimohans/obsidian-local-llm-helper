import {
	buildOpenAIHeaders,
	buildOpenAIUrl,
	getChatApiKey,
	getChatCompletionsUrl,
	getChatModelsUrl,
	getEffectiveEmbeddingApiKey,
	getEffectiveEmbeddingServerAddress,
	getEmbeddingModelsUrl,
	type ModelEndpointTarget,
	type ProviderEndpointSettings,
} from "./providerSettings";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface CompletionRequest {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	maxTokens?: number;
	bufferedStream?: boolean;
	responseFormat?: "json_object";
}

export interface EmbeddingRequest {
	model: string;
	inputs: string[];
}

export interface LLMTransportRequest {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
}

export interface LLMTransportResponse {
	status: number;
	text: string;
}

export type LLMTransport = (request: LLMTransportRequest) => Promise<LLMTransportResponse>;

export type LLMOperation = "completion" | "embedding" | "models";

export type LLMErrorCode =
	| "configuration"
	| "authentication"
	| "invalid_request"
	| "rate_limit"
	| "timeout"
	| "network"
	| "server"
	| "invalid_response";

export class LLMClientError extends Error {
	constructor(
		public readonly code: LLMErrorCode,
		public readonly operation: LLMOperation,
		message: string,
		public readonly status?: number,
		public readonly retryable: boolean = false,
	) {
		super(message);
		this.name = "LLMClientError";
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

interface OpenAICompatibleClientOptions {
	completionTimeoutMs?: number;
	embeddingTimeoutMs?: number;
	modelsTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

interface RequestPolicy {
	operation: LLMOperation;
	timeoutMs: number;
	maxAttempts: number;
}

interface OpenAICompletionResponse {
	choices?: Array<{
		message?: {
			content?: unknown;
		};
	}>;
}

interface OpenAIStreamChunk {
	choices?: Array<{
		delta?: {
			content?: unknown;
		};
		message?: {
			content?: unknown;
		};
	}>;
}

interface OpenAIEmbeddingItem {
	index?: unknown;
	embedding?: unknown;
}

const DEFAULT_COMPLETION_TIMEOUT_MS = 120_000;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 60_000;
const DEFAULT_MODELS_TIMEOUT_MS = 15_000;

export class OpenAICompatibleClient {
	private readonly completionTimeoutMs: number;
	private readonly embeddingTimeoutMs: number;
	private readonly modelsTimeoutMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		private readonly getSettings: () => ProviderEndpointSettings,
		private readonly transport: LLMTransport,
		options: OpenAICompatibleClientOptions = {},
	) {
		this.completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
		this.embeddingTimeoutMs = options.embeddingTimeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
		this.modelsTimeoutMs = options.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
	}

	async complete(request: CompletionRequest): Promise<string> {
		const settings = this.getSettings();
		this.requireServer(settings.serverAddress, "completion");

		const body: Record<string, unknown> = {
			model: request.model,
			messages: request.messages,
		};
		if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}
		if (request.maxTokens !== undefined) {
			body.max_tokens = request.maxTokens;
		}
		if (request.bufferedStream !== undefined) {
			body.stream = request.bufferedStream;
		}
		if (request.responseFormat !== undefined) {
			body.response_format = { type: request.responseFormat };
		}

		const response = await this.requestWithPolicy(
			{
				url: getChatCompletionsUrl(settings),
				method: "POST",
				headers: buildOpenAIHeaders(getChatApiKey(settings)),
				body: JSON.stringify(body),
			},
			{
				operation: "completion",
				timeoutMs: this.completionTimeoutMs,
				maxAttempts: 1,
			},
		);

		return request.bufferedStream
			? this.parseBufferedCompletion(response.text)
			: this.parseCompletionJson(response.text);
	}

	async embed(request: EmbeddingRequest): Promise<number[][]> {
		if (request.inputs.length === 0) {
			return [];
		}

		const settings = this.getSettings();
		const serverAddress = getEffectiveEmbeddingServerAddress(settings);
		this.requireServer(serverAddress, "embedding");

		const response = await this.requestWithPolicy(
			{
				url: buildOpenAIUrl(serverAddress, "embeddings"),
				method: "POST",
				headers: buildOpenAIHeaders(getEffectiveEmbeddingApiKey(settings)),
				body: JSON.stringify({
					model: request.model,
					input: request.inputs,
					encoding_format: "float",
				}),
			},
			{
				operation: "embedding",
				timeoutMs: this.embeddingTimeoutMs,
				maxAttempts: 3,
			},
		);

		return this.parseEmbeddings(response.text, request.inputs.length);
	}

	async listModels(target: ModelEndpointTarget): Promise<string[]> {
		const settings = this.getSettings();
		const serverAddress = target === "embedding"
			? getEffectiveEmbeddingServerAddress(settings)
			: settings.serverAddress;
		this.requireServer(serverAddress, "models");

		const response = await this.requestWithPolicy(
			{
				url: target === "embedding"
					? getEmbeddingModelsUrl(settings)
					: getChatModelsUrl(settings),
				method: "GET",
				headers: buildOpenAIHeaders(
					target === "embedding"
						? getEffectiveEmbeddingApiKey(settings)
						: getChatApiKey(settings),
				),
			},
			{
				operation: "models",
				timeoutMs: this.modelsTimeoutMs,
				maxAttempts: 2,
			},
		);

		const data = this.parseJson(response.text, "models") as { data?: unknown };
		if (!Array.isArray(data?.data)) {
			throw this.invalidResponse("models", "The model server returned an unexpected model list.");
		}

		return data.data
			.map((model) => this.isRecord(model) ? model.id : undefined)
			.filter((id): id is string => typeof id === "string" && id.length > 0)
			.sort();
	}

	private async requestWithPolicy(
		request: LLMTransportRequest,
		policy: RequestPolicy,
	): Promise<LLMTransportResponse> {
		let lastError: LLMClientError | undefined;

		for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
			try {
				const response = await this.requestOnce(request, policy);
				if (response.status >= 200 && response.status < 300) {
					return response;
				}

				const error = this.fromHttpStatus(policy.operation, response.status);
				if (!error.retryable || attempt === policy.maxAttempts) {
					throw error;
				}
				lastError = error;
			} catch (error) {
				const clientError = error instanceof LLMClientError
					? error
					: new LLMClientError(
						"network",
						policy.operation,
						"Could not reach the configured model server.",
						undefined,
						true,
					);
				if (!clientError.retryable || attempt === policy.maxAttempts) {
					throw clientError;
				}
				lastError = clientError;
			}

			await this.sleep(500 * attempt);
		}

		throw lastError ?? new LLMClientError(
			"network",
			policy.operation,
			"The model request failed without a response.",
		);
	}

	private async requestOnce(
		request: LLMTransportRequest,
		policy: RequestPolicy,
	): Promise<LLMTransportResponse> {
		let timer: number | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => {
				reject(new LLMClientError(
					"timeout",
					policy.operation,
					this.timeoutMessage(policy.operation),
					408,
					true,
				));
			}, policy.timeoutMs);
		});

		try {
			return await Promise.race([this.transport(request), timeout]);
		} finally {
			if (timer !== undefined) {
				window.clearTimeout(timer);
			}
		}
	}

	private parseCompletionJson(text: string): string {
		const data = this.parseJson(text, "completion") as OpenAICompletionResponse;
		const content = data.choices?.[0]?.message?.content;
		if (typeof content !== "string") {
			throw this.invalidResponse("completion", "The model server returned no completion content.");
		}
		return content;
	}

	private parseBufferedCompletion(text: string): string {
		const chunks: string[] = [];
		let foundContentField = false;

		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) {
				continue;
			}

			const payload = trimmed.replace(/^data:\s*/, "");
			if (!payload || payload === "[DONE]") {
				continue;
			}

			try {
				const data = JSON.parse(payload) as OpenAIStreamChunk;
				const content = data.choices?.[0]?.delta?.content;
				if (typeof content === "string") {
					foundContentField = true;
					chunks.push(content);
				}
			} catch {
				// OpenAI-compatible servers may add non-JSON keep-alive data lines.
			}
		}

		if (foundContentField) {
			return chunks.join("");
		}

		try {
			const data = JSON.parse(text) as OpenAIStreamChunk;
			const content = data.choices?.[0]?.message?.content;
			if (typeof content === "string") {
				return content;
			}
		} catch {
			// Fall through to the consistent invalid-response error below.
		}

		throw this.invalidResponse("completion", "The model server returned an invalid buffered stream.");
	}

	private parseEmbeddings(text: string, inputCount: number): number[][] {
		const data = this.parseJson(text, "embedding") as { data?: unknown };
		if (!Array.isArray(data?.data)) {
			throw this.invalidResponse("embedding", "The embeddings response is missing its data array.");
		}
		if (data.data.length !== inputCount) {
			throw this.invalidResponse(
				"embedding",
				`The embeddings response returned ${data.data.length} vectors for ${inputCount} inputs.`,
			);
		}

		const items = data.data.map((value, position) => {
			if (!this.isRecord(value)) {
				throw this.invalidResponse("embedding", `Embedding ${position + 1} is malformed.`);
			}
			const item = value as OpenAIEmbeddingItem;
			if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
				throw this.invalidResponse("embedding", `Embedding ${position + 1} is missing its vector.`);
			}
			if (!item.embedding.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
				throw this.invalidResponse("embedding", `Embedding ${position + 1} contains non-numeric values.`);
			}

			return {
				position,
				index: typeof item.index === "number" && Number.isInteger(item.index)
					? item.index
					: undefined,
				vector: item.embedding as number[],
			};
		});

		const indexedItems = items.filter((item) => item.index !== undefined);
		if (indexedItems.length > 0) {
			if (indexedItems.length !== items.length) {
				throw this.invalidResponse("embedding", "Embedding indexes are only present on part of the response.");
			}
			const indexes = new Set(indexedItems.map((item) => item.index));
			if (
				indexes.size !== items.length ||
				indexedItems.some((item) => item.index! < 0 || item.index! >= inputCount)
			) {
				throw this.invalidResponse("embedding", "Embedding indexes are duplicated or out of range.");
			}
			items.sort((a, b) => a.index! - b.index!);
		} else {
			items.sort((a, b) => a.position - b.position);
		}

		return items.map((item) => item.vector);
	}

	private parseJson(text: string, operation: LLMOperation): unknown {
		try {
			return JSON.parse(text);
		} catch {
			throw new LLMClientError(
				"invalid_response",
				operation,
				"The model server returned invalid JSON.",
				undefined,
				false,
			);
		}
	}

	private fromHttpStatus(operation: LLMOperation, status: number): LLMClientError {
		if (status === 401 || status === 403) {
			return new LLMClientError(
				"authentication",
				operation,
				"Authentication failed. Check the configured API key.",
				status,
			);
		}
		if (status === 408) {
			return new LLMClientError("timeout", operation, this.timeoutMessage(operation), status, true);
		}
		if (status === 429) {
			return new LLMClientError(
				"rate_limit",
				operation,
				"The model server is rate-limiting requests. Try again shortly.",
				status,
				true,
			);
		}
		if (status >= 500) {
			const message = operation === "embedding" && status === 501
				? "The configured server does not support embeddings. Check the embedding server and model settings."
				: `The model server returned an error (HTTP ${status}).`;
			return new LLMClientError("server", operation, message, status, true);
		}
		if (status === 404) {
			const message = operation === "embedding"
				? "The embeddings endpoint was not found. Check the embedding server and loaded model."
				: "The configured model endpoint was not found.";
			return new LLMClientError("configuration", operation, message, status);
		}

		const message = operation === "embedding"
			? "The embeddings request was rejected. Check that an embedding model is loaded and its name matches settings."
			: `The model request was rejected (HTTP ${status}).`;
		return new LLMClientError("invalid_request", operation, message, status);
	}

	private timeoutMessage(operation: LLMOperation): string {
		if (operation === "completion") {
			return "The model server did not complete the request within 2 minutes.";
		}
		if (operation === "embedding") {
			return "The embeddings server did not respond within 60 seconds.";
		}
		return "The model server did not return its model list within 15 seconds.";
	}

	private requireServer(serverAddress: string, operation: LLMOperation): void {
		if (!serverAddress.trim()) {
			throw new LLMClientError(
				"configuration",
				operation,
				"Configure a model server URL before making this request.",
			);
		}
	}

	private invalidResponse(operation: LLMOperation, message: string): LLMClientError {
		return new LLMClientError("invalid_response", operation, message);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
}
