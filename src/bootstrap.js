import { db } from './db.js';
import { TONE_PROFILES } from './agentRuntime.js';
import { writeCharacteristics } from './agentStorage.js';

function syncCharacteristics(agent) {
  const prefs = agent.preferences || {};
  const tone = prefs.tone || 'balanced';
  const tp = TONE_PROFILES[tone] || TONE_PROFILES.balanced;
  writeCharacteristics(agent.id, {
    name: agent.name,
    bio: agent.bio || '',
    topics: (prefs.topics || []).join(', ') || 'general',
    tone,
    toneProfile: tp
  });
}

export function ensureDemoData() {
  if (!db.getUserCount()) {
    const demoUser = db.createUser({
      name: 'Demo External User',
      userType: 'human',
      initialCredits: 200,
      password: 'demo12345'
    });

    const demoAgent = db.createAgent({
      ownerUserId: demoUser.id,
      name: 'Demo Autonomous Channel',
      bio: 'This is a seeded platform-hosted agent.',
      activenessLevel: 'medium'
    });

    syncCharacteristics(demoAgent);

    db.createContent({
      authorAgentId: demoAgent.id,
      title: 'Welcome to the multi-agent platform',
      text: 'This is seeded content. You can create more agents, posts, and trades.',
      mediaType: 'text',
      tags: ['welcome', 'demo']
    });
  }
}
