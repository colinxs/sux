import type { Caps, Handle, Llm, SinkTarget, Store } from "@suxos/lib";
import { llm } from "../ai.js";
import type { RtEnv } from "../registry.js";

// The op-engine's effect surface, backed by the Worker's real bindings: an R2 content
// store, Workers-AI text, and R2-published sinks. Every method fails LOUD when its
// binding is absent (never a silent no-op), but only WHEN CALLED — so a caps built for
// a pure op (echo) needs no bindings at all, and the inline path stays unit-testable.

// WebCrypto SHA-256 (identical in workerd and node) → lowercase hex.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Content-addressed R2 store: identical bytes collapse to one `cas/<sha256>` object —
// the same layout suxlib's MemoryStore and the `store` fn use, so a Handle minted here
// resolves anywhere. Reads/writes are guarded on the R2 binding.
function r2Store(env: RtEnv): Store {
	const bucket = () => {
		if (!env.R2) throw new Error("run: the R2 bucket binding is missing (the op store needs it).");
		return env.R2;
	};
	return {
		async put(bytes: Uint8Array, type: string): Promise<Handle> {
			const sha256 = await sha256Hex(bytes);
			const r2Key = `cas/${sha256}`;
			const b = bucket();
			// Content-addressed ⇒ idempotent: skip the write when the object already exists.
			if (!(await b.head(r2Key))) await b.put(r2Key, bytes, { httpMetadata: { contentType: type }, customMetadata: { sha256 } });
			return { r2Key, sha256, type, size: bytes.byteLength };
		},
		async get(h: Handle): Promise<Uint8Array> {
			const obj = await bucket().get(h.r2Key);
			if (!obj) throw new Error(`run: handle not found in R2: ${h.r2Key}`);
			return new Uint8Array(await obj.arrayBuffer());
		},
	};
}

function workersAiLlm(env: RtEnv): Llm {
	return {
		async markdownFromPdf(bytes: Uint8Array): Promise<string> {
			// The PDF→markdown leaf (suxlib domain `extract`) converts each PDF via Workers-AI's
			// document-conversion surface — `env.AI.toMarkdown`, a DISTINCT method from the text
			// `run()` path `summarize` uses. Fail LOUD if the binding is absent, same as the
			// store/sinks above (and ai.ts's hasAI guard) — never a silent empty conversion.
			if (typeof env.AI?.toMarkdown !== "function") {
				throw new Error("run: the Workers-AI binding (env.AI.toMarkdown) is missing — the PDF extract leaf needs it.");
			}
			// One document in ⇒ one ConversionResponse out (the single-doc toMarkdown overload).
			const result = await env.AI.toMarkdown({ name: "document.pdf", blob: new Blob([bytes as BufferSource], { type: "application/pdf" }) });
			// ConversionResponse is a discriminated union on `format`: the "error" branch carries
			// no markdown (`error` instead of `data`), so surface it loudly rather than let a bad
			// PDF slip through as an empty/garbage extraction into the reconcile → summarize chain.
			if (result.format === "error") throw new Error(`run: Workers-AI toMarkdown could not convert the PDF: ${result.error}`);
			return result.data;
		},
		async summarize(text: string): Promise<string> {
			return llm(env, "Summarize the following content concisely and faithfully.", text, 1024, "summarize an op artifact");
		},
	};
}

// The piped value reaching a sink is either a bare Handle (a claim-check terminal) or
// a summarize result `{ abstract, summaryHandle }` (the assimilate-pdfs terminal). Both
// carry the artifact BY REFERENCE — pull the Handle out, never inline bytes into it.
function sinkHandle(input: any): Handle {
	if (input?.r2Key && input?.sha256) return input as Handle;
	if (input?.summaryHandle?.r2Key) return input.summaryHandle as Handle;
	throw new Error("run: a sink was handed a value with no resolvable Handle (expected a Handle or a { summaryHandle }).");
}

// R2-published terminals: re-address the referenced Handle under a durable prefix, so a
// sink write is a visible, resolvable side effect rather than a no-op. `r2` publishes
// under `published/`; `vault` publishes under `vault/` — a real, low-risk, content-
// addressed R2 write (no git-vault machinery), giving assimilate-pdfs two DISTINCT
// durable sink targets. Both fail LOUD on a missing binding or unresolvable handle.
function makeSinks(env: RtEnv): Record<string, SinkTarget> {
	const publisher = (name: string, prefix: string): SinkTarget => ({
		name,
		async write(input: any): Promise<any> {
			if (!env.R2) throw new Error(`run: the ${name} sink needs the R2 bucket binding.`);
			const h = sinkHandle(input);
			const obj = await env.R2.get(h.r2Key);
			if (!obj) throw new Error(`run: the ${name} sink can't resolve handle ${h.r2Key}`);
			const key = `${prefix}${h.sha256}`;
			if (!(await env.R2.head(key))) await env.R2.put(key, await obj.arrayBuffer(), { httpMetadata: { contentType: h.type } });
			return input;
		},
	});
	return { r2: publisher("r2", "published/"), vault: publisher("vault", "vault/"), "mail-labels": mailLabelsSink(env), "vault-notes": vaultNotesSink(env) };
}

