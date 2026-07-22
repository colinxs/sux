import { describe, expect, it, vi } from "vitest";
import {
	authPassed,
	getAllowlist,
	handleEmail,
	hasEmailIngest,
	MAX_EMAIL_BYTES,
	parseRawEmail,
	senderAllowed,
	setAllowlist,
	type EmailIngestDeps,
	type EmailIngestMessage,
} from "./_email_ingest";

function kvStub() {
	const map = new Map<string, string>();
	return { get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)) };
}
const env = (extra: Record<string, unknown> = {}) => ({ OAUTH_KV: kvStub(), ...extra }) as any;

const PASS_AUTH = "mx.example.net; spf=pass smtp.mailfrom=friend@example.com; dkim=pass header.d=example.com header.s=sel; dmarc=pass";

function fakeReader(bytes: Uint8Array) {
	let done = false;
	return {
		read: async () => {
			if (done) return { done: true, value: undefined };
			done = true;
			return { done: false, value: bytes };
		},
		cancel: async () => {},
	};
}

function buildMessage(opts: { from: string; to: string; body: string; headers?: Record<string, string>; rawSize?: number; getReaderSpy?: ReturnType<typeof vi.fn> }): EmailIngestMessage {
	const bytes = new TextEncoder().encode(opts.body);
	const getReader = opts.getReaderSpy ?? vi.fn(() => fakeReader(bytes));
	return {
		from: opts.from,
		to: opts.to,
		headers: new Headers(opts.headers ?? {}),
		raw: { getReader } as unknown as ReadableStream<Uint8Array>,
		rawSize: opts.rawSize ?? bytes.length,
		setReject: vi.fn(),
	};
}

function fakeDeps(): EmailIngestDeps & { ingestText: ReturnType<typeof vi.fn>; writeNote: ReturnType<typeof vi.fn>; putBlob: ReturnType<typeof vi.fn> } {
	return {
		ingestText: vi.fn(async () => ({ ok: true, note: "Inbox/2026-01-01 test-note.md" })),
		writeNote: vi.fn(async () => ({ ok: true })),
		putBlob: vi.fn(async (_env: unknown, bytes: Uint8Array) => ({ url: "https://suxos.net/s/abc123", sha256: "deadbeef", size: bytes.length })),
	};
}

describe("hasEmailIngest gating", () => {
	it("dormant without EMAIL_INGEST_ENABLED", () => {
		expect(hasEmailIngest(env())).toBe(false);
	});
	it("armed once the flag is set", () => {
		expect(hasEmailIngest(env({ EMAIL_INGEST_ENABLED: "1" }))).toBe(true);
	});
});

describe("authPassed", () => {
	it("passes when both spf=pass and dkim=pass are present", () => {
		expect(authPassed(new Headers({ "Authentication-Results": PASS_AUTH }))).toBe(true);
	});
	it("fails when the header is absent", () => {
		expect(authPassed(new Headers())).toBe(false);
	});
	it("fails when only spf passed", () => {
		expect(authPassed(new Headers({ "Authentication-Results": "mx.example.net; spf=pass; dkim=fail" }))).toBe(false);
	});
	it("fails when only dkim passed", () => {
		expect(authPassed(new Headers({ "Authentication-Results": "mx.example.net; spf=fail; dkim=pass" }))).toBe(false);
	});
});

describe("senderAllowed", () => {
	it("matches an exact address (case-insensitively)", () => {
		expect(senderAllowed("Friend@Example.com", ["friend@example.com"])).toBe(true);
	});
	it("matches a bare domain entry", () => {
		expect(senderAllowed("mom@family.example.com", ["family.example.com"])).toBe(true);
	});
	it("matches an @-prefixed domain entry", () => {
		expect(senderAllowed("mom@family.example.com", ["@family.example.com"])).toBe(true);
	});
	it("rejects a sender not on the list", () => {
		expect(senderAllowed("stranger@evil.com", ["friend@example.com", "family.example.com"])).toBe(false);
	});
});

describe("getAllowlist / setAllowlist", () => {
	it("round-trips through KV, normalized to lowercase", async () => {
		const e = env();
		await setAllowlist(e, "Vault@Suxos.net", ["Friend@Example.com"]);
		expect(await getAllowlist(e, "vault@suxos.net")).toEqual(["friend@example.com"]);
	});
	it("returns [] when nothing is configured", async () => {
		expect(await getAllowlist(env(), "vault@suxos.net")).toEqual([]);
	});
});

