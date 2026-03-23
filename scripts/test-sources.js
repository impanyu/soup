#!/usr/bin/env node
/**
 * Test all external article sources by attempting a search.
 * Reports which sources work and which fail.
 *
 * Usage: node --env-file=.env scripts/test-sources.js [--search "query"] [--updates] [--source sourceId]
 */

import { EXTERNAL_SOURCES } from '../src/sources/index.js';
import { searchWithStrategy, listUpdatesWithStrategy } from '../src/sourceFetcher.js';

const args = process.argv.slice(2);
const searchQuery = args.includes('--search') ? args[args.indexOf('--search') + 1] : 'technology';
const doUpdates = args.includes('--updates');
const singleSource = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;

// Only test article/media sources, skip data APIs
let sources = EXTERNAL_SOURCES.filter(s => s.dataType !== 'structured' && s.category !== 'Data APIs');
if (singleSource) {
  sources = sources.filter(s => s.id === singleSource);
  if (!sources.length) {
    console.error(`Source "${singleSource}" not found.`);
    process.exit(1);
  }
}

console.log(`Testing ${sources.length} sources with ${doUpdates ? 'list_updates' : `search "${searchQuery}"`}...\n`);

const results = { ok: [], fail: [], skip: [] };

for (const source of sources) {
  const label = `${source.id} (${source.name})`;
  try {
    let items;
    if (doUpdates) {
      if (source.id === 'google') { results.skip.push({ id: source.id, reason: 'no list_updates' }); continue; }
      items = await listUpdatesWithStrategy(source, 3);
    } else {
      items = await searchWithStrategy(source, searchQuery, 3);
    }
    const count = Array.isArray(items) ? items.length : 0;
    if (count > 0) {
      console.log(`  OK  ${label} → ${count} result(s)`);
      results.ok.push({ id: source.id, count });
    } else {
      console.log(`  EMPTY  ${label} → 0 results`);
      results.fail.push({ id: source.id, error: '0 results' });
    }
  } catch (err) {
    const msg = err.message?.slice(0, 100) || String(err);
    console.log(`  FAIL  ${label} → ${msg}`);
    results.fail.push({ id: source.id, error: msg });
  }

  // Small delay to avoid rate limiting
  await new Promise(r => setTimeout(r, 300));
}

console.log(`\n=== Summary ===`);
console.log(`OK: ${results.ok.length} | FAIL: ${results.fail.length} | SKIP: ${results.skip.length}`);
if (results.fail.length) {
  console.log(`\nFailed sources:`);
  for (const f of results.fail) {
    console.log(`  - ${f.id}: ${f.error}`);
  }
}
