---
title: Learning-substrate — embeddings + storage decision (research-backed)
status: reference
source: research 2026-07-12 (CF Workers AI catalog + Vectorize limits/pricing)
---

**Model: `@cf/baai/bge-m3`.** Cheapest of the family (~$0.012/M tok — below bge-small),
1024-d, multilingual (email/tasks aren't guaranteed English), ~8k context, L2-normalized
output (so cosine == dot product). Fallback: `bge-small-en-v1.5` (384-d) if English-only +
minimizing vector footprint. Avoid bge-large (3× cost, no quality edge).

**Storage: roll-your-own in KV, brute-force cosine in the Worker — NOT Vectorize** for a
small labeled set (hundreds–low-thousands). 2,000 × 1024 f32 = 8 MB (under KV's 25 MiB value
cap); load the set once, cache in Worker memory, scan in-process (sub-ms — embedding latency
dominates). Vectorize is Workers-Paid-only + a network round-trip + write lag — no benefit at
this scale. **Switch to Vectorize past ~10k vectors** or when you need metadata-filtered kNN.

```ts
const { data } = await env.AI.run("@cf/baai/bge-m3", { text: [itemText] }); // batch: string[]
const q = data[0] as number[];                       // 1024-d, unit-norm
const dot = (a:number[],b:number[]) => { let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s; };
const topK = labeled.map(e => ({label:e.label, s:dot(q,e.vec)}))
                    .sort((a,b)=>b.s-a.s).slice(0,5);  // majority / score-weighted vote → label
```
Precompute label vectors at label time; embed only the incoming item per classify.

**Cost:** ~$0.0006 per 1,000 classifications (subject+snippet ≈ 50 tok); free tier covers
~185k/day. KV scan ≈ $0. Rounding error.

Refs: developers.cloudflare.com/workers-ai/models/bge-m3/ · /workers-ai/platform/pricing/ · /vectorize/platform/limits/
