import { type Fn, fail } from "../registry";

// youtube — transcript/metadata/search/comments (residential). Stub — F6.
// Residential egress is what makes YouTube's transcript endpoints reachable.
export const youtube: Fn = {
	name: "youtube",
	description: "YouTube via residential proxy. what: transcript | metadata | search | comments. (not implemented yet)",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["what"],
		properties: {
			what: { type: "string", enum: ["transcript", "metadata", "search", "comments"] },
			video: { type: "string", description: "Video id or URL (transcript/metadata/comments)." },
			query: { type: "string", description: "Search query (search)." },
		},
	},
	run: async () => fail("youtube is not implemented yet (F6)."),
};
