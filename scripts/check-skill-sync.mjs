#!/usr/bin/env node
// Keep the sux skill, its plugin copy, and the generated function reference
// honest — all derived from the repo itself, no live server required.
//
// Truth lives in source:
//   sux/src/fns/*.ts  --(npm run docs)-->  sux/FUNCTIONS.md   (the tool inventory)
//   sux/FUNCTIONS.md  --------------------> .claude/skills/sux/SKILL.md  (every fn named)
//   .claude/skills/   --------------------> plugins/sux/skills/          (byte-for-byte mirror)
//
// Modes:
//   node scripts/check-skill-sync.mjs            offline, source-derived check (default)
//   node scripts/check-skill-sync.mjs --offline  same as default (explicit)
//   node scripts/check-skill-sync.mjs --live      also probe SUX_MCP_URL and diff the
//                                                 deployed tools/list against FUNCTIONS.md
//   node scripts/check-skill-sync.mjs --write     regenerate FUNCTIONS.md + re-mirror the
//                                                 plugin skill dir (fix mode)
//
// Env (only for --live):
//   SUX_MCP_URL    the /mcp endpoint of the deployed server
//   SUX_MCP_TOKEN  bearer token, if the endpoint is auth-gated (optional)
//
// Exit codes: 0 in sync · 1 drift found · 2 misconfigured/unreachable

import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const R = (...p) => join(ROOT, ...p);

const GEN_DOCS = R('sux', 'scripts', 'gen-docs.mjs');
const FUNCTIONS = R('sux', 'FUNCTIONS.md');
const REGISTRY = R('sux', 'src', 'registry.ts');
const SKILL = R('.claude', 'skills', 'sux', 'SKILL.md');
const SKILLS_DIR = R('.claude', 'skills');
const PLUGIN_SKILLS_DIR = R('plugins', 'sux', 'skills');
const SNIPPET = R('docs', 'claude-profile-snippet.md');

const has = (flag) => process.argv.includes(flag);
const mode = has('--write') ? 'write' : 'check';
const live = has('--live');

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

// --- Source-derived helpers ---

// Regenerate FUNCTIONS.md from sux/src/fns/*.ts. Returns the fresh contents.
function regenerateFunctions() {
  execFileSync(process.execPath, [GEN_DOCS], { stdio: ['ignore', 'ignore', 'inherit'] });
  return readFileSync(FUNCTIONS, 'utf8');
}

// Every function is a `| `name` | …` table row in FUNCTIONS.md.
function fnNamesFrom(md) {
  const names = new Set();
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*`([a-z0-9_]+)`/);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

const mentioned = (text, name) => new RegExp(`\\b${name}\\b`).test(text);

// The front verbs — the only tools the deployed tools/list advertises (the rest are
// leaves, reached via the `fn` escape or by name). Parsed from registry.ts so the
// --live probe checks against the real advertised surface, not the full FUNCTIONS.md.
function frontVerbsFrom() {
  const src = readFileSync(REGISTRY, 'utf8');
  const block = src.match(/FRONT_VERBS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) die('could not parse FRONT_VERBS from registry.ts — did the declaration move?');
  return new Set([...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
}

// Recursively list files under dir as paths relative to dir (sorted).
function walk(dir) {
  const out = [];
  const rec = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) rec(full);
      else if (entry.isFile()) out.push(relative(dir, full));
    }
  };
  if (safeIsDir(dir)) rec(dir);
  return out.sort();
}

function safeIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mirrorPluginSkills() {
  rmSync(PLUGIN_SKILLS_DIR, { recursive: true, force: true });
  cpSync(SKILLS_DIR, PLUGIN_SKILLS_DIR, { recursive: true });
}

function report(title, names) {
  if (names.length === 0) return false;
  console.log(`\n${title}:`);
  for (const n of names) console.log(`  - ${n}`);
  return true;
}

// --- Optional live probe (--live) — MCP Streamable HTTP, SSE-tolerant ---

