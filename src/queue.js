import { Queue, Worker } from 'bullmq';
import { db } from './db.js';
import { executeAgentRun } from './agentRuntime.js';

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
  const { agentId, trigger } = job.data;
  const agent = db.getAgent(agentId);
  if (!agent) {
    console.log(`[worker] Agent ${agentId} not found — skipping`);
    return { status: 'skipped', reason: 'agent_not_found' };
  }
  if (!agent.enabled) {
    console.log(`[worker] Agent ${agent.name} (${agentId}) is disabled — skipping`);
    return { status: 'paused' };
  }

  const feeType = trigger === 'manual' ? 'manual_run' : 'autonomous_action';
  const fee = db.chargeTenantFee(agent.id, feeType);
  if (fee.disabled) {
    console.log(`[worker] Agent ${agent.name} (${agentId}) — owner has insufficient credits — skipping`);
    return { status: 'paused', reason: 'insufficient_credits' };
  }

  try {
    await executeAgentRun(agent);
  } catch (err) {
    console.error(`[worker] Agent ${agent.name} (${agentId}) run CRASHED:`, err);
    throw err; // re-throw so BullMQ marks it as failed
  }

  // Update lastActionAt; nextActionAt stays on the fixed grid
  const intervalMs = agent.intervalMinutes * 60_000;
  const nextActionAt = new Date(getNextScheduledRun(agent.createdAt, intervalMs)).toISOString();
  db.updateAgent(agent.id, {
    lastActionAt: new Date().toISOString(),
    nextActionAt
  });

  return { status: 'completed' };
}

export const agentRunWorker = new Worker('agent-runs', processAgentRun, {
  connection,
  concurrency: CONCURRENCY,
  lockDuration: 600_000
});

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

    // Also update the DB so dashboard shows the correct next run time
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
          jobId: agent.id,
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 }
        }
      }
    );
  }

  // Remove schedulers for deleted agents
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
        jobId: agent.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 }
      }
    }
  );
}

export async function addRunNowJob(agentId) {
  await agentRunQueue.add(
    'agent-run',
    { agentId, trigger: 'manual' },
    { jobId: agentId, priority: 1, removeOnComplete: true, removeOnFail: true }
  );
}

export async function isAgentRunning(agentId) {
  const job = await agentRunQueue.getJob(agentId);
  if (!job) return false;
  const state = await job.getState();
  return state === 'active' || state === 'waiting';
}

export async function closeQueue() {
  await agentRunWorker.close();
  await agentRunQueue.close();
}
