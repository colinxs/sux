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
	return {
		r2: publisher("r2", "published/"),
		vault: publisher("vault", "vault/"),
		"mail-labels": mailLabelsSink(env),
		"vault-notes": vaultNotesSink(env),
		"related-links": relatedLinksSink(env),
		"contacts-merge": contactsMergeSink(env),
		"mychart-outreach": mychartOutreachSink(env),
	};
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
// approved {keep, archives, mergedContent} merge proposals via the EXISTING obsidian fn's
// git-backed write/append actions. Dynamically imported for the same reason mailLabelsSink
// is — op-engine's non-vault ops (echo, mail-triage-plan) never pull obsidian's GitHub-API
// dependency graph into their module load. Deliberately NON-DESTRUCTIVE: `keep` gets ONE
// `write` (overwrite with the whole group's merged content), each of `archives` gets an
// `append` (a pointer back to `keep`, its own content left intact) — never a `delete` — so a
// wrong merge judgment is always undoable by hand or `git revert`. One `keep` is written once
// per item (proposeMerge already composed the whole group into `mergedContent`, so there's
// never more than one item per `keep` — see #764, where per-PAIR items sharing a `keep` used
// to overwrite each other). A malformed item (missing keep/archives/content) is skipped, not
// a hard failure; an empty batch is a no-op.
function vaultNotesSink(env: RtEnv): SinkTarget {
	return {
		name: "vault-notes",
		async write(input: any, caps: Caps): Promise<any> {
			const items: Array<{ keep?: unknown; archives?: unknown; mergedContent?: unknown }> = Array.isArray(input) ? input : [];
			if (!items.length) return { merged: 0 };
			const { obsidian } = await import("../fns/obsidian.js");
			const stamp = new Date(caps.clock.now()).toISOString().slice(0, 10);
			let merged = 0;
			let failed = 0;
			for (const it of items) {
				const keep = typeof it?.keep === "string" ? it.keep : "";
				const archives = Array.isArray(it?.archives) ? it.archives.filter((a: unknown): a is string => typeof a === "string" && a.length > 0) : [];
				const mergedContent = typeof it?.mergedContent === "string" ? it.mergedContent : "";
				if (!keep || !archives.length || !mergedContent) continue;
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
				// merge-pointer block in each `archive`. Skip an archive's append if it already
				// carries a pointer to this `keep` from a prior attempt (#740).
				let archiveFailed = false;
				for (const archive of archives) {
					const r = await obsidian.run(env, { action: "read", path: archive, backend: "git" });
					const already = !r.isError && typeof r.content?.[0]?.text === "string" && r.content[0].text.includes(pointer);
					if (already) continue;
					const a = await obsidian.run(env, { action: "append", path: archive, content: note, backend: "git" });
					if (a.isError) archiveFailed = true;
				}
				if (archiveFailed) {
					failed++;
					continue;
				}
				merged++;
			}
			return { merged, groups: items.length, ...(failed ? { failed } : {}) };
		},
	};
}

