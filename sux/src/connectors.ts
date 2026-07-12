// The ONE place that enumerates sux's MCP connectors. Both the OAuth `apiRoute` list
// and the runtime discovery manifest (GET /mcp/connectors) derive from this array, so
// the connector surface stops living in three hand-synced places (index.ts routing,
// the manifest, .claude-plugin/marketplace.json). Add a namespace here and it routes,
// self-describes, and drift-checks against the marketplace in one edit.

export type Connector = {
	/** The Worker path this namespace is served at (also its OAuth apiRoute entry). */
	path: string;
	/** The MCP serverInfo name for this namespace. */
	name: string;
	/** The marketplace plugin that ships this connector. Unset for retired dormant
	 * routes — routed for back-compat but shipped by no plugin (tools live on the one /mcp). */
	plugin?: string;
	/** One line for the discovery manifest. */
	summary: string;
	/**
	 * Whether this connector surfaces in the default discovery manifest. Unset ⇒ true.
	 * The vault/mail/files personal namespaces are retired from the default `/mcp/connectors`
	 * view (front-door declutter) but stay routed + OAuth-authorized (CONNECTOR_PATHS is
	 * never filtered) and remain discoverable via the explicit `?all=1` opt-in — hidden
	 * from the passive view, one deliberate call away, mirroring the `fn` escape hatch.
	 */
	advertised?: boolean;
};

export const CONNECTORS: Connector[] = [
	{ path: "/mcp", name: "sux", plugin: "sux-router", summary: "Universal research + data tools (web, papers, shopping, transforms, pipe/batch)." },
	{ path: "/vault/mcp", name: "vault", summary: "Obsidian knowledge base — read/write/edit/capture + daily notes over the git store.", advertised: false },
	{ path: "/mail/mcp", name: "mail", summary: "Fastmail/JMAP — search/read/thread/send/draft/archive + masked-email + raw jmap.", advertised: false },
	{ path: "/files/mcp", name: "files", summary: "Dropbox blobs — app-folder workspace (Mode A) + gated whole-account ops (Mode B).", advertised: false },
];

/** The connector paths — the single source the OAuth apiRoute + the per-path dispatch use. */
export const CONNECTOR_PATHS: string[] = CONNECTORS.map((c) => c.path);

/**
 * Shape the runtime discovery manifest from live tool counts. Pure — the caller supplies counts.
 * By default only advertised connectors surface (the personal namespaces are retired from the
 * passive view); pass `{ all: true }` to include the dormant-but-reachable ones on purpose.
 */
export function buildManifest(origin: string, counts: Record<string, number>, opts: { all?: boolean } = {}): {
	name: string;
	connectors: Array<{ name: string; plugin?: string; summary: string; url: string; tools: number | null }>;
} {
	const shown = opts.all ? CONNECTORS : CONNECTORS.filter((c) => c.advertised !== false);
	return {
		name: "sux",
		connectors: shown.map((c) => ({
			name: c.name,
			plugin: c.plugin,
			summary: c.summary,
			url: `${origin}${c.path}`,
			tools: c.path in counts ? counts[c.path] : null,
		})),
	};
}
