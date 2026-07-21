import type { RtEnv, ToolResult } from "../registry";

// MCP Apps (SEP-1865, ratified 2026-01-26) — the official MCP extension for
// returning interactive UI (dashboards/forms/charts) inline in a tool result
// instead of a plain-text blob. Spec:
//   https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
//   https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
//   https://modelcontextprotocol.io/extensions/apps/overview
//
// Wire format below is grounded in that ratified spec text, not guessed:
//   - MIME type for the UI resource's HTML: "text/html;profile=mcp-app" (the
//     early "text/html+skybridge" candidate name did NOT ship).
//   - Resource URI scheme: "ui://<server>/<template>".
//   - The resource is delivered as a standard MCP base-spec embedded-resource
//     content block ({ type:"resource", resource:{ uri, mimeType, text } })
//     APPENDED to the tool result's content array, alongside the normal text
//     block — a UI-aware host renders it; a plain-text client just sees an
//     extra content part it doesn't understand and ignores (the text block
//     it already reads is unchanged, so this is additive, never breaking).
//   - The TOOL DEFINITION separately advertises which template its result
//     renders into via `_meta.ui.resourceUri` (the spec's current nested
//     form — the older flat `_meta["ui/resourceUri"]` is explicitly
//     deprecated by the spec text).
//
// Deliberately minimal: one MIME constant, one uri builder, one escape
// helper, one "attach a UI resource to an existing ToolResult" function, plus
// (#1143) a best-effort client-capability negotiation pair
// (recordClientUiSupport/clientDeclaredUiSupport) — no template engine beyond that.

export const MCP_UI_MIME = "text/html;profile=mcp-app";
export const MCP_UI_EXTENSION = "io.modelcontextprotocol/ui";

const CLIENT_UI_KV_PREFIX = "sux:client-ui:";
// Refreshed on every `initialize` — a client that upgrades away from support ages
// out within a month rather than sticking to a stale "supports UI" record forever.
const CLIENT_UI_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Record whether the connecting MCP client declared the `io.modelcontextprotocol/ui`
 *  extensions capability at `initialize` (index.ts's one call site). Keyed by the
 *  OAuth `login` — the only identity signal present on EVERY request in sux's
 *  stateless-per-request server (no Mcp-Session-Id / Durable Object session a
 *  stateful MCP transport would have, and `tools/call` never resends `clientInfo`),
 *  so login is the one thing `initialize` and a later `tools/call` share. Imprecise
 *  if one login drives two different client apps concurrently (the last initialize
 *  wins for both) — the best signal this architecture offers, refreshed on every
 *  initialize. Best-effort: a KV write failure here must never fail initialize. */
export async function recordClientUiSupport(env: { OAUTH_KV?: KVNamespace }, login: string | undefined, capabilities: unknown): Promise<void> {
	const key = String(login ?? "").trim();
	if (!key) return;
	const caps = (capabilities && typeof capabilities === "object" ? capabilities : {}) as Record<string, unknown>;
	const ext = caps.extensions && typeof caps.extensions === "object" ? (caps.extensions as Record<string, unknown>) : {};
	const supports = MCP_UI_EXTENSION in ext;
	try {
		await env.OAUTH_KV?.put(`${CLIENT_UI_KV_PREFIX}${key}`, supports ? "1" : "0", { expirationTtl: CLIENT_UI_TTL_SECONDS });
	} catch {
		// best-effort — see doc comment above.
	}
}

/** Whether the connected client is known to support the UI extension. Defaults to
 *  true (attach) whenever there's no POSITIVE record that it doesn't: no record yet
 *  (a race against the initialize write, or a call outside the tools/call path with
 *  no login) is treated as "unknown," not "unsupported" — an extra, unrecognized
 *  content part is harmless (see withUiResource's doc comment above), and a false
 *  negative would silently regress every existing UI pilot. Only an EXPLICIT
 *  initialize that omitted the capability suppresses attachment. */
export async function clientDeclaredUiSupport(env: RtEnv): Promise<boolean> {
	const login = env._egress?.login;
	if (!login) return true;
	try {
		const v = await env.OAUTH_KV?.get(`${CLIENT_UI_KV_PREFIX}${login}`);
		return v !== "0";
	} catch {
		return true;
	}
}

/** Build a `ui://` resource URI for a sux-hosted UI template. */
export function uiResourceUri(template: string): string {
	return `ui://sux/${template}`;
}

/** The tool-definition `_meta` a fn exports (via `Fn.meta`) to declare which
 * UI template its result renders into — the spec's nested `_meta.ui.resourceUri`
 * form, not the deprecated flat key. */
export function uiMeta(template: string): { ui: { resourceUri: string } } {
	return { ui: { resourceUri: uiResourceUri(template) } };
}

/** An MCP base-spec embedded-resource content block — the carrier for an MCP
 * Apps UI resource. `ToolResult.content` stays typed as text-only (see the
 * NOTE in registry.ts) so every existing `content[0].text` call site across
 * the repo is untouched; this function is the one place that knowingly
 * appends a differently-shaped part, via a local cast. */
export type UiResourceContent = { type: "resource"; resource: { uri: string; mimeType: string; text: string } };

/**
 * Append an embedded MCP Apps UI resource to an existing ToolResult. The
 * original content (normally a single text block) stays first and untouched
 * — so a caller that doesn't understand `type:"resource"` reads exactly the
 * same text it always has — and the resource block is appended after it.
 */
export function withUiResource(result: ToolResult, template: string, html: string): ToolResult {
	const resourcePart: UiResourceContent = { type: "resource", resource: { uri: uiResourceUri(template), mimeType: MCP_UI_MIME, text: html } };
	return {
		...result,
		content: [...result.content, resourcePart as unknown as { type: "text"; text: string }],
	};
}

/** Minimal HTML-entity escape for untrusted text (scraped/API text from a
 * third party) embedded into a UI resource's markup. Shared here because
 * every fn piloting a UI resource embeds caller/upstream text into HTML and
 * must escape it the same way. */
export function escapeHtml(s: unknown): string {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
