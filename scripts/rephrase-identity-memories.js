#!/usr/bin/env node
/**
 * Rephrase existing identity memories from third person to first person.
 *
 * Usage: node --env-file=.env scripts/rephrase-identity-memories.js [--dry-run]
 */

import { db } from '../src/db.js';
import * as vectorMemory from '../src/vectorMemory.js';

const DRY_RUN = process.argv.includes('--dry-run');
const apiKey = process.env.AGENT_LLM_API_KEY;
if (!apiKey) { console.error('AGENT_LLM_API_KEY not set'); process.exit(1); }

const agents = db.getAllAgents();
const impersonators = agents.filter(a => a.runConfig?.impersonateTarget);

console.log(`Found ${impersonators.length} impersonator agent(s).`);

for (const agent of impersonators) {
  const target = agent.runConfig.impersonateTarget;
  const memories = vectorMemory.listMemories(agent.id, { page: 1, perPage: 100, category: 'identity' });
  const items = memories.items || [];

  if (!items.length) {
    console.log(`  SKIP "${agent.name}" → no identity memories`);
    continue;
  }

  // Check if already rephrased (first person indicators)
  const sample = items[0]?.content || '';
  if (/^About me \[\d+\/\d+\]: I (am|was|have|grew|born|served|became|studied|founded|created|worked)/i.test(sample)) {
    console.log(`  SKIP "${agent.name}" → already in first person`);
    continue;
  }

  console.log(`  REPHRASE "${agent.name}" → ${items.length} identity memories`);

  for (const mem of items) {
    const content = mem.content;
    // Skip if already clearly first person
    if (/^About me.*: I (am|was|have)/i.test(content)) continue;

    try {
      const res = await fetch(process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: `Rewrite the following text about "${target}" into first person perspective ("I am...", "I did...", "My..."). Keep all facts, dates, and details. Just change the perspective. Reply with ONLY the rewritten text.\n\nText:\n${content}` }],
          max_tokens: 600
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) { console.log(`    FAIL ${mem.id}: API ${res.status}`); continue; }
      const data = await res.json();
      const rephrased = (data.choices?.[0]?.message?.content || '').trim();

      if (rephrased.length < 30) { console.log(`    FAIL ${mem.id}: too short`); continue; }

      if (DRY_RUN) {
        console.log(`    [dry-run] ${mem.id}: "${content.slice(0, 50)}..." → "${rephrased.slice(0, 50)}..."`);
      } else {
        // Delete old and store new with same metadata
        vectorMemory.forgetMemory(agent.id, mem.id);
        await vectorMemory.storeMemory(agent.id, {
          content: rephrased,
          category: 'identity',
          tags: mem.tags || ['wikipedia', 'biography', target],
          metadata: mem.metadata || {}
        });
        console.log(`    OK ${mem.id}`);
      }
    } catch (err) {
      console.log(`    FAIL ${mem.id}: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }
}

console.log('Done.');
