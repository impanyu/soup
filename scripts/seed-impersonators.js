#!/usr/bin/env node
/**
 * One-time script: seed Wikipedia knowledge into existing impersonator agents'
 * long-term memory. Same logic as seedImpersonatorMemory() in server.js.
 *
 * Usage: node scripts/seed-impersonators.js [--dry-run]
 */

import { db } from '../src/db.js';
import * as vectorMemory from '../src/vectorMemory.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function fetchAndChunkWikipedia(target) {
  const encoded = encodeURIComponent(target.replace(/\s+/g, '_'));

  // Try full HTML page first
  const url = `https://en.wikipedia.org/api/rest_v1/page/html/${encoded}`;
  const res = await fetch(url, {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(15000)
  });

  let plainText;
  if (!res.ok) {
    // Fallback to summary
    const summaryRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!summaryRes.ok) throw new Error(`Wikipedia returned ${summaryRes.status}`);
    const summary = await summaryRes.json();
    plainText = summary.extract || '';
    if (plainText.length < 50) throw new Error('Wikipedia extract too short');
  } else {
    const html = await res.text();
    plainText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[\d+\]/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plainText.length < 100) throw new Error('Wikipedia text too short after stripping HTML');
  }

  // Chunk into ~800 char segments at sentence boundaries
  const chunks = [];
  let remaining = plainText.slice(0, 15000);
  while (remaining.length > 0) {
    if (remaining.length <= 900) {
      chunks.push(remaining);
      break;
    }
    let cutoff = 800;
    const nextPeriod = remaining.indexOf('. ', cutoff);
    if (nextPeriod !== -1 && nextPeriod < 1200) {
      cutoff = nextPeriod + 2;
    }
    chunks.push(remaining.slice(0, cutoff).trim());
    remaining = remaining.slice(cutoff).trim();
  }

  return chunks.filter(c => c.length >= 30);
}

async function main() {
  const allAgents = db.getAllAgents();
  const impersonators = allAgents.filter(a => a.runConfig?.impersonateTarget);

  console.log(`Found ${impersonators.length} impersonator agent(s) out of ${allAgents.length} total.`);
  if (impersonators.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  for (const agent of impersonators) {
    const target = agent.runConfig.impersonateTarget;
    const stats = vectorMemory.getMemoryStats(agent.id);
    const hasIdentity = stats.categories?.identity > 0;

    if (hasIdentity) {
      console.log(`  SKIP "${agent.name}" → already has ${stats.categories.identity} identity memories`);
      continue;
    }

    console.log(`  SEED "${agent.name}" → target: "${target}"`);

    try {
      const chunks = await fetchAndChunkWikipedia(target);
      console.log(`       Found ${chunks.length} chunks from Wikipedia`);

      if (DRY_RUN) {
        console.log(`       [dry-run] Would store ${chunks.length} memories`);
        continue;
      }

      for (let i = 0; i < chunks.length; i++) {
        await vectorMemory.storeMemory(agent.id, {
          content: `About me (${target}) [${i + 1}/${chunks.length}]: ${chunks[i]}`,
          category: 'identity',
          tags: ['wikipedia', 'biography', target],
          metadata: { source: 'wikipedia-seed', chunk: i + 1, totalChunks: chunks.length }
        });
      }
      console.log(`       Stored ${chunks.length} memory chunks`);
    } catch (err) {
      console.error(`       FAILED: ${err.message}`);
    }

    // Small delay between agents to avoid rate-limiting Wikipedia/OpenAI embeddings
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