// The `cross-semantic-plan` op's terminal (registry.ts): applies a batch of already-approved
// {vaultPath, domain, key, label, score} cross-domain matches (fns/_cross_semantic.ts's
// crossDomainLinks) as an APPEND-ONLY "Related" block per vault note, via the EXISTING obsidian
// fn's git-backed append action — never a `write`/`delete`, so this can never clobber a note's
// own content the way vault-notes' merge `write` deliberately can (#785 is a lighter, append-
// only variant of that shape). Dynamically imported for the same reason mailLabelsSink/
// vaultNotesSink are — op-engine's other ops never pull obsidian's GitHub-API dependency graph
// into their module load. Grouped by vaultPath so N matches for the same note become one append
// instead of N. A malformed item (no vaultPath/domain/label) is skipped; an empty batch is a
// no-op.
function relatedLinksSink(env: RtEnv): SinkTarget {
	return {
		name: "related-links",
		async write(input: any): Promise<any> {
			const items: Array<{ vaultPath?: unknown; domain?: unknown; key?: unknown; label?: unknown; score?: unknown }> = Array.isArray(input) ? input : [];
			const byNote = new Map<string, Array<{ domain: string; key: string; label: string }>>();
			for (const it of items) {
				const vaultPath = typeof it?.vaultPath === "string" ? it.vaultPath : "";
				const domain = typeof it?.domain === "string" ? it.domain : "";
				const label = typeof it?.label === "string" ? it.label : "";
				if (!vaultPath || !domain || !label) continue;
				const list = byNote.get(vaultPath) ?? [];
				list.push({ domain, key: typeof it?.key === "string" ? it.key : "", label });
				byNote.set(vaultPath, list);
			}
			if (!byNote.size) return { linked: 0 };
			const { obsidian } = await import("../fns/obsidian.js");
			let linked = 0;
			let failed = 0;
			for (const [vaultPath, links] of byNote) {
				// The append below is NOT idempotent by itself — a step.do retry after a mid-batch
				// eviction (durable.ts's `sink` step wraps this whole loop as ONE memoized step)
				// would otherwise double the "Related" block. Scope the marker to THIS batch's exact
				// target set (mirrors vaultNotesSink's per-`keep` pointer, #740) rather than a single
				// note-wide sentinel — a note-wide marker would also silently skip a LATER run's newly
				// found links for the same note, since any prior batch's marker would already match
				// (#962). Skip only when this specific target set was already appended.
				const targetsKey = links.map((l) => `${l.domain}:${l.key}`).sort().join(",");
				const marker = `<!-- cross-semantic-plan:related:${targetsKey} -->`;
				const r = await obsidian.run(env, { action: "read", path: vaultPath, backend: "git" });
				const already = !r.isError && typeof r.content?.[0]?.text === "string" && r.content[0].text.includes(marker);
				if (already) continue;
				const lines = links.map((l) => `> - ${l.domain === "mail" ? "📧" : "📁"} ${l.label}`);
				const block = `\n\n${marker}\n> [!note] Related\n${lines.join("\n")}\n`;
				const a = await obsidian.run(env, { action: "append", path: vaultPath, content: block, backend: "git" });
				if (a.isError) {
					failed++;
					continue;
				}
				linked++;
			}
			return { linked, notes: byNote.size, ...(failed ? { failed } : {}) };
		},
	};
}

// The `contacts-consolidate-plan` op's terminal (registry.ts): applies a batch of already-
// approved {keep, archives, name?, company?, emails, phones} merge proposals via the EXISTING
// `contact` front-door fn's update action (contact_update is irreversible:false in stage.ts, so
// it auto-mutates with no staging round trip). Dynamically imported for the same reason
// mailLabelsSink/vaultNotesSink are — op-engine's other ops never pull mail-mcp's JMAP
// dependency graph into their module load. Deliberately NON-DESTRUCTIVE, mirroring
// vaultNotesSink's write/append split: `keep` gets ONE contact_update carrying the cluster's
// unioned emails/phones (+ the longest name/first company, when proposeContactMerge found one),
// each of `archives` gets its OWN name tagged with a pointer back to `keep` — never a
// contact_delete — so a wrong merge judgment is always undoable by hand. A malformed item
// (missing keep/archives) is skipped, not a hard failure; an empty batch is a no-op.
function contactsMergeSink(env: RtEnv): SinkTarget {
	return {
		name: "contacts-merge",
		async write(input: any): Promise<any> {
			const items: Array<{ keep?: unknown; archives?: unknown; name?: unknown; company?: unknown; emails?: unknown; phones?: unknown }> = Array.isArray(input) ? input : [];
			if (!items.length) return { merged: 0 };
			const { contact } = await import("../fns/contact.js");
			let merged = 0;
			let failed = 0;
			for (const it of items) {
				const keep = typeof it?.keep === "string" ? it.keep : "";
				const archives = Array.isArray(it?.archives) ? it.archives.filter((a: unknown): a is string => typeof a === "string" && a.length > 0) : [];
				if (!keep || !archives.length) continue;
				const patch: Record<string, unknown> = { id: keep };
				if (typeof it?.name === "string" && it.name) patch.name = it.name;
				if (typeof it?.company === "string" && it.company) patch.company = it.company;
				if (Array.isArray(it?.emails) && it.emails.length) patch.emails = it.emails;
				if (Array.isArray(it?.phones) && it.phones.length) patch.phones = it.phones;
				const u = await contact.run(env, { action: "update", ...patch });
				if (u.isError) {
					failed++;
					continue;
				}
				// Not idempotent by itself — a step.do retry after a mid-batch eviction (durable.ts's
				// `sink` step wraps this whole loop as ONE memoized step) would otherwise double the
				// merge-pointer tag on each `archive`'s name. Skip an archive whose name already
				// carries this `keep`'s pointer from a prior attempt (mirrors vaultNotesSink's #740).
				const pointer = `(merged into ${keep})`;
				let archiveFailed = false;
				for (const archiveId of archives) {
					const g = await contact.run(env, { action: "get", id: archiveId });
					if (g.isError) {
						archiveFailed = true;
						continue;
					}
					let existingName = "";
					try {
						existingName = String(JSON.parse(g.content?.[0]?.text ?? "{}")?.name ?? "");
					} catch {
						/* an unparseable get response reads as no existing name — the tag still applies */
					}
					if (existingName.includes(pointer)) continue;
					const newName = existingName ? `${existingName} ${pointer}` : pointer;
					const a = await contact.run(env, { action: "update", id: archiveId, name: newName });
					if (a.isError) archiveFailed = true;
				}
				if (archiveFailed) {
					failed++;
					continue;
				}
				merged++;
			}
			return { merged, groups: items.length, ...(failed ? { failed } : {}) };
		},
	};
}