describe("parseRawEmail", () => {
	it("extracts a plain-text single-part body", () => {
		const raw = ["From: friend@example.com", "To: vault@suxos.net", "Subject: hi", "Content-Type: text/plain; charset=utf-8", "", "Hello from the field."].join("\r\n");
		expect(parseRawEmail(raw).text).toBe("Hello from the field.");
	});

	it("splits a multipart/mixed message into its text body and a base64 attachment", () => {
		const boundary = "BOUNDARY123";
		const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake pdf content");
		const b64 = Buffer.from(pdfBytes).toString("base64");
		const raw = [
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			"See attached.",
			`--${boundary}`,
			'Content-Type: application/pdf; name="doc.pdf"',
			'Content-Disposition: attachment; filename="doc.pdf"',
			"Content-Transfer-Encoding: base64",
			"",
			b64,
			`--${boundary}--`,
			"",
		].join("\r\n");
		const parsed = parseRawEmail(raw);
		expect(parsed.text).toBe("See attached.");
		expect(parsed.attachments).toHaveLength(1);
		expect(parsed.attachments[0].filename).toBe("doc.pdf");
		expect(parsed.attachments[0].contentType).toBe("application/pdf");
		expect(parsed.attachments[0].bytes).toEqual(pdfBytes);
	});
});

