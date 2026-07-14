// Optional GitHub PAT injection for outbound scraping fetches.
//
// GitHub throttles anonymous requests to 60/hr per IP but lifts authenticated
// requests to 5000/hr. When GITHUB_TOKEN is set we attach a Bearer header —
// but ONLY for GitHub-owned hosts. This is a security boundary: the token must
// never leak to arbitrary origins the worker happens to fetch.

/** Hosts we trust to receive the token: github.com, api.github.com,
 * raw.githubusercontent.com, and any subdomain of githubusercontent.com. */
export function isGithubHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return h === "github.com" || h === "api.github.com" || h === "githubusercontent.com" || h.endsWith(".githubusercontent.com");
}

/** Authorization header for GitHub hosts when a token is configured, else {}. */
export function githubAuthHeaders(env: { GITHUB_TOKEN?: string }, url: string): Record<string, string> {
	if (!env.GITHUB_TOKEN) return {};
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return {};
	}
	if (!isGithubHost(hostname)) return {};
	return { Authorization: `Bearer ${env.GITHUB_TOKEN}` };
}
