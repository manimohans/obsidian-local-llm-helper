import { requestUrl } from "obsidian";
import type { LLMTransport } from "./llmClient";

export const obsidianRequestTransport: LLMTransport = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});

	return {
		status: response.status,
		text: response.text,
	};
};
