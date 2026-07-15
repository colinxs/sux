#!/usr/bin/env node
// Flag a newly-added npm dependency before it merges — a cheap backstop against a
// hallucinated/typosquatted package name slipping through issue-build.yml's
// unattended `npm ci`/install step with no human reviewing the dependency list (#473).
// Not a substitute for real supply-chain scanning (Socket, npm audit signatures) —
// just a diff + a required label, so a genuinely new name gets one human look.
//
// Run as a PR-only CI step:
//   BASE_SHA=<base ref/sha> PR_LABELS='["a","b"]' node scripts/guard-new-deps.mjs
//
// Exit codes: 0 no new deps (or already labeled) · 1 new deps need the `new-dependency` label.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUIRED_LABEL = "new-dependency";

const baseSha = process.env.BASE_SHA;
if (!baseSha) {
	console.log("guard-new-deps: no BASE_SHA (not a pull_request run) — skipping.");
	process.exit(0);
}

const depKeys = (pkg) => new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);

const head = depKeys(JSON.parse(readFileSync("package.json", "utf8")));
let base;
try {
	base = depKeys(JSON.parse(execFileSync("git", ["show", `${baseSha}:package.json`], { encoding: "utf8" })));
} catch (e) {
	console.log(`guard-new-deps: couldn't read package.json at base ${baseSha} (${e.message}) — skipping.`);
	process.exit(0);
}

const added = [...head].filter((k) => !base.has(k)).sort();
if (!added.length) {
	console.log("guard-new-deps: no new dependencies.");
	process.exit(0);
}

console.log(`guard-new-deps: new dependenc${added.length === 1 ? "y" : "ies"}: ${added.join(", ")}`);

let labels = [];
try {
	labels = JSON.parse(process.env.PR_LABELS ?? "[]");
} catch {
	labels = [];
}
if (labels.includes(REQUIRED_LABEL)) {
	console.log(`guard-new-deps: '${REQUIRED_LABEL}' label present — a human has looked at this. OK.`);
	process.exit(0);
}

console.error(
	`guard-new-deps: this PR adds ${added.length === 1 ? "a dependency" : "dependencies"} not on main (${added.join(", ")}).\n` +
		`An LLM can recommend a package name that doesn't exist or is typosquatted, so a genuinely new dependency needs one human look before it merges.\n` +
		`Add the '${REQUIRED_LABEL}' label to this PR after checking the name(s) on npm (publisher, download count, age) — then re-run this check.`,
);
process.exit(1);
