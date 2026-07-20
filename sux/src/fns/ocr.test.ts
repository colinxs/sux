import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	MODELS: { vision: "@cf/meta/llama-3.2-11b-vision-instruct" },
	aiGatewayOptions: (env: any) => (env?.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined),
}));

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 })),
}));

import { ocr } from "./ocr";
import { smartFetch } from "../proxy";

afterEach(() => vi.clearAllMocks());

describe("ocr", () => {
	it("fails without the AI binding", async () => {
		const r = await ocr.run({} as any, { image: btoa("x") });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("requires url or image", async () => {
		const r = await ocr.run({ AI: { run: vi.fn() } } as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `url` or `image`/);
	});

	it("decodes base64 image bytes and returns extracted text", async () => {
		const run = vi.fn(async () => ({ response: "hello from image" }));
		const env = { AI: { run } } as any;
		const b64 = btoa(String.fromCharCode(1, 2, 3));
		const r = await ocr.run(env, { image: b64 });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("hello from image");
		expect(run).toHaveBeenCalledWith("@cf/meta/llama-3.2-11b-vision-instruct", expect.objectContaining({ image: [1, 2, 3] }), undefined);
		expect(smartFetch).not.toHaveBeenCalled();
	});

	it("fetches a url via the proxy for image bytes", async () => {
		const run = vi.fn(async () => ({ description: "text from url" }));
		const env = { AI: { run } } as any;
		const r = await ocr.run(env, { url: "https://example.com/a.png" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("text from url");
		expect(smartFetch).toHaveBeenCalled();
		expect((run as any).mock.calls[0][1].image).toEqual([1, 2, 3]);
	});

	it("rejects a non-http url", async () => {
		const r = await ocr.run({ AI: { run: vi.fn() } } as any, { url: "ftp://nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});
});
