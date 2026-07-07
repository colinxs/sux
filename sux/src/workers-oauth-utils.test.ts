import { describe, expect, it } from "vitest";
import {
	addApprovedClient,
	isClientApproved,
	OAuthError,
	validateCSRFToken,
} from "./workers-oauth-utils";

const SECRET = "test-cookie-secret";
const COOKIE_NAME = "__Host-APPROVED_CLIENTS";

function reqWithCookie(cookie?: string): Request {
	return new Request("https://mcp.example.com/authorize", {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

/** Pull the bare `name=value` out of a Set-Cookie header for re-sending. */
function cookiePair(setCookie: string): string {
	return setCookie.split(";")[0];
}

describe("approved-clients cookie (HMAC round-trip)", () => {
	it("accepts a cookie it just signed for the same client + secret", async () => {
		const setCookie = await addApprovedClient(reqWithCookie(), "client-A", SECRET);
		const back = reqWithCookie(cookiePair(setCookie));
		expect(await isClientApproved(back, "client-A", SECRET)).toBe(true);
		expect(await isClientApproved(back, "client-B", SECRET)).toBe(false);
	});

	it("rejects a cookie signed under a different secret (forgery guard)", async () => {
		const setCookie = await addApprovedClient(reqWithCookie(), "client-A", SECRET);
		const back = reqWithCookie(cookiePair(setCookie));
		expect(await isClientApproved(back, "client-A", "attacker-secret")).toBe(false);
	});

	it("rejects a tampered payload whose signature no longer matches", async () => {
		const setCookie = await addApprovedClient(reqWithCookie(), "client-A", SECRET);
		const value = cookiePair(setCookie).substring(COOKIE_NAME.length + 1);
		const [sig] = value.split(".");
		const forgedPayload = btoa(JSON.stringify(["client-A", "client-EVIL"]));
		const tampered = reqWithCookie(`${COOKIE_NAME}=${sig}.${forgedPayload}`);
		expect(await isClientApproved(tampered, "client-EVIL", SECRET)).toBe(false);
	});

	// Regression: atob() on a non-base64 payload segment used to throw an
	// uncaught exception up through the unauthenticated GET /authorize handler
	// (which has no try/catch). A malformed cookie must resolve to "not approved".
	it("treats a malformed (non-base64) cookie payload as not approved instead of throwing", async () => {
		const malformed = reqWithCookie(`${COOKIE_NAME}=deadbeef.not-valid-base64!!!`);
		await expect(isClientApproved(malformed, "client-A", SECRET)).resolves.toBe(false);
	});

	it("returns false (not throw) when no cookie is present at all", async () => {
		expect(await isClientApproved(reqWithCookie(), "client-A", SECRET)).toBe(false);
	});
});

describe("validateCSRFToken (one-time-use gate)", () => {
	function postReq(cookie?: string): Request {
		return new Request("https://mcp.example.com/authorize", {
			method: "POST",
			headers: cookie ? { Cookie: cookie } : {},
		});
	}

	it("passes when form token matches the cookie and returns a clearing cookie", () => {
		const form = new FormData();
		form.set("csrf_token", "tok-123");
		const { clearCookie } = validateCSRFToken(
			form,
			postReq("__Host-CSRF_TOKEN=tok-123"),
		);
		expect(clearCookie).toContain("__Host-CSRF_TOKEN=;");
		expect(clearCookie).toContain("Max-Age=0");
	});

	it("throws on a token mismatch", () => {
		const form = new FormData();
		form.set("csrf_token", "tok-123");
		expect(() => validateCSRFToken(form, postReq("__Host-CSRF_TOKEN=other"))).toThrow(
			OAuthError,
		);
	});

	it("throws when the cookie is missing", () => {
		const form = new FormData();
		form.set("csrf_token", "tok-123");
		expect(() => validateCSRFToken(form, postReq())).toThrow(OAuthError);
	});

	it("throws when the form token is missing", () => {
		const form = new FormData();
		expect(() => validateCSRFToken(form, postReq("__Host-CSRF_TOKEN=tok-123"))).toThrow(
			OAuthError,
		);
	});
});
