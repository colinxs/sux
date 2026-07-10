---
title: Unblocked / Gated Law
status: designed
cluster: namespaces
type: concept
tags: [sux, namespaces, designed]
updated: 2026-07-09
related: ["[[handle-discipline]]", "[[namespace-architecture]]", "[[files]]", "[[mail]]", "[[domains]]"]
---

# Unblocked / Gated Law

**Source:** [[domains]]

The governance law that decides which actions Claude may take without confirmation across every sux domain: **"unblocked where git can undo; gated where the world can't."** A reversible action — anything landing as a git commit, or anything living inside a credential-scoped folder with its own version history — runs freely, no confirm dance. An irreversible or outward-facing action — sending an email, sending an iMessage, RSVPing, minting a masked address, destroying a record in a third-party system — sits behind an explicit boolean gate, typically `allow_send` or `allow_destroy`.

The law is paired with three transport classes that every domain falls into exactly one of, so the routing skill asks one question per domain rather than nine bespoke ones. It is applied concretely by [[jmap]] (D4–D6: `allow_destroy` on any `Email/set{destroy}` or persistent-egress method like `VacationResponse/set`) and by [[mail]] and [[files]] as consumers.

The design is explicit about what the gates actually defend: **accidental mutation only.** They are LLM-set booleans, so a prompt injection can flip them — they are not an injection boundary, and the docs say so rather than overselling safety. The real containment for a truly irreversible action is a scoped, ideally read-only, credential plus out-of-band confirmation the MCP surface itself cannot provide. Vault writes are the canonical unblocked case (locked decision predating this doc) precisely because git is always the undo — see [[handle-discipline]] for the sibling rule governing how those writes move bytes.
