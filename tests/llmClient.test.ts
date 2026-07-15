import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LLMClientError,
	OpenAICompatibleClient,
	type LLMTransport,
	type LLMTransportRequest,
	type LLMTransportResponse,
} from "../src/llmClient";
import type { ProviderEndpointSettings } from "../src/providerSettings";

function createSettings(overrides: Partial<ProviderEndpointSettings> = {}): ProviderEndpointSettings {
	return {
		serverAddress: "http://chat.local",
		openAIApiKey: "chat-secret",
		embeddingServerAddress: "http://embed.local/v1",
		embeddingApiKey: "embed-secret",
		...overrides,
	};
}

function response(status: number, body: unknown): LLMTransportResponse {
	return {
		status,
		text: typeof body === "string" ? body : JSON.stringify(body),
	};
}

function completionBody(content: string): LLMTransportResponse {
	return response(200, { choices: [{ message: { content } }] });
}

function completionRequest() {
	return {
		model: "chat-model",
		messages: [{ role: "user" as const, content: "Hello" }],
		temperature: 0.4,
		maxTokens: 321,
		bufferedStream: false,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("OpenAICompatibleClient completions", () => {
	it("builds a chat completion request and preserves explicit options", async () => {
		const requests: LLMTransportRequest[] = [];
		const transport: LLMTransport = vi.fn(async (request) => {
			requests.push(request);
			return completionBody("Answer");
		});
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.complete(completionRequest())).resolves.toBe("Answer");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: "http://chat.local/v1/chat/completions",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer chat-secret",
			},
		});
		expect(JSON.parse(requests[0].body || "{}")).toEqual({
			model: "chat-model",
			messages: [{ role: "user", content: "Hello" }],
			temperature: 0.4,
			max_tokens: 321,
			stream: false,
		});
	});

	it("adds OpenAI-compatible JSON object mode when requested", async () => {
		const transport = vi.fn(async (_request: LLMTransportRequest) => completionBody('{"cards":[]}'));
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await client.complete({
			...completionRequest(),
			responseFormat: "json_object",
		});

		const request = transport.mock.calls[0][0] as LLMTransportRequest;
		expect(JSON.parse(request.body || "{}").response_format).toEqual({
			type: "json_object",
		});
	});

	it("omits optional completion fields and accepts empty content", async () => {
		const transport = vi.fn(async (_request: LLMTransportRequest) => completionBody(""));
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.complete({
			model: "chat-model",
			messages: [{ role: "user", content: "Hello" }],
		})).resolves.toBe("");
		const request = transport.mock.calls[0][0] as LLMTransportRequest;
		expect(JSON.parse(request.body || "{}")).toEqual({
			model: "chat-model",
			messages: [{ role: "user", content: "Hello" }],
		});
	});

	it("parses buffered SSE while ignoring keep-alives and malformed data", async () => {
		const sse = [
			": keep-alive",
			"data: not-json",
			'data: {"choices":[{"delta":{"content":"Hel"}}]}',
			'data: {"choices":[{"delta":{"content":"lo"}}]}',
			"data: [DONE]",
		].join("\n");
		const client = new OpenAICompatibleClient(
			() => createSettings(),
			vi.fn(async () => response(200, sse)),
		);

		await expect(client.complete({
			...completionRequest(),
			bufferedStream: true,
		})).resolves.toBe("Hello");
	});

	it("supports buffered JSON fallback and empty SSE content", async () => {
		const transport = vi.fn()
			.mockResolvedValueOnce(completionBody("Fallback"))
			.mockResolvedValueOnce(response(200, 'data: {"choices":[{"delta":{"content":""}}]}\ndata: [DONE]'));
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.complete({ ...completionRequest(), bufferedStream: true })).resolves.toBe("Fallback");
		await expect(client.complete({ ...completionRequest(), bufferedStream: true })).resolves.toBe("");
	});

	it("rejects malformed completion responses", async () => {
		const transport = vi.fn()
			.mockResolvedValueOnce(response(200, "not-json"))
			.mockResolvedValueOnce(response(200, { choices: [{}] }))
			.mockResolvedValueOnce(response(200, "data: invalid\ndata: [DONE]"));
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.complete(completionRequest())).rejects.toMatchObject({ code: "invalid_response" });
		await expect(client.complete(completionRequest())).rejects.toMatchObject({ code: "invalid_response" });
		await expect(client.complete({ ...completionRequest(), bufferedStream: true })).rejects.toMatchObject({ code: "invalid_response" });
	});

	it.each([
		[400, "invalid_request"],
		[401, "authentication"],
		[403, "authentication"],
		[404, "configuration"],
		[408, "timeout"],
		[429, "rate_limit"],
		[500, "server"],
	])("maps HTTP %i to %s without retrying generation", async (status, code) => {
		const transport = vi.fn(async () => response(status, { error: "private provider detail" }));
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.complete(completionRequest())).rejects.toMatchObject({ code, status });
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("maps transport failures without exposing their details", async () => {
		const transport = vi.fn(async () => {
			throw new Error("request contained secret material");
		});
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		let caughtError: unknown;
		try {
			await client.complete(completionRequest());
		} catch (error) {
			caughtError = error;
		}
		expect(caughtError).toMatchObject({ code: "network", operation: "completion" });
		expect((caughtError as LLMClientError).message).not.toContain("secret material");
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("times out generation once without retrying", async () => {
		vi.useFakeTimers();
		const transport = vi.fn(() => new Promise<LLMTransportResponse>(() => undefined));
		const client = new OpenAICompatibleClient(() => createSettings(), transport, {
			completionTimeoutMs: 10,
		});

		const pending = client.complete(completionRequest());
		const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await vi.runAllTimersAsync();
		await assertion;
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("uses settings from the getter for every request", async () => {
		let settings = createSettings();
		const requests: LLMTransportRequest[] = [];
		const transport = vi.fn(async (request: LLMTransportRequest) => {
			requests.push(request);
			return completionBody("ok");
		});
		const client = new OpenAICompatibleClient(() => settings, transport);

		await client.complete(completionRequest());
		settings = createSettings({ serverAddress: "http://new-chat.local/v1", openAIApiKey: "new-key" });
		await client.complete(completionRequest());

		expect(requests[1].url).toBe("http://new-chat.local/v1/chat/completions");
		expect(requests[1].headers.Authorization).toBe("Bearer new-key");
	});

	it("rejects missing server configuration before transport", async () => {
		const transport = vi.fn();
		const client = new OpenAICompatibleClient(
			() => createSettings({ serverAddress: "" }),
			transport,
		);

		await expect(client.complete(completionRequest())).rejects.toMatchObject({ code: "configuration" });
		expect(transport).not.toHaveBeenCalled();
	});
});

describe("OpenAICompatibleClient model discovery", () => {
	it("uses separate chat and embedding endpoints and suppresses not-needed auth", async () => {
		const requests: LLMTransportRequest[] = [];
		const transport = vi.fn(async (request: LLMTransportRequest) => {
			requests.push(request);
			return response(200, { data: [{ id: "zeta" }, { id: "alpha" }, {}] });
		});
		const client = new OpenAICompatibleClient(
			() => createSettings({ embeddingApiKey: "not-needed" }),
			transport,
		);

		await expect(client.listModels("chat")).resolves.toEqual(["alpha", "zeta"]);
		await expect(client.listModels("embedding")).resolves.toEqual(["alpha", "zeta"]);
		expect(requests[0]).toMatchObject({
			url: "http://chat.local/v1/models",
			headers: { Authorization: "Bearer chat-secret" },
		});
		expect(requests[1].url).toBe("http://embed.local/v1/models");
		expect(requests[1].headers).not.toHaveProperty("Authorization");
	});

	it("retries one transient model-list failure", async () => {
		const transport = vi.fn()
			.mockResolvedValueOnce(response(500, {}))
			.mockResolvedValueOnce(response(200, { data: [{ id: "model" }] }));
		const sleep = vi.fn(async () => undefined);
		const client = new OpenAICompatibleClient(() => createSettings(), transport, { sleep });

		await expect(client.listModels("chat")).resolves.toEqual(["model"]);
		expect(transport).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(500);
	});

	it("does not retry non-transient model-list failures", async () => {
		const transport = vi.fn(async () => response(400, {}));
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.listModels("chat")).rejects.toMatchObject({ code: "invalid_request" });
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("retries a model-list transport failure once", async () => {
		const transport = vi.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(response(200, { data: [{ id: "model" }] }));
		const sleep = vi.fn(async () => undefined);
		const client = new OpenAICompatibleClient(() => createSettings(), transport, { sleep });

		await expect(client.listModels("chat")).resolves.toEqual(["model"]);
		expect(transport).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(500);
	});

	it("rejects malformed model-list responses", async () => {
		const client = new OpenAICompatibleClient(
			() => createSettings(),
			vi.fn(async () => response(200, { models: [] })),
		);

		await expect(client.listModels("chat")).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("times out model discovery twice", async () => {
		vi.useFakeTimers();
		const transport = vi.fn(() => new Promise<LLMTransportResponse>(() => undefined));
		const client = new OpenAICompatibleClient(() => createSettings(), transport, {
			modelsTimeoutMs: 10,
		});

		const pending = client.listModels("chat");
		const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await vi.runAllTimersAsync();
		await assertion;
		expect(transport).toHaveBeenCalledTimes(2);
	});
});

describe("OpenAICompatibleClient embeddings", () => {
	it("returns immediately for empty input", async () => {
		const transport = vi.fn();
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.embed({ model: "embed-model", inputs: [] })).resolves.toEqual([]);
		expect(transport).not.toHaveBeenCalled();
	});

	it("uses the embedding connection, requests floats, and restores index order", async () => {
		const requests: LLMTransportRequest[] = [];
		const transport = vi.fn(async (request: LLMTransportRequest) => {
			requests.push(request);
			return response(200, {
				data: [
					{ index: 1, embedding: [3, 4] },
					{ index: 0, embedding: [1, 2] },
				],
			});
		});
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.embed({ model: "embed-model", inputs: ["a", "b"] }))
			.resolves.toEqual([[1, 2], [3, 4]]);
		expect(requests[0]).toMatchObject({
			url: "http://embed.local/v1/embeddings",
			headers: { Authorization: "Bearer embed-secret" },
		});
		expect(JSON.parse(requests[0].body || "{}")).toEqual({
			model: "embed-model",
			input: ["a", "b"],
			encoding_format: "float",
		});
	});

	it("preserves response order when indexes are omitted", async () => {
		const client = new OpenAICompatibleClient(
			() => createSettings(),
			vi.fn(async () => response(200, { data: [{ embedding: [1] }, { embedding: [2] }] })),
		);

		await expect(client.embed({ model: "embed-model", inputs: ["a", "b"] }))
			.resolves.toEqual([[1], [2]]);
	});

	it.each([
		[{ data: [] }, "returned 0 vectors"],
		[{ data: [{ index: 0 }] }, "missing its vector"],
		[{ data: [{ index: 0, embedding: [Number.NaN] }] }, "non-numeric values"],
		[{ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }, "duplicated or out of range"],
		[{ data: [{ index: 0, embedding: [1] }, { embedding: [2] }] }, "only present on part"],
	])("rejects malformed embedding payloads", async (body, message) => {
		const inputCount = Array.isArray(body.data) && body.data.length === 2 ? 2 : 1;
		const client = new OpenAICompatibleClient(
			() => createSettings(),
			vi.fn(async () => response(200, body)),
		);

		await expect(client.embed({
			model: "embed-model",
			inputs: new Array(inputCount).fill("input"),
		})).rejects.toMatchObject({ code: "invalid_response", message: expect.stringContaining(message) });
	});

	it("retries two transient embedding failures with fixed backoff", async () => {
		const transport = vi.fn()
			.mockResolvedValueOnce(response(500, {}))
			.mockResolvedValueOnce(response(429, {}))
			.mockResolvedValueOnce(response(200, { data: [{ index: 0, embedding: [1, 2] }] }));
		const sleep = vi.fn(async () => undefined);
		const client = new OpenAICompatibleClient(() => createSettings(), transport, { sleep });

		await expect(client.embed({ model: "embed-model", inputs: ["a"] })).resolves.toEqual([[1, 2]]);
		expect(transport).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls).toEqual([[500], [1000]]);
	});

	it("does not retry a rejected embedding request", async () => {
		const transport = vi.fn(async () => response(400, {}));
		const client = new OpenAICompatibleClient(() => createSettings(), transport);

		await expect(client.embed({ model: "embed-model", inputs: ["a"] }))
			.rejects.toMatchObject({ code: "invalid_request" });
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("times out embeddings three times", async () => {
		vi.useFakeTimers();
		const transport = vi.fn(() => new Promise<LLMTransportResponse>(() => undefined));
		const client = new OpenAICompatibleClient(() => createSettings(), transport, {
			embeddingTimeoutMs: 10,
		});

		const pending = client.embed({ model: "embed-model", inputs: ["a"] });
		const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await vi.runAllTimersAsync();
		await assertion;
		expect(transport).toHaveBeenCalledTimes(3);
	});
});
