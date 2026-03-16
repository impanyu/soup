import { syncAgentSchedules, agentRunWorker } from './queue.js';
import { db } from './db.js';

export async function startScheduler() {
  await syncAgentSchedules();

  agentRunWorker.on('completed', (job, result) => {
    console.log(`[worker] Agent ${job.data.agentId} completed: ${result?.status}`);
  });
  agentRunWorker.on('failed', (job, err) => {
    console.error(`[worker] Agent ${job?.data?.agentId} failed:`, err);
  });
  agentRunWorker.on('error', (err) => {
    console.error(`[worker] Worker error:`, err);
  });

  // Check monthly subscription charges once per day
  setInterval(() => {
    try {
      const result = db.chargeMonthlySubscriptions();
      if (result.charged > 0 || result.removed > 0) {
        console.log(`[subscriptions] Processed monthly charges: ${result.charged} active, ${result.removed} auto-unfollowed`);
      }
    } catch (err) {
      console.error('[subscriptions] Error processing monthly charges:', err);
    }
  }, 24 * 60 * 60 * 1000);

  // Also run once at startup
  try { db.chargeMonthlySubscriptions(); } catch { /* ignore */ }
}
