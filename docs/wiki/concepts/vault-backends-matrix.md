---
title: Vault Backends Matrix
status: designed
cluster: namespaces
type: concept
tags: [sux, namespaces, designed]
updated: 2026-07-09
related: ["[[vault-stack]]", "[[vpc-hosting]]", "[[vault-backends]]", "[[mcp-gate]]", "[[Namespaces-MOC]]"]
---

# Vault Backends Matrix

**Source:** [[vault-backends]]

Four implementations behind the `obsidian` fn's `backend` dispatch, covering the stateful notes namespace served at `/vault/mcp`. **`git`** talks to GitHub REST against `colinxs/obsidian-vault` @ `main` — always-on, no box or LAN required, and the correctness floor of the whole system: every write lands as a revertible commit. **`vpc`** is live headless Obsidian reached over Workers VPC plus `cloudflared` on the home box — the primary cloud path once built, giving the `/vault/mcp` cloud connector live-vault capability without depending on a box being awake at request time. **`obsidian`** is the Mac-live backend reached over Tailscale, used when a tailnet desktop is present. **`local-git`** is a direct filesystem clone, the local-ops counterpart to `git`.

Only the two live-Obsidian implementations — `vpc` and `obsidian` — carry full-text search and Dataview DQL; the two git-based implementations (`git`, `local-git`) cannot full-text-search a private repo, because GitHub's code search is dead on private repos and a clone can only grep. This is the accepted v1 gap: cloud full-text search waits on `vpc`, and desktop keeps live-vault search via [[mcp-gate]] to `obsidian` in the meantime.

Because multiple implementations can write concurrently, a **write-master rule** keeps exactly one realtime writer active at a time to avoid git conflicts — whichever live-Obsidian box (`vpc` or `obsidian`) is currently interactive-write master runs `obsidian-git` to commit and pull, and the moment it loses that status it must stop writing. `git` remains the sync **bus** every backend eventually reconciles through. See [[vpc-hosting]] for how the `vpc` backend's Workers VPC + `cloudflared` path is provisioned.
