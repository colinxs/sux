---
title: Architecture — shipped sux Worker topology
status: living
cluster: infrastructure
type: reference
summary: "Live topology of the sux Worker — every namespace, binding, and external dependency in one mermaid diagram, colour-coded by deployment status (live/dormant/blocked/planned)."
tags: [sux, infrastructure, architecture]
updated: 2026-07-11
---

# Architecture

The shipped topology of the sux Worker — every namespace, binding, and external
dependency, colour-coded by deployment status (🟢 live · 🟡 dormant · 🔴 blocked ·
⚪ planned). The legend that decodes the status glyphs is at the bottom of the diagram.

```mermaid
flowchart TB
  classDef live fill:#0b3d0b,stroke:#3fbf3f,color:#eaffea;
  classDef dormant fill:#3d360b,stroke:#d4b53f,color:#fffbe6;
  classDef blocked fill:#3d0b0b,stroke:#d45050,color:#ffecec;
  classDef planned fill:#20242b,stroke:#6b7280,color:#cbd5e1,stroke-dasharray:4 3;
  classDef infra fill:#0b2a3d,stroke:#3f9fd4,color:#e6f6ff;

  CL["MCP clients<br/>Code · CLI · Cowork · Desktop"]:::infra
  CL -->|"tools/list = 16 front verbs + <b>sux</b> + <b>fn</b> escape"| FD

  subgraph W["sux · one Cloudflare Worker · single /mcp surface"]
    direction TB
    FD["<b>front door</b> 🟢<br/>surface=front hides ~95 leaves<br/>fn(…) → any leaf (weighted cost, anti-obfusc)"]:::live
    G["<b>smart-guards</b> 🟢<br/>staged() default-ON by annotation<br/>!/force to commit · conscience-lint"]:::live
    TB2["<b>fan-out budget</b> 🟢<br/>pool() 50s < 60s deadline<br/>partial-return {truncated}"]:::live
    FD --> G --> TB2
  end

  %% ---------- WEB RETRIEVAL LADDER ----------
  subgraph WEB["web retrieval — escalation ladder"]
    direction TB
    S1["search 🟢<br/>Kagi/Google/Brave/DDG/Tavily/Exa"]:::live
    S2["scrape 🟢 (residential proxy)"]:::live
    S3["render:cf 🟢<br/>CF Browser Rendering + stealth"]:::live
    S4["render:mac 🟡 dormant<br/>patched browser + solver"]:::dormant
    S5["unlocker 🔴 needs UNLOCKER_API_*<br/>Zyte (primary) / Bright Data"]:::blocked
    S1 --> S2 --> S3 -->|"bot-WALL detected<br/>(Akamai/PerimeterX)"| S4 -->|both miss| S5
  end
  TB2 --> WEB
  WEB -.->|residential egress| TS["Tailscale proxy 🟢<br/>(home IP)"]:::infra
  S4 -.->|HMAC ts-fresh, replay-blocked| MAC["mac node 🟡<br/>SPOF, retiring"]:::dormant

  %% ---------- TRANSFORM ----------
  subgraph X["transform (pre-LLM)"]
    direction TB
    T1["declutter + adblock ⚪<br/>@ghostery/adblocker + HTMLRewriter"]:::planned
    T2["pack JSON→TSV 🟢 · compact-JSON ⚪"]:::planned
    T3["gzip compress ⚪ (native CompressionStream)"]:::planned
  end
  WEB --> X

  %% ---------- AI ----------
  subgraph AI["Workers AI (edge, private)"]
    E["bge-m3 embeddings 🟢<br/>→ kNN classify (learn)"]:::live
    SUM["summarize / translate / redact 🟢"]:::live
  end
  X --> AI

  %% ---------- STORES / STATE ----------
  subgraph ST["stores & state"]
    direction TB
    KV["<b>KV</b> 🟢<br/>result cache (single-flight, SWR)<br/>learned vectors · cursors · gates"]:::live
    R2["<b>R2</b> 🟢<br/>blobs /s/&lt;uuid&gt; immutable cache"]:::live
    VA["<b>vault</b> (Obsidian) 🟢<br/>git + remote backend · content index ⚪"]:::live
    DBX["<b>Dropbox</b> 🟢<br/>Mode A app-folder · Mode B whole-acct (gated, staged)"]:::live
  end
  AI --> ST
  X --> ST

  %% ---------- MAIL ----------
  subgraph M["mail · Fastmail JMAP"]
    MV["mail verbs 🟢<br/>search/read/move · send (staged, no undo)"]:::live
    MT["<b>mail-triage bot</b> 🟢 LIVE<br/>classify+suggest+digest ON · mutation (MAIL_TRIAGE_ACT) dormant<br/>egress-free · reversible-only · never deletes"]:::live
  end
  TB2 --> M
  MT -->|label/move/junk only| MV

  %% ---------- SELF-IMPROVE ----------
  SI["<b>self-improve loop</b> 🟡 DORMANT<br/>daily cron no-ops until armed<br/>kill-switch wins · security→PR always · rate-cap const<br/>auto-merge only safe lane when armed"]:::dormant
  W --> SI
  SI -.->|opens PRs when armed| GH["GitHub 🟡 token set · self-improve dormant until SELF_IMPROVE_ENABLE"]:::dormant

  %% ---------- HEALTH (planned) ----------
  subgraph H["personal data (planned/PR)"]
    UW["uw directory ⚪<br/>scrape directory.uw.edu · PWS cert opt"]:::planned
    MC["mychart ⚪ PHI<br/>SMART-on-FHIR (Epic) · edge-private"]:::planned
    AH["apple health ⚪<br/>webhook /health/ingest (gated token)"]:::planned
  end
  TB2 --> H
  H --> VA

  %% ---------- HTTP compression (transport) ----------
  CFED["CF edge auto-compress 🟢<br/>brotli / gzip / zstd (Accept-Encoding)"]:::infra
  W --- CFED
  CL --- CFED
```

**Legend** — 🟢 live in prod · 🟡 merged but DORMANT (needs a flag to arm) · 🔴 blocked on a secret/token · ⚪ designed/PR/planned