// The `mychart-reconcile-plan` op's terminal (registry.ts): applies a batch of already-approved
// {medOrg, medId, medName, allergyOrg, allergyId, allergySubstance, summary, draftMessage}
// outreach drafts via the EXISTING obsidian fn's git-backed write action — DELIBERATELY never
// mail_send/mail_draft. An LLM-drafted clinical message needs a human's own eyes and hands on
// the actual send (copy it into MyChart's own patient-portal messaging, or a real email, by
// hand); this sink's job ends at making the approved draft legible and durable, not at sending it
// anywhere. Dynamically imported for the same reason mailLabelsSink/vaultNotesSink are —
// op-engine's non-vault ops never pull obsidian's GitHub-API dependency graph into their module
// load. One note per conflict, keyed by the same medOrg/medId/allergyOrg/allergyId tuple
// detectMychartConflictDrops (_agenda.ts) dedupes on, so a re-approved batch overwrites its own
// prior draft rather than accumulating duplicates. A malformed item (missing any field) is
// skipped, not a hard failure; an empty batch is a no-op.
function mychartOutreachSink(env: RtEnv): SinkTarget {
	return {
		name: "mychart-outreach",
		async write(input: any): Promise<any> {
			const items: Array<{ medOrg?: unknown; medId?: unknown; medName?: unknown; allergyOrg?: unknown; allergyId?: unknown; allergySubstance?: unknown; summary?: unknown; draftMessage?: unknown }> = Array.isArray(input) ? input : [];
			if (!items.length) return { drafted: 0 };
			const { obsidian } = await import("../fns/obsidian.js");
			let drafted = 0;
			let failed = 0;
			for (const it of items) {
				const medOrg = typeof it?.medOrg === "string" ? it.medOrg : "";
				const medId = typeof it?.medId === "string" ? it.medId : "";
				const allergyOrg = typeof it?.allergyOrg === "string" ? it.allergyOrg : "";
				const allergyId = typeof it?.allergyId === "string" ? it.allergyId : "";
				const draftMessage = typeof it?.draftMessage === "string" ? it.draftMessage : "";
				if (!medOrg || !medId || !allergyOrg || !allergyId || !draftMessage) continue;
				const summary = typeof it?.summary === "string" ? it.summary : "";
				const path = `MyChart Outreach/${medOrg}-${medId}--${allergyOrg}-${allergyId}.md`;
				const content = `# MyChart outreach draft\n\n${summary ? `**Summary:** ${summary}\n\n` : ""}**Draft message (review before sending — nothing here has been sent):**\n\n> ${draftMessage}\n`;
				const w = await obsidian.run(env, { action: "write", path, content, backend: "git" });
				if (w.isError) {
					failed++;
					continue;
				}
				drafted++;
			}
			return { drafted, groups: items.length, ...(failed ? { failed } : {}) };
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
