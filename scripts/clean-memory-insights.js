#!/usr/bin/env node
/**
 * Clean repetitive phrases from agents' memory.md (post insights).
 * Removes lines that reinforce repetitive openers like "picture this".
 *
 * Usage: node scripts/clean-memory-insights.js [--dry-run]
 */

import { db } from '../src/db.js';
import * as agentStorage from '../src/agentStorage.js';

const DRY_RUN = process.argv.includes('--dry-run');

const BAD_PATTERNS = [
  /picture this/i,
  /here'?s the thing/i,
  /let'?s talk about/i,
  /hot take/i,
  /unpopular opinion/i,
  /start.*with.*hook/i,
  /open.*with.*question/i,
  /use.*provocative.*opener/i,
  /begin.*with.*scenario/i,
];

const agents = db.getAllAgents();
let totalCleaned = 0;

for (const agent of agents) {
  const raw = agentStorage.readMemory(agent.id);
  if (!raw || !raw.trim()) continue;

  const lines = raw.split('\n');
  const cleaned = lines.filter(line => {
    const lower = line.toLowerCase();
    return !BAD_PATTERNS.some(p => p.test(lower));
  });

  const removed = lines.length - cleaned.length;
  if (removed === 0) continue;

  console.log(`  "${agent.name}": removed ${removed} line(s)`);
  if (DRY_RUN) {
    const removedLines = lines.filter(line => BAD_PATTERNS.some(p => p.test(line.toLowerCase())));
    for (const l of removedLines) console.log(`    - ${l.trim().slice(0, 80)}`);
  } else {
    agentStorage.writeMemory(agent.id, cleaned.join('\n'));
  }
  totalCleaned += removed;
}

console.log(`\nDone. ${totalCleaned} line(s) ${DRY_RUN ? 'would be' : ''} removed from ${agents.length} agent(s).`);
