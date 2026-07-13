# Personal-AI landscape, 2026 — where we're going

Grounding pass for master-plan Track D. Not exhaustive — a working read for Colin, once.
Sources cited inline; searched mid-2026.

## Adopt

**1. Memory as a typed, decaying primitive — not a vector-DB afterthought.**
2026's real shift in agent memory is treating it as structured cognition: facts, evolving
beliefs, and threads that get consolidated or deliberately forgotten, not an undifferentiated
embedding blob ([mem0 state-of-memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).
sux's `recall` already separates vault/mail/files as namespaces — the gap is a **decay/consolidation
pass**, not more retrieval surface. Concretely: give `recall`'s knowledge-graph work (Track B) a
"stale fact" flag and a periodic consolidation fn, instead of only ever appending.

**2. MCP's stateless-core direction fits sux's Worker model natively.**
The 2026-07-28 MCP spec RC drops the session-sticky requirement — any request can land on any
instance, which is exactly how Cloudflare Workers already run
([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)). No
architecture change needed; just don't accidentally add session affinity when adopting the new
Tasks extension for long-running fns (recall/research jobs) — poll-based async is now a first-class
protocol primitive, not a bespoke thing sux has to invent.

**3. Git-as-control-layer for the autonomous pipeline is validated, not just convenient.**
2026 practice explicitly frames git as an *active* control layer for agent autonomy — atomic
commits, attribution trailers, tiered auto-merge (safe categories auto-merge, features/security
gated) — which is precisely sux's Track A/E model already
([git-with-coding-agents 2026](https://marketingagent.blog/2026/03/22/how-to-use-git-with-coding-agents-a-complete-2026-guide/);
Stripe's tiered pattern cited in the same sweep). Nothing to change here — this is confirmation the
"git is the undo" cardinal rule is the industry's converged answer, not a personal shortcut.

**4. Read-only-first, write-gated-second sequencing for new capabilities.**
Best-practice guidance for MCP servers in 2026 is explicit: ship read/search/draft first, add
write actions later behind human approval
([WorkOS MCP 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026)).
This is already sux's mail-automation stance (Track B: "gated-dormant, deliberate switch") — keep
applying it to every new namespace verb, not just mail.

## Avoid

**1. Multi-agent orchestration for its own sake.**
The data is unambiguous: 60% of enterprises piloting multi-agent systems never reached production;
independent benchmarking found single agents matched or beat multi-agent setups on 64% of tasks,
with multi-agent adding ~2 points of accuracy at ~2x cost
([Iterathon 2026](https://iterathon.tech/blog/multi-agent-orchestration-economics-single-vs-multi-2026)).
sux is single-user with one task scheduler — resist the temptation to spin up persistent
sub-agent swarms for the learn→research→advise loop. Fan-out subagents for *bounded, throwaway*
work (already the pattern here) is fine; standing multi-agent orchestration is not worth the
complexity tax for one user's workload.

**2. Heavy agent frameworks (LangChain-style orchestration layers).**
The "orchestration framework trap": frameworks that accelerate week one become structural debt by
month seven, because failures happen inside framework internals with no natural debug point
([tianpan.co 2026](https://tianpan.co/blog/2026-04-19-orchestration-framework-trap-langchain-production)).
sux's raw-fn-registry-on-a-Worker approach (no agent framework, just typed fns + MCP) is already
the avoided-trap path — don't reach for one when the learn/research/advise loop gets built; keep
it as composed fns, not a framework-owned control flow.

**3. Chasing "second brain" feature completeness.**
The second-brain product category in 2026 is racing toward "Brain Health" dashboards, automation
of task-creation, live app generation from notes, etc.
([MindStudio](https://www.mindstudio.ai/blog/what-is-ai-second-brain)). Most of that is
productization surface for a market of many users comparing tools — it doesn't compound for a
single-user system where the "market" is one person's actual recall needs. Don't let Track B scope
creep toward feature-parity with second-brain products; sux's bar is "does Colin's own recall get
better," not "does this match what Mem0/Obsidian-AI ship."

**4. Protocol churn chasing.**
MCP is mid-flight on a major revision (Tasks, Apps/UI extension, OAuth 2.1 alignment,
Linux-Foundation governance handoff) ([MCP roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)).
Adopt the stateless/Tasks pieces when they solidify past RC — don't build against a moving spec
surface for speculative future compatibility now.

## The one bet

**Ship the memory decay/consolidation pass before any new recall surface area.** Concretely: add a
staleness marker + periodic consolidation fn to the vault knowledge-graph work already scoped in
Track B, before building anything new on top of `recall`. This is the single highest-leverage
2026-landscape finding for sux specifically — every competing personal-AI system (mem0, second-brain
tools) is converging on "typed memory that forgets" as the differentiator that actually improves
answer quality over time, and it's a bounded, KISS-compatible addition (one fn + one scheduled
sweep) that doesn't require a framework, a new agent, or new infra. It directly compounds
Track B's existing "deepen the digital-life spine" work rather than competing with it, and it's the
one item on this list that both fits sux's constraints (single user, difficulty-scoped, git-undo)
*and* addresses a genuine gap sux doesn't have today.