// The `mail-triage-plan` op's terminal (registry.ts): applies a batch of {id, label, add}
// proposals — already approved by the `ask` gate — as reversible JMAP keyword patches via the
// EXISTING mail-mcp labelMessages verb. Dynamically imported so op-engine's non-mail ops (echo,
// assimilate-pdfs) never pull mail-mcp's JMAP dependency graph into their module load. Grouped
// by (label, add) so N proposals for the same label become one chunked labelMessages call
// instead of N. An empty batch (everything classified below the confidence bar, or a sensitive
// sender) is a no-op — never an error.
function mailLabelsSink(env: RtEnv): SinkTarget {
	return {
		name: "mail-labels",
		async write(input: any): Promise<any> {
			const items: Array<{ id?: unknown; label?: unknown; add?: unknown }> = Array.isArray(input) ? input : [];
			const groups = new Map<string, string[]>();
			for (const it of items) {
				if (!it?.id || !it?.label) continue;
				const key = `${it.add === false ? "-" : "+"}${String(it.label)}`;
				const ids = groups.get(key) ?? [];
				ids.push(String(it.id));
				groups.set(key, ids);
			}
			if (!groups.size) return { labeled: 0, groups: 0 };
			const { labelMessages } = await import("../mail-mcp.js");
			let labeled = 0;
			let failed = 0;
			for (const [key, ids] of groups) {
				const add = key.startsWith("+");
				const label = key.slice(1);
				const r = await labelMessages(env, ids, label, add);
				if (r.isError) throw new Error(`run: the mail-labels sink failed applying '${label}': ${r.content?.[0]?.text ?? "unknown error"}`);
				// labelMessages can PARTIALLY fail (some ids updated, some not) while still
				// returning isError:false — read its actual `labeled`/`failed` counts rather than
				// assuming every id in the group succeeded (that would silently over-report success).
				let parsed: { labeled?: unknown; failed?: unknown } = {};
				try {
					parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
				} catch {
					// unparseable response body: fall through and count the whole group as labeled,
					// matching prior (pre-fix) behavior rather than under-reporting on a shape we can't read.
				}
				labeled += typeof parsed.labeled === "number" ? parsed.labeled : ids.length;
				failed += typeof parsed.failed === "number" ? parsed.failed : 0;
			}
			return { labeled, groups: groups.size, ...(failed ? { failed } : {}) };
		},
	};
}

// The `vault-consolidate-plan` op's terminal (registry.ts): applies a batch of already-
// approved {keep, archive, mergedContent} merge proposals via the EXISTING obsidian fn's
// git-backed write/append actions. Dynamically imported for the same reason mailLabelsSink
// is — op-engine's non-vault ops (echo, mail-triage-plan) never pull obsidian's GitHub-API
// dependency graph into their module load. Deliberately NON-DESTRUCTIVE: `keep` gets a
// `write` (overwrite with the merged content), `archive` gets an `append` (a pointer back to
// `keep`, its own content left intact) — never a `delete` — so a wrong merge judgment is
// always undoable by hand or `git revert`. A malformed item (missing keep/archive/content) is
// skipped, not a hard failure; an empty batch is a no-op.
function vaultNotesSink(env: RtEnv): SinkTarget {
	return {
		name: "vault-notes",
		async write(input: any, caps: Caps): Promise<any> {
			const items: Array<{ keep?: unknown; archive?: unknown; mergedContent?: unknown }> = Array.isArray(input) ? input : [];
			if (!items.length) return { merged: 0 };
			const { obsidian } = await import("../fns/obsidian.js");
			const stamp = new Date(caps.clock.now()).toISOString().slice(0, 10);
			let merged = 0;
			let failed = 0;
			for (const it of items) {
				const keep = typeof it?.keep === "string" ? it.keep : "";
				const archive = typeof it?.archive === "string" ? it.archive : "";
				const mergedContent = typeof it?.mergedContent === "string" ? it.mergedContent : "";
				if (!keep || !archive || !mergedContent) continue;
				const w = await obsidian.run(env, { action: "write", path: keep, content: mergedContent, backend: "git" });
				if (w.isError) {
					failed++;
					continue;
				}
				const pointer = `Merged into [[${keep}]] by vault-consolidate-plan`;
				const note = `> [!note] ${pointer} on ${stamp} — see there for the combined content.`;
				// The write above is idempotent (same deterministic mergedContent every retry), but
				// append is NOT — a step.do retry after a mid-batch eviction (durable.ts's `sink`
				// step wraps this whole loop as ONE memoized step) would otherwise double the
				// merge-pointer block in `archive`. Skip the append if that note already carries a
				// pointer to this `keep` from a prior attempt (#740).
				const r = await obsidian.run(env, { action: "read", path: archive, backend: "git" });
				const already = !r.isError && typeof r.content?.[0]?.text === "string" && r.content[0].text.includes(pointer);
				if (!already) {
					const a = await obsidian.run(env, { action: "append", path: archive, content: note, backend: "git" });
					if (a.isError) {
						failed++;
						continue;
					}
				}
				merged++;
			}
			return { merged, groups: items.length, ...(failed ? { failed } : {}) };
		},
	};
}

export function makeCaps(env: RtEnv): Caps {
	return {
		store: r2Store(env),
		llm: workersAiLlm(env),
		// Read only inside a memoized step.do body (see durable.ts) so replays stay deterministic.
		clock: { now: () => Date.now() },
		sinks: makeSinks(env),
	};
}
