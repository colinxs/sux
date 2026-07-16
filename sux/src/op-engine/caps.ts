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
		async markdownFromPdf(_bytes: Uint8Array): Promise<string> {
			// The PDF→markdown leaf (suxlib domain `extract`) belongs to the cluster-E PDF
			// pipeline, not this MVP's echo path. Wire it there against the real Workers-AI
			// toMarkdown surface rather than guess an unverified API here.
			throw new Error("run: markdownFromPdf is not wired in the MVP caps (cluster E).");
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
	return { r2: publisher("r2", "published/"), vault: publisher("vault", "vault/") };
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