describe("handleEmail", () => {
	it("dormant ⇒ no-op without even checking the allowlist", async () => {
		const e = env();
		const message = buildMessage({ from: "friend@example.com", to: "vault@suxos.net", body: "hi", headers: { "Authentication-Results": PASS_AUTH } });
		const r = await handleEmail(message, e, fakeDeps());
		expect(r).toEqual({ action: "dormant" });
		expect(message.setReject).not.toHaveBeenCalled();
	});

	it("allowlisted sender + vault@ ⇒ ingests the text body with provenance folded in", async () => {
		const e = env({ EMAIL_INGEST_ENABLED: "1" });
		await setAllowlist(e, "vault@suxos.net", ["friend@example.com"]);
		const raw = ["Content-Type: text/plain; charset=utf-8", "", "Hello from the field."].join("\r\n");
		const message = buildMessage({
			from: "friend@example.com",
			to: "vault@suxos.net",
			body: raw,
			headers: { "Authentication-Results": PASS_AUTH, "Message-ID": "<abc@example.com>", Subject: "Test note", Date: "Mon, 01 Jan 2026 00:00:00 +0000" },
		});
		const deps = fakeDeps();
		const r = await handleEmail(message, e, deps);
		expect(r).toEqual({ action: "ingested_vault", note: "Inbox/2026-01-01 test-note.md" });
		expect(message.setReject).not.toHaveBeenCalled();
		expect(deps.ingestText).toHaveBeenCalledTimes(1);
		const args = deps.ingestText.mock.calls[0][1];
		expect(args.title).toBe("Test note");
		expect(args.tags).toContain("email");
		expect(args.text).toContain("**From:** friend@example.com");
		expect(args.text).toContain("**Message-ID:** <abc@example.com>");
		expect(args.text).toContain("Hello from the field.");
		expect(deps.writeNote).not.toHaveBeenCalled();
		expect(deps.putBlob).not.toHaveBeenCalled();
	});

	it("unknown sender ⇒ rejected + ledgered, never ingested", async () => {
		const e = env({ EMAIL_INGEST_ENABLED: "1" });
		await setAllowlist(e, "vault@suxos.net", ["friend@example.com"]);
		const message = buildMessage({
			from: "stranger@evil.com",
			to: "vault@suxos.net",
			body: "Content-Type: text/plain\r\n\r\nhi",
			headers: { "Authentication-Results": PASS_AUTH, "Message-ID": "<evil1@evil.com>" },
		});
		const deps = fakeDeps();
		const r = await handleEmail(message, e, deps);
		expect(r).toMatchObject({ action: "rejected" });
		expect((r as { reason: string }).reason).toContain("not allowlisted");
		expect(message.setReject).toHaveBeenCalledTimes(1);
		expect(deps.ingestText).not.toHaveBeenCalled();
		expect(deps.writeNote).not.toHaveBeenCalled();
		expect(await e.OAUTH_KV.get("sux:ledger:email_ingest_rejected:<evil1@evil.com>")).toBeTruthy();
	});

	it("missing/failing auth ⇒ rejected before the allowlist is even consulted", async () => {
		const e = env({ EMAIL_INGEST_ENABLED: "1" });
		await setAllowlist(e, "vault@suxos.net", ["friend@example.com"]);
		const message = buildMessage({ from: "friend@example.com", to: "vault@suxos.net", body: "Content-Type: text/plain\r\n\r\nhi" });
		const r = await handleEmail(message, e);
		expect(r).toMatchObject({ action: "rejected" });
		expect((r as { reason: string }).reason.toLowerCase()).toContain("auth");
		expect(message.setReject).toHaveBeenCalledTimes(1);
	});

	it("unrecognized recipient local-part ⇒ rejected", async () => {
		const e = env({ EMAIL_INGEST_ENABLED: "1" });
		const message = buildMessage({
			from: "friend@example.com",
			to: "other@suxos.net",
			body: "Content-Type: text/plain\r\n\r\nhi",
			headers: { "Authentication-Results": PASS_AUTH },
		});
		const r = await handleEmail(message, e);
		expect(r).toMatchObject({ action: "rejected" });
		expect((r as { reason: string }).reason).toContain("unrecognized recipient");
	});

	it("files@ with an attachment ⇒ R2 putBlob + a ref-note, no raw bytes in the note", async () => {
		const e = env({ EMAIL_INGEST_ENABLED: "1" });
		await setAllowlist(e, "files@suxos.net", ["family.example.com"]);
		const boundary = "BOUNDARY123";
		const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake pdf content");
		const b64 = Buffer.from(pdfBytes).toString("base64");
		const raw = [
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Scanned doc attached.",
			`--${boundary}`,
			'Content-Type: application/pdf; name="doc.pdf"',
			'Content-Disposition: attachment; filename="doc.pdf"',
			"Content-Transfer-Encoding: base64",
			"",
			b64,
			`--${boundary}--`,
			"",
		].join("\r\n");
		const message = buildMessage({
			from: "mom@family.example.com",
			to: "files@suxos.net",
			body: raw,
			headers: { "Authentication-Results": PASS_AUTH, "Message-ID": "<scan1@family.example.com>", Subject: "Scan" },
		});
		const deps = fakeDeps();
		const r = await handleEmail(message, e, deps);
		expect(r).toMatchObject({ action: "ingested_files", attachments: 1 });
		expect(message.setReject).not.toHaveBeenCalled();
		expect(deps.putBlob).toHaveBeenCalledTimes(1);
		const [, blobBytes, contentType] = deps.putBlob.mock.calls[0];
		expect(blobBytes).toEqual(pdfBytes);
		expect(contentType).toBe("application/pdf");
		expect(deps.writeNote).toHaveBeenCalledTimes(1);
		const noteContent = deps.writeNote.mock.calls[0][2];
		expect(noteContent).toContain("Scanned doc attached.");
		expect(noteContent).toContain("[doc.pdf](https://suxos.net/s/abc123)");
		expect(noteContent).not.toContain(b64);
	});

	it("files@ with no attachments ⇒ a clean error, not a crash", async () => {
		const e = env({ EMAIL_INGEST_ENABLED: "1" });
		await setAllowlist(e, "files@suxos.net", ["family.example.com"]);
		const message = buildMessage({
			from: "mom@family.example.com",
			to: "files@suxos.net",
			body: "Content-Type: text/plain\r\n\r\nno attachment here",
			headers: { "Authentication-Results": PASS_AUTH },
		});
		const r = await handleEmail(message, e, fakeDeps());
		expect(r).toMatchObject({ action: "error" });
		expect(message.setReject).not.toHaveBeenCalled();
	});

	it("oversized message ⇒ rejected cleanly WITHOUT ever reading the raw stream", async () => {
		const e = env({ EMAIL_INGEST_ENABLED: "1" });
		await setAllowlist(e, "vault@suxos.net", ["friend@example.com"]);
		const getReaderSpy = vi.fn(() => fakeReader(new Uint8Array()));
		const message = buildMessage({
			from: "friend@example.com",
			to: "vault@suxos.net",
			body: "Content-Type: text/plain\r\n\r\nhi",
			headers: { "Authentication-Results": PASS_AUTH },
			rawSize: MAX_EMAIL_BYTES + 1,
			getReaderSpy,
		});
		const r = await handleEmail(message, e, fakeDeps());
		expect(r).toMatchObject({ action: "rejected" });
		expect((r as { reason: string }).reason).toContain("too large");
		expect(message.setReject).toHaveBeenCalledTimes(1);
		expect(getReaderSpy).not.toHaveBeenCalled();
	});
});
