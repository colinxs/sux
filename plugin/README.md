# sux — Claude Code plugin

A companion **Claude Code plugin** for the personal **sux** MCP server
(`https://sux.colinxs.workers.dev/mcp`) — a Cloudflare Worker that exposes ~78
edge tools: residential web search, scrape/render (with a CapSolver-backed mac
browser tier), crawl/extract, retailer product search, format transforms,
storage, and Workers-AI text tools.

The plugin doesn't ship the tools — those live in the MCP server. It ships the
**skills and slash commands** that teach Claude *when* and *how* to route work to
the sux tools, grounded in their real names and arguments.

## What's inside

```
plugin/
├── README.md
├── .claude-plugin/
│   └── marketplace.json          # single-plugin marketplace (owner: colinxs)
└── sux/                          # the plugin
    ├── .claude-plugin/
    │   └── plugin.json           # plugin manifest (name "sux", v0.1.0)
    ├── skills/
    │   ├── sux-web/SKILL.md      # search / scrape / render / crawl / extract
    │   ├── sux-retail/SKILL.md   # retailer product search + store locator
    │   └── sux-data/SKILL.md     # transforms / storage / Workers-AI text
    └── commands/
        ├── sux-search.md         # /sux:sux-search — web search
        ├── sux-shop.md           # /sux:sux-shop  — retailer product search
        └── sux-render.md         # /sux:sux-render — fetch/screenshot, escalate to mac
```

Skills auto-discover from `skills/<name>/SKILL.md` and become
`/sux:sux-web`, `/sux:sux-retail`, `/sux:sux-data`. Commands auto-discover from
`commands/*.md` as `/sux:sux-search`, `/sux:sux-shop`, `/sux:sux-render`.

## Requirements

This plugin is only useful with the **sux MCP connector configured**. Add it as a
connector in your Claude client (claude.ai connector settings) or via
`claude mcp` / `/mcp`, pointing at:

```
https://sux.colinxs.workers.dev/mcp
```

Without that connector the skills and commands will reference tools that aren't
available.

## Install

From this directory's parent (the repo root), add the marketplace by path, then
install the plugin:

```
/plugin marketplace add ./plugin
/plugin install sux@sux
```

`./plugin` is the folder containing `.claude-plugin/marketplace.json`; you can
also pass the file directly (`/plugin marketplace add ./plugin/.claude-plugin/marketplace.json`)
or an absolute path. `sux@sux` is `<plugin-name>@<marketplace-name>` — both are
named `sux` here.

Verify and manage:

```
/plugin marketplace list
/plugin list
/plugin marketplace update sux     # after editing the plugin
```

## Usage

Once installed and with the connector configured:

- Ask a normal question ("what's the latest on …", "cheapest cordless drill at
  Home Depot", "convert this CSV to JSON") and the matching skill guides Claude
  to the right sux tool.
- Or invoke a command directly:
  - `/sux:sux-search <query>` — residential web search (Kagi / DDG / Google / Brave / all).
  - `/sux:sux-shop <product>` — retailer product search with a normalized
    price/stock comparison.
  - `/sux:sux-render <url>` — fetch or screenshot a page, escalating to the
    residential mac backend (and captcha solve) for bot-walled sites.
