import { describe, expect, it } from "vitest";
import { githubAuthHeaders } from "./github-auth";

const TOK = { GITHUB_TOKEN: "t0ken" };

describe("githubAuthHeaders", () => {
	it("injects the bearer header for github.com", () => {
		expect(githubAuthHeaders(TOK, "https://github.com/owner/repo")).toEqual({ Authorization: "Bearer t0ken" });
	});

	it("injects for api.github.com and *.githubusercontent.com subdomains", () => {
		expect(githubAuthHeaders(TOK, "https://api.github.com/repos/a/b")).toEqual({ Authorization: "Bearer t0ken" });
		expect(githubAuthHeaders(TOK, "https://raw.githubusercontent.com/a/b/main/f")).toEqual({ Authorization: "Bearer t0ken" });
	});

	it("never injects for a non-github host", () => {
		expect(githubAuthHeaders(TOK, "https://example.com/github.com")).toEqual({});
		expect(githubAuthHeaders(TOK, "https://evilgithub.com/x")).toEqual({});
	});

	it("returns empty when no token is set, even for github.com", () => {
		expect(githubAuthHeaders({}, "https://github.com/owner/repo")).toEqual({});
	});

	it("returns empty for a malformed url", () => {
		expect(githubAuthHeaders(TOK, "not a url")).toEqual({});
	});

	it("matches the hostname case-insensitively", () => {
		expect(githubAuthHeaders(TOK, "https://GitHub.com/owner/repo")).toEqual({ Authorization: "Bearer t0ken" });
		expect(githubAuthHeaders(TOK, "https://RAW.GitHubUserContent.com/a")).toEqual({ Authorization: "Bearer t0ken" });
	});
});
