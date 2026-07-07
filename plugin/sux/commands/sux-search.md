---
description: Web search through the sux residential proxy (Kagi, DuckDuckGo, Google, Brave, or all).
---

Run a web search for **$ARGUMENTS** using the sux MCP connector.

Guidance:
- Default to the `search` tool (Kagi) for a general query — pass `query` and, if
  useful, `limit`, `workflow` (news/videos/podcasts/images), or domain/time
  scoping (`include_domains`, `time_relative`, `after`, `before`).
- For a cross-engine sweep or when Kagi isn't configured, use `web_search` with
  `engine:"all"` and `summarize:true` to fan out (kagi/ddg/google/brave), dedupe
  by URL, and get a cited briefing. `engine:"ddg"` is a good keyless default.
- Present numbered results with titles and URLs, and cite sources by number.
- If a promising result is JS-heavy or blocked when you go to read it, fetch it
  with `scrape`, or `render` (escalate to `backend:"mac"` for bot-walled sites).
