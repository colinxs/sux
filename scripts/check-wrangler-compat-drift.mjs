#!/usr/bin/env node
// Guards against the #607 class of staleness: sux/wrangler.jsonc's
// compatibility_date/compatibility_flags drifting out from under
// sux/test/e2e/wrangler.e2e.jsonc, silently letting e2e validate against a stale
// Workers runtime baseline. Same drift-gate shape as check:node/gen:index in
// ci.yml — compare a derived value against a fixed source of truth, fail loud.
//
//   node scripts/check-wrangler-compat-drift.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROD = join(ROOT, 'sux', 'wrangler.jsonc');
const E2E = join(ROOT, 'sux', 'test', 'e2e', 'wrangler.e2e.jsonc');

// wrangler.jsonc files carry `//` comments, so a plain JSON.parse won't do —
// pull the two fields out directly rather than writing a full JSONC parser.
function compat(path) {
  const text = readFileSync(path, 'utf8');
  const date = text.match(/"compatibility_date"\s*:\s*"([^"]+)"/);
  const flags = text.match(/"compatibility_flags"\s*:\s*\[([^\]]*)\]/);
  if (!date) throw new Error(`${path}: could not find compatibility_date`);
  if (!flags) throw new Error(`${path}: could not find compatibility_flags`);
  const flagList = [...flags[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  return { date: date[1], flags: flagList };
}

const prod = compat(PROD);
const e2e = compat(E2E);

let drift = false;
if (prod.date !== e2e.date) {
  console.error(`compatibility_date drift: sux/wrangler.jsonc=${prod.date} vs test/e2e/wrangler.e2e.jsonc=${e2e.date}`);
  drift = true;
}
const missing = prod.flags.filter((f) => !e2e.flags.includes(f));
if (missing.length > 0) {
  console.error(`compatibility_flags drift: test/e2e/wrangler.e2e.jsonc is missing ${JSON.stringify(missing)} present in sux/wrangler.jsonc`);
  drift = true;
}

if (drift) {
  console.error('\nDRIFT — sync sux/test/e2e/wrangler.e2e.jsonc\'s compatibility_date/compatibility_flags with sux/wrangler.jsonc, then commit.');
  process.exit(1);
}
console.log(`OK — compatibility_date (${prod.date}) and compatibility_flags in sync between prod and e2e config.`);
