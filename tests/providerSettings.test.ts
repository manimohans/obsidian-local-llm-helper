import { describe, expect, it } from "vitest";
import {
	buildOpenAIHeaders,
	buildOpenAIUrl,
	getEffectiveEmbeddingApiKey,
	getEffectiveEmbeddingServerAddress,
	getOpenAIBaseUrl,
	normalizeServerAddress,
} from "../src/providerSettings";

describe("provider settings", () => {
	it("normalizes server URLs and avoids duplicate v1 paths", () => {
		expect(normalizeServerAddress(" localhost:11434/ ")).toBe("http://localhost:11434/");
		expect(getOpenAIBaseUrl("https://example.com/v1/")).toBe("https://example.com/v1");
		expect(buildOpenAIUrl("https://example.com", "/models")).toBe("https://example.com/v1/models");
	});

	it("inherits embedding connection values when overrides are blank", () => {
		const settings = {
			serverAddress: "http://chat.local",
			openAIApiKey: "chat-key",
			embeddingServerAddress: "",
			embeddingApiKey: "",
		};

		expect(getEffectiveEmbeddingServerAddress(settings)).toBe("http://chat.local");
		expect(getEffectiveEmbeddingApiKey(settings)).toBe("chat-key");
	});

	it("uses explicit embedding connection values", () => {
		const settings = {
			serverAddress: "http://chat.local",
			openAIApiKey: "chat-key",
			embeddingServerAddress: "http://embed.local/",
			embeddingApiKey: "embed-key",
		};

		expect(getEffectiveEmbeddingServerAddress(settings)).toBe("http://embed.local");
		expect(getEffectiveEmbeddingApiKey(settings)).toBe("embed-key");
	});

	it("omits authorization for blank and not-needed keys", () => {
		expect(buildOpenAIHeaders()).toEqual({ "Content-Type": "application/json" });
		expect(buildOpenAIHeaders("not-needed")).toEqual({ "Content-Type": "application/json" });
		expect(buildOpenAIHeaders(" secret ")).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer secret",
		});
	});
});
