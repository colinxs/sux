import { type Fn, ok } from "../registry";
import { oj } from "./_util";
import { hasMailTriage, hasMailTriageAct } from "./_mail_triage";
import { hasDropboxFull } from "./_dropbox-full";
import { canOpenPr, hasSelfImprove, isKilled } from "./_self_improve";
import { hasBriefing, hasBriefingStageDrafts } from "./_briefing";
import { hasWeeklyRecall } from "./_weekly_recall";

// "What can act on my behalf right now" — a single read-only mirror of the Worker-side
// autonomy gates. Several consequential surfaces (mail-triage, Mode-B Dropbox writes,
// the self-improve PR loop, the manual cron trigger) are each armed by their own env
// flag and are invisible AS A SET: the biggest risk as the pipeline grows is losing
// track of which bounds are live. This fn is that mirror. Strictly read-only — it makes
// NO upstream call and NEVER prints a secret value: every field is a boolean derived
// from the SAME gate helpers the loops themselves fail-closed on, so the report can't
// drift from what actually gates behavior. GitHub-side gates (branch auto-merge rule,
// the CI GATE_SECRET tier) live in the repo, not in the Worker env, so they're out of
// this fn's honest reach — it reports what the running Worker can truthfully observe.

// A surface = one autonomous capability, its consequence, and whether it's armed. `armed`
// is the operative live-or-dormant bit; `mode` names the sub-gate state without any value.
type Surface = { surface: string; armed: boolean; mode: string; reversible: boolean; consequence: string };

export const autonomy_status: Fn = {
	name: "autonomy_status",
	description:
		"Read-only mirror of which autonomous, act-on-your-behalf surfaces are ARMED right now — one call instead of grepping GitHub secrets + wrangler vars + 1Password. Reports the Worker-side consequential gates as booleans (never their secret VALUES, never any upstream call): the mail-triage bot (dormant / suggest-only / reversible auto-act), Mode-B whole-Dropbox writes (dormant vs. armed behind the dry-run-by-default firewall), the self-improve loop (killed / dormant / suggest-only / may-open-PR), the manual cron trigger endpoint, the morning briefing (dormant / digest-only / stages reply drafts), and the weekly-recall digest (read-only, vault-append only). Each surface carries its consequence + whether its acts are reversible. Returns JSON { armed_count, armed:[names], surfaces:[{surface, armed, mode, reversible, consequence}], note }. GitHub-side gates (branch auto-merge rule, CI GATE_SECRET tier) live in the repo not the Worker, so they're deliberately out of scope. Never cached.",
	inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
	cacheable: false,
	annotations: { readOnlyHint: true, openWorldHint: false },
	run: async (env) => {
		const triageOn = hasMailTriage(env);
		const triageAct = hasMailTriageAct(env);
		const dropboxFull = hasDropboxFull(env);
		const selfKilled = isKilled(env);
		const selfOn = hasSelfImprove(env);
		const selfPr = canOpenPr(env);
		const cronTrigger = Boolean(env.SUX_CRON_TOKEN);
		const briefingOn = hasBriefing(env);
		const briefingDrafts = hasBriefingStageDrafts(env);
		const weeklyRecall = hasWeeklyRecall(env);

		const surfaces: Surface[] = [
			{
				surface: "mail_triage",
				armed: triageAct,
				mode: !triageOn ? "dormant" : triageAct ? "auto-act (reversible ops only)" : "suggest-only",
				reversible: true,
				consequence: "labels / archives / unarchives / undeletes inbox mail — reversible ops only, confidence-gated, one-call bulk-undo. Never deletes or files into Junk.",
			},
			{
				surface: "dropbox_full_write",
				armed: dropboxFull,
				mode: dropboxFull ? "armed (dry-run by default, confirm on delete)" : "dormant",
				reversible: true,
				consequence: "whole-account Dropbox write/move/delete behind the plan→confirm firewall. Recoverable via version history + Dropbox 'Deleted files' + a pre-op /.sux-trash copy.",
			},
			{
				surface: "self_improve",
				armed: selfOn,
				mode: selfKilled ? "killed" : !selfOn ? "dormant" : selfPr ? "may open PRs (auto-author off, never merges)" : "suggest-only (review, no PR)",
				reversible: true,
				consequence: "reads the feedback queue and, at most, opens a stub PR labeled `self-improve` (NOT auto-merge-eligible). Never authors, never merges — a human decides.",
			},
			{
				surface: "cron_trigger",
				armed: cronTrigger,
				mode: cronTrigger ? "armed (bearer-gated POST /admin/tick)" : "dormant (endpoint 404s)",
				reversible: true,
				consequence: "lets a bearer-holding operator run a mail-triage / self-improve / maintenance cycle on demand. Only triggers the above loops — subject to their own gates.",
			},
			{
				surface: "briefing",
				armed: briefingDrafts,
				mode: !briefingOn ? "dormant" : briefingDrafts ? "auto-act (stages reply drafts)" : "suggest-only (digest, no drafts)",
				reversible: true,
				consequence: "stages reply drafts to Drafts off flagged personal mail — NEVER sends. Drafts sit editable/deletable and the digest append is git-reversible.",
			},
			{
				surface: "weekly_recall",
				armed: weeklyRecall,
				mode: weeklyRecall ? "armed (read-only, appends a weekly digest note)" : "dormant",
				reversible: true,
				consequence: "reads your vault/mail/web once a week and appends a recall digest note — read-only + vault-append only, git-reversible. Never sends or deletes.",
			},
		];

		const armed = surfaces.filter((s) => s.armed).map((s) => s.surface);
		return ok(
			oj({
				armed_count: armed.length,
				armed,
				surfaces,
				note: "Worker-side gates only, read live from env — no secret values, no upstream calls. GitHub-side gates (auto-merge rule, CI GATE_SECRET tier) live in the repo, not here.",
			}),
		);
	},
};
