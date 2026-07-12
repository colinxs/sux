// The ONE place that enumerates sux's MCP connectors. Both the OAuth `apiRoute` list
// and the runtime discovery manifest (GET /mcp/connectors) derive from this array, so
// the connector surface stops living in three hand-synced places (index.ts routing,
// the manifest, .claude-plugin/marketplace.json). Add a namespace here and it routes,
// self-describes, and drift-checks against the marketplace in one edit.
//
// The vault/mail/files personal namespaces once mounted as separate /<domain>/mcp
// connectors; they've been fully retired. Their capabilities live on the one /mcp
// front door (vault_/mail_/files_ verbs), so the connector surface is a single door.

export type Connector = {
	/** The Worker path this namespace is served at (also its OAuth apiRoute entry). */
	path: string;
	/** The MCP serverInfo name for this namespace. */
	name: string;
	/** The marketplace plugin that ships this connector. */
	plugin: string;
	/** One line for the discovery manifest. */
	summary: string;
};

export const CONNECTORS: Connector[] = [
	{ path: "/mcp", name: "sux", plugin: "sux", summary: "Universal research + data tools (web, papers, shopping, transforms, pipe/batch)." },
];

/** The connector paths — the single source the OAuth apiRoute + the per-path dispatch use. */
export const CONNECTOR_PATHS: string[] = CONNECTORS.map((c) => c.path);

/**
 * Shape the runtime discovery manifest from live tool counts. Pure — the caller supplies counts.
 */
export function buildManifest(origin: string, counts: Record<string, number>): {
	name: string;
	connectors: Array<{ name: string; plugin: string; summary: string; url: string; tools: number | null }>;
} {
	return {
		name: "sux",
		connectors: CONNECTORS.map((c) => ({
			name: c.name,
			plugin: c.plugin,
			summary: c.summary,
			url: `${origin}${c.path}`,
			tools: c.path in counts ? counts[c.path] : null,
		})),
	};
}
