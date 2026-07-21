#!/usr/bin/env node
// branch-protection-check — asserts main's branch protection (specifically
// required_status_checks) hasn't been silently flipped off. Per
// docs/design/generalized-watchdog-debug.md's "Next" section: this is one of the
// three thin missing edges the watchdog design calls for (#1076).
//
//   node scripts/branch-protection-check.mjs           (report; exit 1 on drift)
//   node scripts/branch-protection-check.mjs --json    (machine-readable)
//
// Token: GH_BILLING_TOKEN (falls back to GH_TOKEN/GITHUB_TOKEN) — same PAT
// scripts/billing-check.mjs uses, since reading branch protection also needs
// admin-level repo access the default Actions token doesn't have.
import { pathToFileURL } from "node:url";

const REPO = process.env.GH_BILLING_REPO ?? "SuxOS/sux";
const BRANCH = process.env.BRANCH_PROTECTION_BRANCH ?? "main";

async function ghJson(path, token) {
	const res = await fetch(`https://api.github.com${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
	});
	let body = null;
	try {
		body = await res.json();
	} catch {
		// non-JSON body (rare) — status alone still drives the verdict below
	}
	return { status: res.status, body };
}

export async function checkBranchProtection() {
	const token = process.env.GH_BILLING_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (!token) return { state: "skip", note: "no GH_BILLING_TOKEN/GITHUB_TOKEN in env" };

	const { status, body } = await ghJson(`/repos/${REPO}/branches/${BRANCH}/protection`, token);

	// 403 = this token lacks admin/read access to branch protection — degrade to
	// skip (same as billing-check.mjs), NOT a pass: an unverifiable state must
	// never be reported as healthy.
	if (status === 403) return { state: "skip", note: "HTTP 403 — token lacks admin access; set GH_BILLING_TOKEN (PAT with repo admin)" };
	// 404 on THIS endpoint means the branch is unprotected (or doesn't exist) —
	// exactly the drift this check exists to catch, not a soft skip.
	if (status === 404) return { state: "breach", note: `${BRANCH} has no branch protection (HTTP 404)` };
	if (status !== 200 || !body) return { state: "breach", note: `unexpected HTTP ${status} reading branch protection` };

	const rsc = body.required_status_checks;
	const contexts = [...(rsc?.contexts ?? []), ...(rsc?.checks ?? []).map((c) => c?.context)].filter(Boolean);
	if (!rsc || contexts.length === 0) return { state: "breach", note: `${BRANCH}'s required_status_checks is missing or has zero required contexts` };

	return { state: "ok", note: `${contexts.length} required context(s): ${contexts.join(", ")}` };
}

async function main() {
	const asJson = process.argv.includes("--json");
	const result = await checkBranchProtection();
	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(`branch-protection (${BRANCH}): ${result.state}${result.note ? ` — ${result.note}` : ""}`);
	}
	process.exit(result.state === "breach" ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
