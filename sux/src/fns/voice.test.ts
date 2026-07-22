import { afterEach, describe, expect, it, vi } from "vitest";
import { voice } from "./voice";
import { DATA_CLOSE, DATA_OPEN } from "../ai";

// We exercise the REAL guarded llm() (from ../ai) and only stub env.AI.run +
// OAUTH_KV — so the assertions see the actual <<<DATA>>> fence wrapUntrusted()
// puts around the untrusted `text`, and the real system/user message split.

function makeEnv(overrides: Record<string, unknown> = {}) {
	const run = vi.fn(async () => ({ response: "The restyled output." }));
	const kv = { get: vi.fn(async () => null as string | null) };
	return { env: { AI: { run }, OAUTH_KV: kv, ...overrides } as any, run, kv };
}

/** The user-role message (2nd) carries the fenced untrusted text; system is 1st. */
function messages(run: ReturnType<typeof vi.fn>) {
	const [, inputs] = run.mock.calls[0];
	const msgs = (inputs as any).messages as Array<{ role: string; content: string }>;
	return { system: msgs.find((m) => m.role === "system")!.content, user: msgs.find((m) => m.role === "user")!.content };
}

afterEach(() => vi.clearAllMocks());

describe("voice", () => {
	it("fails without the AI binding", async () => {
		const r = await voice.run({} as any, { text: "hi", style: "professional" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
	});

	it("requires text", async () => {
		const { env, run } = makeEnv();
		const r = await voice.run(env, { style: "professional" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(run).not.toHaveBeenCalled();
	});

	it("applies the default house voice (Elements of Style) when no style or profile is given", async () => {
		const { env, run } = makeEnv();
		const r = await voice.run(env, { text: "some text to restyle" });
		expect(r.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
		const { system } = messages(run);
		expect(system).toMatch(/Omit needless words/);
		expect(system).toMatch(/active voice/);
	});

	it("builds a restyle prompt with the style and fences the untrusted text as DATA", async () => {
		const { env, run } = makeEnv();
		const r = await voice.run(env, { text: "yo whats good", style: "professional" });
		expect(r.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
		const { system, user } = messages(run);
		// The restyle instruction + target style live in the (trusted) system role.
		expect(system).toMatch(/restyler/i);
		expect(system).toContain("Target style: professional.");
		// The untrusted text is fenced between the DATA markers in the user role.
		expect(user).toContain(DATA_OPEN);
		expect(user).toContain(DATA_CLOSE);
		expect(user).toContain("yo whats good");
	});

	it("honors strength=light in the prompt", async () => {
		const { env, run } = makeEnv();
		await voice.run(env, { text: "hello there", style: "casual", strength: "light" });
		expect(messages(run).system).toMatch(/light touch/i);
	});

	it("folds a profile's distilled_spec and examples from KV into the prompt", async () => {
		const { env, run, kv } = makeEnv();
		kv.get.mockResolvedValueOnce(
			JSON.stringify({
				name: "colin",
				distilled_spec: "Terse. No hedging. Lowercase openers.",
				examples: ["ship it. tests green.", { after: "done — merged to main." }, "third one", "fourth is dropped"],
			}),
		);
		const r = await voice.run(env, { text: "The deployment has been completed successfully.", profile: "colin" });
		expect(r.isError).toBeFalsy();
		expect(kv.get).toHaveBeenCalledWith("sux:prefs:colin");
		const { system, user } = messages(run);
		expect(system).toContain("Terse. No hedging. Lowercase openers.");
		expect(system).toContain("ship it. tests green.");
		expect(system).toContain("done — merged to main."); // object example, `after` field
		// Few-shot capped at ~3 — the fourth example is dropped.
		expect(system).not.toContain("fourth is dropped");
		// text is still the fenced untrusted DATA, not the system spec.
		expect(user).toContain("The deployment has been completed successfully.");
	});

	it("degrades gracefully when the named profile is absent in KV", async () => {
		const { env, run, kv } = makeEnv();
		kv.get.mockResolvedValueOnce(null);
		const r = await voice.run(env, { text: "restyle me", profile: "ghost", style: "brief" });
		expect(r.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
		const { system } = messages(run);
		expect(system).toContain("Target style: brief.");
		expect(system).toMatch(/profile "ghost" was not found/i);
	});

	it("passes through the model output verbatim", async () => {
		const { env } = makeEnv();
		const r = await voice.run(env, { text: "input text", style: "friendly" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("The restyled output.");
	});

	it("folds a single framework lens into the system prompt", async () => {
		const { env, run } = makeEnv();
		const r = await voice.run(env, { text: "we need to talk about the deadline", framework: "nvc" });
		expect(r.isError).toBeFalsy();
		const { system } = messages(run);
		expect(system).toMatch(/Apply this lens \(nvc v1\)/);
		expect(system).toMatch(/Nonviolent Communication/);
	});

	it("folds multiple framework lenses, in order, alongside style and profile guidance", async () => {
		const { env, run } = makeEnv();
		const r = await voice.run(env, { text: "let's negotiate the contract", style: "professional", framework: ["principled-negotiation", "cialdini"] });
		expect(r.isError).toBeFalsy();
		const { system } = messages(run);
		expect(system).toContain("Target style: professional.");
		const negIdx = system.indexOf("principled-negotiation");
		const cialdiniIdx = system.indexOf("cialdini");
		expect(negIdx).toBeGreaterThan(-1);
		expect(cialdiniIdx).toBeGreaterThan(negIdx);
	});

	it("skips an unknown framework name without throwing", async () => {
		const { env, run } = makeEnv();
		const r = await voice.run(env, { text: "hello", framework: "not-a-real-lens" });
		expect(r.isError).toBeFalsy();
		const { system } = messages(run);
		expect(system).toMatch(/Framework "not-a-real-lens" was not found/);
	});

	it("fails when the model returns an empty result", async () => {
		const { env, run } = makeEnv();
		run.mockResolvedValueOnce({ response: "   " });
		const r = await voice.run(env, { text: "input", style: "brief" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
	});
});
