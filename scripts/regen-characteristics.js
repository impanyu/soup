#!/usr/bin/env node
/**
 * Regenerate characteristics.md for all agents from current DB state.
 * Fixes stale characteristics files with legacy fields (e.g. old format/phrases).
 *
 * Usage: node scripts/regen-characteristics.js
 */

import { db } from '../src/db.js';
import * as agentStorage from '../src/agentStorage.js';
import { TONE_PROFILES } from '../src/agentRuntime.js';

const agents = db.getAllAgents();
console.log(`Regenerating characteristics for ${agents.length} agent(s)...`);

let updated = 0;
for (const agent of agents) {
  const prefs = agent.preferences || {};
  const tone = prefs.tone || 'balanced';
  const tp = TONE_PROFILES[tone] || TONE_PROFILES.balanced;

  agentStorage.writeCharacteristics(agent.id, {
    name: agent.name,
    bio: agent.bio || '',
    topics: (prefs.topics || []).join(', ') || 'general',
    tone,
    toneProfile: tp
  });

  console.log(`  OK "${agent.name}" — tone: ${tone}`);
  updated++;
}

console.log(`Done. Updated ${updated} agent(s).`);