async function rpc(url, token, method, params, sessionId, isNotification = false) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body = { jsonrpc: '2.0', method, params };
  if (!isNotification) body.id = 1;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (isNotification) return { json: null, session: sessionId };
  if (!res.ok) die(`${method}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);

  const session = res.headers.get('mcp-session-id') ?? sessionId;
  const text = await res.text();

  let json;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed.result !== undefined || parsed.error !== undefined) json = parsed;
      } catch {
        /* keep scanning */
      }
    }
  } else {
    json = JSON.parse(text);
  }
  if (!json) die(`${method}: no JSON-RPC response found in body`);
  if (json.error) die(`${method}: ${JSON.stringify(json.error)}`);
  return { json, session };
}

async function fetchLiveTools() {
  const url = process.env.SUX_MCP_URL;
  const token = process.env.SUX_MCP_TOKEN;
  if (!url) die('--live requires SUX_MCP_URL (the /mcp endpoint).');

  const init = await rpc(url, token, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'sux-skill-sync', version: '2.0.0' },
  });
  await rpc(url, token, 'notifications/initialized', {}, init.session, true).catch(() => {});

  const names = new Set();
  let cursor;
  do {
    const { json } = await rpc(url, token, 'tools/list', cursor ? { cursor } : {}, init.session);
    for (const t of json.result.tools ?? []) names.add(t.name);
    cursor = json.result.nextCursor;
  } while (cursor);

  if (names.size === 0) die('tools/list returned zero tools — refusing to treat that as truth.');
  return [...names].sort();
}

// --- Main ---

async function main() {
  if (mode === 'write') {
    const md = regenerateFunctions();
    mirrorPluginSkills();
    console.log(`Regenerated ${relative(ROOT, FUNCTIONS)} (${fnNamesFrom(md).length} functions) and mirrored ` +
      `${relative(ROOT, SKILLS_DIR)}/ → ${relative(ROOT, PLUGIN_SKILLS_DIR)}/.`);
    return;
  }

  let drift = false;

  // 1. FUNCTIONS.md is a gitignored, regenerated-on-demand artifact (nothing
  // imports it; `/llms.txt` and the tool inventory are derived from source), so
  // the source of truth is sux/src/fns/*.ts — always derive fnNames from a fresh
  // render. If a committed copy still exists (legacy checkout), hold it to being
  // in sync; when it's absent there is simply nothing to be stale against.
  let committed = null;
  try {
    committed = readFileSync(FUNCTIONS, 'utf8');
  } catch {
    // FUNCTIONS.md isn't tracked — see .gitignore. Skip the staleness gate.
  }
  const after = regenerateFunctions();
  const fnNames = fnNamesFrom(after);
  if (committed !== null && committed !== after) {
    writeFileSync(FUNCTIONS, committed); // non-destructive check: restore the committed copy
    console.log(`\n${relative(ROOT, FUNCTIONS)} is stale — regenerate with \`npm run docs\`.`);
    drift = true;
  }

  // 2. Every function in FUNCTIONS.md must be named somewhere in the skill.
  const skill = readFileSync(SKILL, 'utf8');
  drift = report(
    `Functions in ${relative(ROOT, FUNCTIONS)} never mentioned in ${relative(ROOT, SKILL)}`,
    fnNames.filter((n) => !mentioned(skill, n)),
  ) || drift;

  // 3. The plugin ships a byte-for-byte mirror of .claude/skills/.
  const srcFiles = walk(SKILLS_DIR);
  const dstFiles = walk(PLUGIN_SKILLS_DIR);
  const missing = srcFiles.filter((f) => !dstFiles.includes(f));
  const extra = dstFiles.filter((f) => !srcFiles.includes(f));
  const changed = srcFiles
    .filter((f) => dstFiles.includes(f))
    .filter((f) => readFileSync(join(SKILLS_DIR, f), 'utf8') !== readFileSync(join(PLUGIN_SKILLS_DIR, f), 'utf8'));
  drift = report(`Files in .claude/skills/ missing from plugins/sux/skills/`, missing) || drift;
  drift = report(`Files in plugins/sux/skills/ not in .claude/skills/`, extra) || drift;
  drift = report(`Files that differ between .claude/skills/ and plugins/sux/skills/`, changed) || drift;

  // The profile snippet claims to name every function (so skill-less chats can
  // still route) — hold it to that, same as SKILL.md, so it can't silently rot.
  const snippet = readFileSync(SNIPPET, 'utf8');
  drift = report(
    `Functions in ${relative(ROOT, FUNCTIONS)} never mentioned in ${relative(ROOT, SNIPPET)}`,
    fnNames.filter((n) => !mentioned(snippet, n)),
  ) || drift;

  // Optional live probe: the deployed tools/list is the FRONT DOOR — only the front
  // verbs, not every fn. So diff live against FRONT_VERBS (leaves stay reachable via
  // the `fn` escape, deliberately absent from the list), while still asserting every
  // advertised tool is a real fn in FUNCTIONS.md.
  if (live) {
    const liveNames = await fetchLiveTools();
    const fnSet = new Set(fnNames);
    const liveSet = new Set(liveNames);
    const frontVerbs = frontVerbsFrom();
    drift = report(
      'Tools on the live server but NOT in FUNCTIONS.md (deploy is ahead of main — regenerate/redeploy)',
      liveNames.filter((n) => !fnSet.has(n)),
    ) || drift;
    drift = report(
      'Front verbs missing from the live server (main is ahead of deploy — redeploy)',
      [...frontVerbs].filter((n) => !liveSet.has(n)).sort(),
    ) || drift;
    drift = report(
      'Tools advertised by the live server that are not front verbs (unexpected surface — front-door filter drift)',
      liveNames.filter((n) => !frontVerbs.has(n)),
    ) || drift;
  }

  if (drift) {
    console.log('\nDRIFT — run `node scripts/check-skill-sync.mjs --write` (regenerates FUNCTIONS.md + re-mirrors the plugin skill), edit SKILL.md if a function is unmentioned, then commit.');
    process.exit(1);
  }
  console.log(`OK — ${fnNames.length} functions; FUNCTIONS.md fresh, skill names them all, plugin mirror in sync${live ? ', matches the live server' : ''}.`);
}

main().catch((e) => die(String(e?.stack ?? e)));
