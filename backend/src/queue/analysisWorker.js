const { Worker } = require('bullmq');
const { createConnection, isConfigured } = require('./connection');
const { QUEUE_NAME } = require('./analysisQueue');
const { runAnalysis, markRunFailed } = require('../services/analysisRunner');
const { emitToUser } = require('../socket');
const logger = require('../lib/logger');

/**
 * Consume analysis jobs.
 *
 * Started either in-process (RUN_WORKER_INLINE=true, which is what the free
 * Render tier uses so there is only one service to keep awake) or as its own
 * process via `npm run worker`, which is what docker-compose runs and what a
 * real deployment would do. The code is identical either way; the socket.io
 * Redis adapter is what makes a separate process able to reach browser
 * connections held by the API process.
 */
/**
 * Process one analysis job.
 *
 * Separate from the Worker construction on purpose: everything specific to
 * this application lives here and can be exercised with a stub job, leaving
 * only the BullMQ/Redis transport to integration testing. `job` needs an `id`,
 * a `data` payload and `updateProgress()`.
 */
async function processAnalysisJob(io, job) {
  const { userId, sourceId, options, requestId } = job.data;
  const notify = (event, payload) =>
    emitToUser(io, userId, event, { jobId: job.id, sourceId, ...payload });

  notify('analysis:running', { status: 'running', progress: 0 });

  const result = await runAnalysis({
    userId,
    sourceId,
    options: { ...options, jobId: job.id },
    requestId,
    onProgress: async (progress, stage) => {
      await job.updateProgress(progress);
      notify('analysis:progress', { status: 'running', progress, stage });
    }
  });

  notify('analysis:completed', {
    status: 'succeeded',
    progress: 100,
    anomalyCount: result.anomalyCount,
    truncated: result.truncated,
    columnsAnalyzed: result.columnsAnalyzed,
    numericColumns: result.numericColumns,
    methodsUsed: result.methodsUsed,
    sourceName: result.sourceName
  });

  // The return value is stored on the job, so keep it small -- the anomalies
  // themselves are already in Mongo.
  return {
    anomalyCount: result.anomalyCount,
    truncated: result.truncated,
    columnsAnalyzed: result.columnsAnalyzed
  };
}


/**
 * Handle a job that has exhausted its retries.
 *
 * Also separate so the failure path is testable: it is the branch that matters
 * most and the one least likely to be exercised by hand.
 */
async function handleJobFailure(io, job, err) {
  if (!job) return false;
  const isFinalAttempt = job.attemptsMade >= ((job.opts && job.opts.attempts) || 1);
  logger.error(
    { jobId: job.id, attempt: job.attemptsMade, final: isFinalAttempt, err: err.message },
    'analysis job failed'
  );
  // Not final: BullMQ will retry, so do not report the run dead yet.
  if (!isFinalAttempt) return false;

  await markRunFailed(job.id, err);
  emitToUser(io, job.data.userId, 'analysis:failed', {
    jobId: job.id,
    sourceId: job.data.sourceId,
    status: 'failed',
    error: err.message || 'Analysis failed'
  });
  return true;
}


function startAnalysisWorker(io) {
  if (!isConfigured()) {
    logger.warn('worker not started: REDIS_URL is not set');
    return null;
  }

  const worker = new Worker(QUEUE_NAME, (job) => processAnalysisJob(io, job), {
    connection: createConnection('worker'),
    // One analysis already fans out concurrent work inside the python service;
    // running several at once on a free instance just makes them all slow.
    concurrency: Number(process.env.ANALYSIS_CONCURRENCY || 2)
  });

  worker.on('failed', (job, err) => handleJobFailure(io, job, err));

  worker.on('error', (err) => logger.error({ err: err.message }, 'worker error'));

  logger.info({ queue: QUEUE_NAME, concurrency: worker.opts.concurrency }, 'analysis worker started');
  return worker;
}

module.exports = { startAnalysisWorker, processAnalysisJob, handleJobFailure };
