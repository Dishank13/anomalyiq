const { Queue } = require('bullmq');
const { createConnection, isConfigured } = require('./connection');
const logger = require('../lib/logger');

const QUEUE_NAME = 'analysis';

let queue = null;
if (isConfigured()) {
  queue = new Queue(QUEUE_NAME, {
    connection: createConnection('queue'),
    defaultJobOptions: {
      attempts: Number(process.env.ANALYSIS_JOB_ATTEMPTS || 3),
      // The python service on a free tier cold-starts for ~50s; retrying
      // immediately just fails again against the same waking instance.
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600, count: 100 },
      // Keep failures around far longer than successes -- they are the ones
      // anyone needs to look at.
      removeOnFail: { age: 86400 }
    }
  });
  logger.info({ queue: QUEUE_NAME }, 'analysis queue ready');
}

const isEnabled = () => Boolean(queue);

/**
 * Enqueue an analysis, or report that the queue is unavailable.
 *
 * Passing an explicit jobId makes this idempotent: BullMQ ignores an add() for
 * a job id that already exists, so double-clicking "Run Analysis" cannot
 * produce two runs over the same data.
 */
async function enqueueAnalysis(jobId, payload) {
  if (!queue) return null;

  // A finished job keeps its id for the retention window, and add() would
  // quietly hand back that stale job instead of running again -- leaving the
  // caller waiting on something that already happened. Clear it out first.
  // A job that is genuinely in flight is returned as-is: that is the
  // idempotency we do want.
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState().catch(() => 'unknown');
    if (['completed', 'failed'].includes(state)) {
      await existing.remove().catch(() => {});
    } else {
      return existing;
    }
  }

  return queue.add('analyze', payload, { jobId });
}

async function getJob(jobId) {
  if (!queue) return null;
  return queue.getJob(jobId);
}

async function closeQueue() {
  if (queue) await queue.close();
}

module.exports = { queue, QUEUE_NAME, isEnabled, enqueueAnalysis, getJob, closeQueue };
