import type { ToolResult } from "../registry";

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
// helper, one "attach a UI resource to an existing ToolResult" function. No
// template engine, no client-capability gating (sux's stateless dispatch has
// no per-connection session to key that off — see the PR description for
// what's left to generalize before other fns adopt this).

export const MCP_UI_MIME = "text/html;profile=mcp-app";

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
