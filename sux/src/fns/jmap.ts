import { type Fn, failWith, ok, type RtEnv } from "../registry";
import {
	doDownload,
	doUpload,
	enforceGates,
	type Invocation,
	JmapError,
	jstr,
	runBatch,
	runPaginate,
	validateCalls,
} from "./_jmap";

// jmap — the full JMAP protocol (RFC 8620/8621 + Fastmail MaskedEmail) as ONE typed
// conduit to Fastmail. The caller sends a raw JMAP batch; sux injects the Bearer
// token, discovers+caches the Session (accountId/apiUrl/limits auto-filled), unions
// the `using` capabilities, resolves `#` back-references (query→get in one round-trip),
// paginates past the server limits, gates accidental send/destroy, and returns the raw
// methodResponses byte-exact. It forwards the protocol — it curates nothing — so the
// whole of Email/Mailbox/Thread/Identity/EmailSubmission/MaskedEmail/Contact/Calendar
// is reachable through the same verb. The escape hatch IS the product; the ergonomic
// `mail` surface (mail-mcp) compiles down to this. Design: docs/proposals/jmap.md.
//
// raw:true + cacheable:false: JMAP payloads pass byte-exact (CRLF/emoji/blob-safe) and
// mail bodies + Session PII are never written to the response cache (freshness comes
// from JMAP's own state tokens). Send/destroy gates are ACCIDENTAL-misuse guards, not an
// injection boundary — a read-only token is the real containment.

const NOT_CONFIGURED =
	"Fastmail JMAP not configured. Set FASTMAIL_TOKEN to a JMAP-scoped API token (Fastmail → Settings → Privacy & Security → API tokens → New token). For read/compose workflows mint a READ-ONLY token so send/destroy are impossible at the credential layer. An 'MCP'-type token will NOT work.";

const SEND_SKELETON =
	"Send is two steps: (1) jmap({method:'Identity/get'}) → pick the identityId whose email is your From; (2) one batch: Email/set create draft (mailboxIds:{<draftsId>:true}, keywords:{$draft:true}, from/to/subject/bodyStructure/bodyValues) then EmailSubmission/set create {emailId:'#draft', identityId:'<id>'} with onSuccessUpdateEmail moving Drafts→Sent — allow_send:true required.";

/** Map an engine JmapError to the fn's failWith; coerce any internal sentinel/unknown code to a real FailCode. */
function toFail(e: unknown) {
	if (e instanceof JmapError) {
		const code = String(e.code);
		if (code === "__reauth__") return failWith("not_configured", "Fastmail rejected the token — it is revoked or lacks scope.");
		if (code === "__limit__") return failWith("rate_limited", "JMAP request-level limit exceeded — reduce the batch/objects and retry.");
		if (code.startsWith("__")) return failWith("upstream_error", e.message);
		return failWith(e.code, e.message);
	}
	return failWith("upstream_error", `jmap failed: ${String((e as Error)?.message ?? e)}`);
}

