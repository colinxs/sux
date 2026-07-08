# sux — the core and the tools on it

The core is a **knowledge store**: one git repo of markdown notes. Two clients read and write it — Claude (through the `obsidian` verb) and Obsidian (the human editor, git-syncing the same repo). Everything else is a tool built on top of that store.

That is the whole architecture. This doc supersedes the earlier ten-proposal sprawl — those are parked reference, not the plan.

## The core: the knowledge store

One git repo. Markdown files. It already exists — it is the `obsidian` verb's git backend ([obsidian.ts](../../sux/src/fns/obsidian.ts)) pointed at a single repo (`OBSIDIAN_VAULT_REPO`, `GITHUB_TOKEN` for search + writes):

| op | what it does |
|---|---|
| `list` | every `.md` in the repo (optionally under a folder) |
| `read` | a note by path |
| `search` | keyword across the repo (GitHub code search) |
| `append` | write to a note, creating it if absent — a versioned commit |

Two clients, one repo, git as the sync layer: Claude appends a note → it lands in the repo → obsidian-git pulls it into the vault, and vice-versa. No database, no `KbRecord`, no separate KB vault — **all knowledge, one repo.**

Small gaps to fill so it's a solid primitive (each a few lines on the existing fn): `write` (overwrite a whole note, not just append), `edit` (replace a line/section — needed to check off a task), `delete`. Everything below assumes these land.

## The pattern: a tool is markdown convention + store ops

Every tool built on the core is the same shape: **a markdown convention** (how the thing is written in a note) plus **store operations** (create by `append`, find by `search`+`read`, change by `edit`). No new storage, no third-party API — the tool is just an opinion about markdown plus the four verbs above. This is why "build other tools off of it" is cheap: the tool is a format and a few reads/writes, not an integration.

## Tool 1 — productivity, emulated in Obsidian

Drop Todoist. Tasks live in the vault as [Obsidian Tasks](https://publish.obsidian.md/tasks/) markdown — checkboxes with emoji metadata — so the same tasks are first-class in the human editor (query, check off, see on the calendar) and fully readable/writable by Claude. The productivity-skill feature set maps straight onto the convention:

| productivity concept | Obsidian markdown |
|---|---|
| task | `- [ ] Buy milk` |
| due date | `📅 2026-07-15` |
| scheduled / start | `⏳ 2026-07-14` / `🛫 2026-07-12` |
| priority p1–p4 | `🔺` / `⏫` / `🔼` / `🔽` |
| labels | `#errand #home` |
| recurring | `🔁 every week` |
| project / section | a note (or folder) that holds the tasks |
| complete | `- [x] Buy milk ✅ 2026-07-10` |

The operations are thin wrappers over the core:

- **add task** → `append` a formatted line to the inbox note (or a project note, or today's daily note).
- **list / query** (today, overdue, `#label`, by priority) → `search` the vault for `- [ ]` lines, parse the emoji metadata, filter.
- **complete** → `edit` the task line: `[ ]`→`[x]` and append `✅ <today>`.
- **projects** → a note per project; its tasks are the `- [ ]` lines under it.

That's the entire productivity tool: one formatter, one parser, four store ops. Obsidian's own Tasks/Dataview plugins then give the human calendar views and queries for free, over the exact same files Claude writes.

## Later tools, same shape

- **capture from email** → `jmap` reads an email, `append`s it as a note. Email becomes knowledge in the one repo.
- **daily note / journal** → `append` to `daily/YYYY-MM-DD.md`.
- **ask** → `search` the vault, `read` the top hits, answer with citations. Not a new engine — two store ops and Claude.

Each is a convention plus reads/writes. None of them need their own storage, because there is only one store.

## Explicitly not the core

The web `search`/`shop`/`travel`/algebra corpus is a separate, unrelated tool — a retrieval engine over the open web. It does not share the knowledge store and should not be entangled with it. Parked.

## Next step

Confirm `OBSIDIAN_VAULT_REPO` + `GITHUB_TOKEN` are set and the round trip works (Claude `append`s → repo → Obsidian syncs), fill the `write`/`edit`/`delete` gaps on the obsidian fn, then build the productivity tool as the first thing on top.
