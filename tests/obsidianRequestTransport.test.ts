import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { obsidianRequestTransport } from "../src/obsidianRequestTransport";

vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

const requestUrlMock = vi.mocked(requestUrl);

describe("obsidianRequestTransport", () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
	});

	it("forwards requests with throw disabled and returns status plus text", async () => {
		requestUrlMock.mockResolvedValue({
			status: 202,
			text: "accepted",
			json: { ignored: true },
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
		});

		await expect(obsidianRequestTransport({
			url: "http://model.local/v1/models",
			method: "POST",
			headers: { Authorization: "Bearer secret" },
			body: "{}",
		})).resolves.toEqual({ status: 202, text: "accepted" });

		expect(requestUrlMock).toHaveBeenCalledWith({
			url: "http://model.local/v1/models",
			method: "POST",
			headers: { Authorization: "Bearer secret" },
			body: "{}",
			throw: false,
		});
	});
});