export const jmap: Fn = {
	name: "jmap",
	cost: 2,
	description:
		"Full Fastmail/JMAP protocol via one generic verb (RFC 8620/8621 + Fastmail MaskedEmail). Send a raw JMAP batch calls:[[method, args, callId], …] (Email/query|get|set, Mailbox/get, Thread/get, Identity/get, EmailSubmission/set, MaskedEmail/get|set, Contact/*, CalendarEvent/*, VacationResponse/*), or the single-call method+args shorthand. sux injects the Bearer token, discovers+caches the Session (accountId/apiUrl/limits auto-filled), unions the `using` capabilities, resolves `#` back-references (query→get in one round-trip), and paginates past maxCallsInRequest/maxObjectsInGet (paginate:true → full ids + cursor). Blob upload/download sub-actions for attachments. Returns raw methodResponses (byte-exact, uncached). Sending needs allow_send:true; destroy/vacation/forwarding need allow_destroy:true — these guard ACCIDENTAL misuse only, not injection; use a read-only token for real containment. Needs FASTMAIL_TOKEN (a JMAP-scoped token, not an MCP one). " +
		SEND_SKELETON,
	cacheable: false,
	raw: true,
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			calls: {
				type: "array",
				description:
					"Raw JMAP method-call batch: [methodName, argsObject, callId] invocations run in order. Back-reference a prior result with a '#'-prefixed arg + {resultOf,name,path} (e.g. Email/query then Email/get #ids:{resultOf:'q',name:'Email/query',path:'/ids'}). Creation-id refs ('#name' in an id value) chain a Foo/set create into a later call. accountId auto-filled; callIds must be unique.",
				items: { type: "array", minItems: 3, maxItems: 3 },
			},
			method: { type: "string", description: "Single-call shorthand: one JMAP method (e.g. 'Mailbox/get'), wrapped as a one-element batch. Use `calls` for >1 call or back-references." },
			args: { type: "object", additionalProperties: true, description: "Arguments for `method`. accountId auto-filled if omitted." },
			using: { type: "array", items: { type: "string" }, description: "Capability URNs to ADD (auto-derived from method names and unioned; never suppresses a required cap). Pass for custom/future methods." },
			paginate: { type: "boolean", default: false, description: "Auto-paginate a single Foo/query past the page limit (stable anchor paging) up to max_results / a 55s budget / an output ceiling; a back-referenced Foo/get is hydrated + collapsed. Returns ids + cursor + partial." },
			max_results: { type: "integer", minimum: 1, maximum: 10000, default: 500, description: "Cap on ids accumulated when paginate=true." },
			cursor: { type: "string", description: "Opaque cursor from a prior paginate response — resumes at the saved anchor (re-validated against the filter)." },
			upload: {
				type: "object",
				additionalProperties: false,
				description: "Blob upload: POST bytes to the Session uploadUrl → {blobId,type,size}. Reference blobId in a later Email/set attachment.",
				properties: { data: { type: "string", description: "Base64 bytes (≤~190KB inline) OR a sux /s/<uuid> CAS ref (the primary path for real attachments). An https URL is refused (SSRF)." }, type: { type: "string", default: "application/octet-stream" } },
				required: ["data"],
			},
			download: {
				type: "object",
				additionalProperties: false,
				description: "Blob download: GET the Session downloadUrl. as:'base64' inline (auto-spills to R2 over the cap); as:'store' always spills to /s/<uuid>.",
				properties: { blobId: { type: "string" }, type: { type: "string", default: "application/octet-stream" }, name: { type: "string", default: "download" }, as: { type: "string", enum: ["base64", "store"], default: "base64" } },
				required: ["blobId"],
			},
			allow_send: { type: "boolean", default: false, description: "GATE: an EmailSubmission/set with a non-empty create is REJECTED unless true. Accidental-send guard only (an injected instruction can set it) — not an injection boundary." },
			allow_destroy: { type: "boolean", default: false, description: "GATE: any Foo/set destroy (permanent expunge), Mailbox onDestroyRemoveEmails, VacationResponse/set, or forwarding/rule method is REJECTED unless true. Accidental-mutation guard only." },
			session_refresh: { type: "boolean", default: false, description: "Force re-discovery of the JMAP Session before dispatch (bypass the KV cache)." },
		},
	},
	run: async (env: RtEnv, args: any) => {
		if (!env.FASTMAIL_TOKEN) return failWith("not_configured", NOT_CONFIGURED);
		const startedAt = Date.now();

		const modes = ["calls", "method", "upload", "download"].filter((k) => args?.[k] !== undefined);
		if (modes.length === 0) return failWith("bad_input", "provide exactly one of: calls (raw batch), method+args (single call), upload, or download.");
		if (modes.length > 1) return failWith("bad_input", `provide exactly one of calls/method/upload/download — got ${modes.join(", ")}.`);

		try {
			// ---- blob sub-actions (not methodCalls) ----
			if (args.upload !== undefined) {
				const u = args.upload;
				if (!u?.data) return failWith("bad_input", "upload.data is required.");
				return ok(jstr(await doUpload(env, String(u.data), String(u.type ?? "application/octet-stream"))));
			}
			if (args.download !== undefined) {
				const d = args.download;
				if (!d?.blobId) return failWith("bad_input", "download.blobId is required.");
				return ok(jstr(await doDownload(env, { blobId: String(d.blobId), type: d.type, name: d.name, as: d.as })));
			}

			// ---- normalize to a calls[] batch ----
			let calls: Invocation[];
			if (args.method !== undefined) {
				if (typeof args.method !== "string" || !args.method) return failWith("bad_input", "method must be a non-empty JMAP method name.");
				calls = [[String(args.method), (args.args ?? {}) as Record<string, any>, "c0"]];
			} else {
				try {
					validateCalls(args.calls);
				} catch (e) {
					return toFail(e);
				}
				calls = args.calls as Invocation[];
			}

			const allowSend = args.allow_send === true;
			const allowDestroy = args.allow_destroy === true;
			try {
				enforceGates(calls, allowSend, allowDestroy);
			} catch (e) {
				return toFail(e);
			}

			// ---- paginate: a single Foo/query (+ optional back-referenced Foo/get) ----
			if (args.paginate === true) {
				const queries = calls.filter((c) => /\/query$/.test(c[0]));
				if (queries.length !== 1) return failWith("bad_input", "paginate:true needs exactly one Foo/query in the batch.");
				const queryCall = queries[0];
				const qId = queryCall[2];
				// Only hydrate a Foo/get that actually back-references THIS query (its
				// callId), not just any /get in the batch — else an unrelated Mailbox/get
				// gets mis-fed the query's ids.
				const backRefsQuery = (a: any): boolean =>
					!!a && typeof a === "object" && Object.entries(a).some(([k, v]) => k.startsWith("#") && !!v && typeof v === "object" && (v as any).resultOf === qId);
				const getCall = calls.find((c) => /\/get$/.test(c[0]) && c !== queryCall && backRefsQuery(c[1]));
				const maxResults = Math.min(10000, Math.max(1, Number(args.max_results) || 500));
				const using = Array.isArray(args.using) ? args.using : undefined;
				const { payload, session } = await runPaginate(env, queryCall, getCall, { maxResults, cursor: args.cursor ? String(args.cursor) : undefined, sessionRefresh: args.session_refresh === true, startedAt, using });
				return ok(jstr({ ...payload, sessionState: session.state }));
			}

			// ---- the limit-safe passthrough ----
			const { response, session } = await runBatch(env, calls, { using: Array.isArray(args.using) ? args.using : undefined, sessionRefresh: args.session_refresh === true, startedAt });
			return ok(jstr({ methodResponses: response.methodResponses, sessionState: response.sessionState ?? session.state, ...(response.createdIds ? { createdIds: response.createdIds } : {}) }));
		} catch (e) {
			return toFail(e);
		}
	},
};
