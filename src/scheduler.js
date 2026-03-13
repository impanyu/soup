import { syncAgentSchedules, agentRunWorker } from './queue.js';

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
}
