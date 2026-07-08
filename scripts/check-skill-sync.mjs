#!/usr/bin/env node
// Keep the sux-router skill, its plugin copy, and the generated docs honest
// against the deployed sux server's tool surface. No dependencies; speaks MCP
// Streamable HTTP directly.
//
// Modes:
//   node scripts/check-skill-sync.mjs            live check (needs SUX_MCP_URL)
//   node scripts/check-skill-sync.mjs --offline  snapshot-only check (no network)
//   node scripts/check-skill-sync.mjs --write    regenerate docs/sux-tools.txt and
//                                                docs/TOOLS.md from the live server,
//                                                and sync the plugin's skill copy
//
// Env:
//   SUX_MCP_URL    the /mcp endpoint of the deployed server (required unless --offline)
//   SUX_MCP_TOKEN  bearer token, if the endpoint is auth-gated (optional)
//
// Exit codes: 0 in sync · 1 drift found · 2 misconfigured/unreachable

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SNAPSHOT = 'docs/sux-tools.txt';
const TOOLS_DOC = 'docs/TOOLS.md';
const SKILL = '.claude/skills/sux-router/SKILL.md';
const PLUGIN_SKILL = 'plugins/sux-router/skills/sux-router/SKILL.md';
const SNIPPET = 'docs/claude-profile-snippet.md';

const mode = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--offline')
    ? 'offline'
    : 'check';

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

// --- MCP Streamable HTTP client (initialize → tools/list, SSE-tolerant) ---

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

  // Body is either plain JSON or an SSE stream of `data: {...}` events.
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
  if (!url) die('SUX_MCP_URL is not set (use --offline for the snapshot-only check).');

  const init = await rpc(url, token, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'sux-skill-sync', version: '1.0.0' },
  });
  await rpc(url, token, 'notifications/initialized', {}, init.session, true).catch(() => {});

  const byName = new Map();
  let cursor;
  do {
    const { json } = await rpc(url, token, 'tools/list', cursor ? { cursor } : {}, init.session);
    for (const t of json.result.tools ?? []) byName.set(t.name, t.description ?? '');
    cursor = json.result.nextCursor;
  } while (cursor);

  if (byName.size === 0) die('tools/list returned zero tools — refusing to treat that as truth.');
  return [...byName.entries()].map(([name, description]) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name));
}

// --- Generated docs ---

function writeSnapshot(tools) {
  writeFileSync(
    SNAPSHOT,
    '# Tool surface of the deployed sux server, one name per line.\n' +
      '# Regenerate with: SUX_MCP_URL=… node scripts/check-skill-sync.mjs --write\n' +
      tools.map((t) => t.name).join('\n') +
      '\n',
  );
}

function writeToolsDoc(tools) {
  const body = tools.map((t) => `## \`${t.name}\`\n\n${(t.description || '_no description_').trim()}\n`).join('\n');
  writeFileSync(
    TOOLS_DOC,
    `# sux tool reference (${tools.length} tools)\n\n` +
      '_Generated from the live server by `scripts/check-skill-sync.mjs --write` — do not edit by hand._\n\n' +
      body,
  );
}

function syncPluginSkill() {
  mkdirSync(dirname(PLUGIN_SKILL), { recursive: true });
  copyFileSync(SKILL, PLUGIN_SKILL);
}

// --- Checks ---

const readLines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

const mentioned = (text, name) => new RegExp(`\\b${name}\\b`).test(text);

function report(title, names) {
  if (names.length === 0) return false;
  console.log(`\n${title}:`);
  for (const n of names) console.log(`  - ${n}`);
  return true;
}

async function main() {
  if (mode === 'write') {
    const tools = await fetchLiveTools();
    writeSnapshot(tools);
    writeToolsDoc(tools);
    syncPluginSkill();
    console.log(`Wrote ${tools.length} tools to ${SNAPSHOT} and ${TOOLS_DOC}; synced ${PLUGIN_SKILL}.`);
    return;
  }

  const snapshot = readLines(SNAPSHOT);
  const skill = readFileSync(SKILL, 'utf8');
  const snippet = readFileSync(SNIPPET, 'utf8');
  let drift = false;

  if (mode === 'check') {
    const live = (await fetchLiveTools()).map((t) => t.name);
    const snapSet = new Set(snapshot);
    const liveSet = new Set(live);
    drift |= report(
      'Tools on the live server but NOT in docs/sux-tools.txt (new — add to SKILL.md, snippet, and snapshot)',
      live.filter((n) => !snapSet.has(n)),
    );
    drift |= report(
      'Tools in docs/sux-tools.txt but GONE from the live server (removed — prune everywhere)',
      snapshot.filter((n) => !liveSet.has(n)),
    );
  }

  // Every snapshot tool must at least be named in the skill. The profile
  // snippet is deliberately a summary, so it only gets a soft warning.
  drift |= report(
    `Tools in ${SNAPSHOT} never mentioned in ${SKILL}`,
    snapshot.filter((n) => !mentioned(skill, n)),
  );

  // The plugin ships a copy of the canonical skill — they must be identical.
  if (!existsSync(PLUGIN_SKILL)) {
    console.log(`\n${PLUGIN_SKILL} is missing — run --write (or copy ${SKILL}).`);
    drift = true;
  } else if (readFileSync(PLUGIN_SKILL, 'utf8') !== skill) {
    console.log(`\n${PLUGIN_SKILL} differs from ${SKILL} — run --write (or copy it over).`);
    drift = true;
  }

  const unSnippeted = snapshot.filter((n) => !mentioned(snippet, n));
  if (unSnippeted.length)
    console.log(
      `\nFYI (not failing): ${unSnippeted.length} tools not in the profile snippet: ${unSnippeted.join(', ')}`,
    );

  if (drift) {
    console.log('\nDRIFT — update SKILL.md / docs/claude-profile-snippet.md, then regenerate with --write.');
    process.exit(1);
  }
  console.log(`OK — ${snapshot.length} tools; skill, plugin copy, and snapshot in sync${mode === 'check' ? ' with the live server' : ''}.`);
}

main().catch((e) => die(String(e?.stack ?? e)));
