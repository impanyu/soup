#!/usr/bin/env node
/**
 * Generate persona summaries for existing impersonator agents that
 * already have identity memories but no impersonationSummary.
 *
 * Usage: node --env-file=.env scripts/gen-impersonator-summaries.js
 */

import { db } from '../src/db.js';
import * as vectorMemory from '../src/vectorMemory.js';

const agents = db.getAllAgents();
const impersonators = agents.filter(a => a.runConfig?.impersonateTarget);

console.log(`Found ${impersonators.length} impersonator agent(s).`);

const apiKey = process.env.AGENT_LLM_API_KEY;
if (!apiKey) { console.error('AGENT_LLM_API_KEY not set'); process.exit(1); }

for (const agent of impersonators) {
  const target = agent.runConfig.impersonateTarget;

  if (agent.runConfig.impersonationSummary) {
    console.log(`  SKIP "${agent.name}" → already has summary`);
    continue;
  }

  // Gather identity memories as source text
  const stats = vectorMemory.getMemoryStats(agent.id);
  if (!stats.categories?.identity) {
    console.log(`  SKIP "${agent.name}" → no identity memories`);
    continue;
  }

  const memories = vectorMemory.listMemories(agent.id, { page: 1, perPage: 50, category: 'identity' });
  const text = (memories.items || []).map(m => m.content).join('\n').slice(0, 8000);

  console.log(`  GEN "${agent.name}" → target: "${target}" (${text.length} chars of source)`);

  try {
    const res = await fetch(process.env.AGENT_LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: `Summarize the following information about "${target}" into a 200-300 word biography written in second person ("You are..."). Cover: who they are, key achievements, career highlights, known views/style, and what they are famous for. This will be used as a persona prompt.\n\nSource:\n${text}` }],
        max_tokens: 500
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) { console.error(`       FAILED: LLM API ${res.status}`); continue; }
    const data = await res.json();
    const summary = (data.choices?.[0]?.message?.content || '').trim();
    if (summary.length < 50) { console.error(`       FAILED: summary too short`); continue; }

    const rc = agent.runConfig || {};
    db.updateAgent(agent.id, { runConfig: { ...rc, impersonationSummary: summary } });
    console.log(`       OK (${summary.length} chars)`);
  } catch (err) {
    console.error(`       FAILED: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 500));
}

console.log('Done.');
