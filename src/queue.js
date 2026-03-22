import { Queue, Worker } from 'bullmq';
import { db } from './db.js';
import { executeAgentRun, getRunProgress, getRunProgressByTrigger } from './agentRuntime.js';

const _pendingManualRuns = new Set();

export function clearPendingRun(agentId) {
  _pendingManualRuns.delete(agentId);
}

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CONCURRENCY = Number(process.env.AGENT_RUN_CONCURRENCY) || 200;

const connection = (() => {
  const url = new URL(REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    ...(url.password ? { password: url.password } : {}),
    ...(url.username ? { username: url.username } : {})
  };
})();

export const agentRunQueue = new Queue('agent-runs', { connection });

/**
 * Compute the next run time on a fixed grid: createdAt, createdAt+interval, createdAt+2*interval, ...
 * Returns the smallest grid time that is strictly in the future (> now).
 */
export function getNextScheduledRun(createdAt, intervalMs) {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  if (now < created) return created;
  const elapsed = now - created;
  const periods = Math.floor(elapsed / intervalMs) + 1;
  return created + periods * intervalMs;
}

async function processAgentRun(job) {
  console.log(`[worker] Processing job ${job.id}, data:`, JSON.stringify(job.data));
  const { agentId, trigger } = job.data;
  if (trigger === 'manual') _pendingManualRuns.delete(agentId);

  const agent = db.getAgent(agentId);
  if (!agent) {
    console.log(`[worker] Agent ${agentId} not found — skipping`);
    return { status: 'skipped', reason: 'agent_not_found' };
  }
  if (!agent.enabled && trigger !== 'manual') {
    console.log(`[worker] Agent ${agent.name} (${agentId}) is disabled — skipping scheduled run`);
    return { status: 'paused' };
  }

  // Pre-run credit check — skip if agent can't afford the run
  const estimatedCost = db.calculateRunCost(agent);
  if (agent.credits < estimatedCost) {
    db.updateAgent(agentId, { enabled: false });
    await agentRunQueue.removeJobScheduler(`scheduler:${agentId}`);
    console.log(`[worker] Agent ${agent.name} (${agentId}) insufficient credits (${agent.credits} < ${estimatedCost}) — skipping and auto-pausing`);
    return { status: 'skipped', reason: 'insufficient_credits' };
  }

  try {
    await executeAgentRun(agent, trigger);
  } catch (err) {
    console.error(`[worker] Agent ${agent.name} (${agentId}) run CRASHED:`, err);
    throw err;
  }

  // Update lastActionAt; nextActionAt stays on the fixed grid
  const intervalMs = agent.intervalMinutes * 60_000;
  const nextActionAt = new Date(getNextScheduledRun(agent.createdAt, intervalMs)).toISOString();
  db.updateAgent(agent.id, {
    lastActionAt: new Date().toISOString(),
    nextActionAt
  });

  // Auto-pause if agent can't afford the next run
  const updatedAgent = db.getAgent(agentId);
  if (updatedAgent && updatedAgent.enabled) {
    const nextRunCost = db.calculateRunCost(updatedAgent);
    if (updatedAgent.credits < nextRunCost) {
      db.updateAgent(agentId, { enabled: false });
      await agentRunQueue.removeJobScheduler(`scheduler:${agentId}`);
      console.log(`[worker] Agent ${agent.name} (${agentId}) auto-paused: credits ${updatedAgent.credits} < next run cost ${nextRunCost}`);
    }
  }

  console.log(`[worker] Agent ${agent.name} (${agentId}) completed: ${trigger}`);
  return { status: 'completed' };
}

export const agentRunWorker = new Worker('agent-runs', processAgentRun, {
  connection,
  concurrency: CONCURRENCY,
  lockDuration: 600_000
});

agentRunWorker.on('ready', () => console.log('[worker] Ready and listening for jobs'));
agentRunWorker.on('error', (err) => console.error('[worker] Error:', err.message));
agentRunWorker.on('failed', (job, err) => console.error(`[worker] Job ${job?.id} FAILED:`, err.message));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function syncAgentSchedules() {
  const agents = db.getAllAgents();
  const existingSchedulers = await agentRunQueue.getJobSchedulers();
  const activeKeys = new Set();

  for (const agent of agents) {
    const key = `scheduler:${agent.id}`;
    activeKeys.add(key);

    if (!agent.enabled) {
      await agentRunQueue.removeJobScheduler(key);
      continue;
    }

    const intervalMs = agent.intervalMinutes * 60_000;
    const nextRunMs = getNextScheduledRun(agent.createdAt, intervalMs);

    const nextActionAt = new Date(nextRunMs).toISOString();
    if (agent.nextActionAt !== nextActionAt) {
      db.updateAgent(agent.id, { nextActionAt });
    }

    await agentRunQueue.upsertJobScheduler(
      key,
      { every: intervalMs, startDate: new Date(nextRunMs) },
      {
        name: 'agent-run',
        data: { agentId: agent.id, trigger: 'scheduled' },
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: true
        }
      }
    );
  }

  for (const sched of existingSchedulers) {
    if (!activeKeys.has(sched.key)) {
      await agentRunQueue.removeJobScheduler(sched.key);
    }
  }
}

export async function syncSingleAgent(agentId) {
  const agent = db.getAgent(agentId);
  const key = `scheduler:${agentId}`;

  if (!agent || !agent.enabled) {
    await agentRunQueue.removeJobScheduler(key);
    return;
  }

  const intervalMs = agent.intervalMinutes * 60_000;
  const nextRunMs = getNextScheduledRun(agent.createdAt, intervalMs);

  await agentRunQueue.upsertJobScheduler(
    key,
    { every: intervalMs, startDate: new Date(nextRunMs) },
    {
      name: 'agent-run',
      data: { agentId: agent.id, trigger: 'scheduled' },
      opts: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true
      }
    }
  );
}

// Only blocks duplicate manual runs — scheduled runs are always allowed
export async function addRunNowJob(agentId) {
  if (_pendingManualRuns.has(agentId) || getRunProgressByTrigger(agentId, 'manual')) {
    throw new Error('agent_already_running');
  }

  _pendingManualRuns.add(agentId);
  try {
    const job = await agentRunQueue.add(
      'agent-run',
      { agentId, trigger: 'manual' },
      { removeOnComplete: true, removeOnFail: true }
    );
    console.log(`[queue] Run Now job added: id=${job.id}, agentId=${agentId}`);
  } catch (err) {
    _pendingManualRuns.delete(agentId);
    throw err;
  }
}

export function isAgentRunning(agentId) {
  if (_pendingManualRuns.has(agentId)) return true;
  if (getRunProgress(agentId)) return true;
  return false;
}

export async function closeQueue() {
  await agentRunWorker.close();
  await agentRunQueue.close();
}
