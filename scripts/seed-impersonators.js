#!/usr/bin/env node
/**
 * One-time script: seed Wikipedia knowledge into existing impersonator agents'
 * long-term memory. Same logic as seedImpersonatorMemory() in server.js.
 *
 * Usage: node --env-file=.env scripts/seed-impersonators.js [--dry-run]
 */

import { db } from '../src/db.js';
import * as vectorMemory from '../src/vectorMemory.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function fetchWikipediaHtml(lang, title) {
  const encoded = encodeURIComponent(title.replace(/\s+/g, '_'));
  const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/html/${encoded}`, {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return null;
  return res.text();
}

async function searchWikipediaTitle(lang, query) {
  const encoded = encodeURIComponent(query);
  const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srlimit=1&format=json`, {
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.query?.search?.[0]?.title || null;
}

function stripHtmlToPlainText(html) {
  return html
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
}

function chunkText(text, maxTotal = 15000) {
  const chunks = [];
  let remaining = text.slice(0, maxTotal);
  while (remaining.length > 0) {
    if (remaining.length <= 900) { chunks.push(remaining); break; }
    let cutoff = 800;
    for (const sep of ['. ', '。', '\n']) {
      const idx = remaining.indexOf(sep, cutoff);
      if (idx !== -1 && idx < 1200) { cutoff = idx + sep.length; break; }
    }
    chunks.push(remaining.slice(0, cutoff).trim());
    remaining = remaining.slice(cutoff).trim();
  }
  return chunks.filter(c => c.length >= 30);
}

async function fetchAndChunkWikipedia(target) {
  let html = null;
  let source = '';

  // 1. English Wikipedia — direct
  html = await fetchWikipediaHtml('en', target);
  if (html) source = 'en';

  // 2. English Wikipedia — search
  if (!html) {
    const enTitle = await searchWikipediaTitle('en', target);
    if (enTitle) {
      html = await fetchWikipediaHtml('en', enTitle);
      if (html) source = 'en';
    }
  }

  // 3. Chinese Wikipedia — direct
  if (!html) {
    html = await fetchWikipediaHtml('zh', target);
    if (html) source = 'zh';
  }

  // 4. Chinese Wikipedia — search
  if (!html) {
    const zhTitle = await searchWikipediaTitle('zh', target);
    if (zhTitle) {
      html = await fetchWikipediaHtml('zh', zhTitle);
      if (html) source = 'zh';
    }
  }

  if (!html) throw new Error(`No Wikipedia page found for "${target}" (tried en + zh)`);

  const plainText = stripHtmlToPlainText(html);
  if (plainText.length < 100) throw new Error('Wikipedia text too short after stripping HTML');

  return { chunks: chunkText(plainText), source };
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
      const { chunks, source } = await fetchAndChunkWikipedia(target);
      console.log(`       Found ${chunks.length} chunks from ${source}.wikipedia`);

      if (DRY_RUN) {
        console.log(`       [dry-run] Would store ${chunks.length} memories`);
        continue;
      }

      for (let i = 0; i < chunks.length; i++) {
        await vectorMemory.storeMemory(agent.id, {
          content: `About me (${target}) [${i + 1}/${chunks.length}]: ${chunks[i]}`,
          category: 'identity',
          tags: ['wikipedia', 'biography', target],
          metadata: { source: `wikipedia-seed-${source}`, chunk: i + 1, totalChunks: chunks.length }
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
