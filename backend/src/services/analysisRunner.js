const crypto = require('crypto');
const { callPython } = require('./pythonService');
const logger = require('../lib/logger');
const Anomaly = require('../models/Anomaly');
const AnalysisRun = require('../models/AnalysisRun');
const DataSource = require('../models/DataSource');

/**
 * The analysis itself, independent of how it was triggered.
 *
 * Both the BullMQ worker and the synchronous fallback call this, so the two
 * paths cannot drift: whether Redis is configured changes *when* the work
 * happens, never *what* happens.
 */

/** Stable id for an analysis, so identical requests collapse onto one job. */
function buildJobId(sourceId, fileHash, options = {}) {
  const shape = JSON.stringify({
    c: (options.columns || []).slice().sort(),
    m: (options.methods || []).slice().sort(),
    z: options.zThreshold ?? null,
    w: options.window ?? null,
    p: options.stlPeriod ?? null
  });
  const suffix = crypto.createHash('sha1').update(shape).digest('hex').slice(0, 8);
  return `${sourceId}:${(fileHash || 'nohash').slice(0, 12)}:${suffix}`;
}

function hashContent(base64) {
  return crypto.createHash('sha256').update(base64 || '').digest('hex');
}

/**
 * Load the source and reject anything that cannot possibly succeed, before a
 * job is queued. Cheap checks belong in the request, not in a worker the user
 * has to wait on to be told they made a mistake.
 */
async function loadAnalysableSource(userId, sourceId) {
  const source = await DataSource.findOne({ _id: sourceId, userId })
    .select('+config.fileContent');

  if (!source) {
    const err = new Error('Data source not found');
    err.status = 404;
    throw err;
  }
  if (source.type !== 'csv' && source.type !== 'excel') {
    const err = new Error(`Analysis is not supported for ${source.type} sources yet`);
    err.status = 400;
    throw err;
  }
  // Sources uploaded before file contents were stored in Mongo only have a
  // filePath pointing at a disk that no longer exists.
  if (!source.config.fileContent) {
    const err = new Error(
      'This data source was uploaded before file storage was fixed, so its file is ' +
      'no longer available. Please delete it and re-upload the file.'
    );
    err.status = 400;
    throw err;
  }
  return source;
}

/**
 * Run one analysis to completion.
 *
 * `onProgress(percent, stage)` is invoked as the run advances; the worker maps
 * it onto job progress and socket events, the inline path straight onto socket
 * events.
 */
async function runAnalysis({ userId, sourceId, options = {}, requestId, onProgress = () => {} }) {
  // Guard the lookup: a query of { jobId: undefined } is not "match nothing",
  // it can match the first document in the collection and mutate an unrelated
  // run. Both callers do pass a jobId; this makes that a requirement rather
  // than an assumption.
  const run = options.jobId
    ? await AnalysisRun.findOneAndUpdate(
        { jobId: options.jobId },
        { status: 'running', startedAt: new Date(), $inc: { attempts: 1 } },
        { new: true }
      )
    : null;

  const emit = async (progress, stage) => {
    if (run) {
      await AnalysisRun.updateOne({ _id: run._id }, { progress, stage }).catch(() => {});
    }
    try { await onProgress(progress, stage); } catch (err) { /* never fail a run on a notification */ }
  };

  await emit(5, 'loading data source');
  const source = await loadAnalysableSource(userId, sourceId);

  await emit(15, 'detecting anomalies');
  const pythonData = await callPython('/analyze', {
    source_id: source._id.toString(),
    type: source.type,
    config: { fileName: source.config.fileName, name: source.name },
    file_content: source.config.fileContent,
    file_format: source.config.fileFormat || 'csv',
    encoding: 'base64',
    columns: options.columns && options.columns.length ? options.columns : undefined,
    methods: options.methods && options.methods.length ? options.methods : undefined,
    z_threshold: typeof options.zThreshold === 'number' ? options.zThreshold : undefined,
    window: typeof options.window === 'number' ? options.window : undefined,
    stl_period: typeof options.stlPeriod === 'number' ? options.stlPeriod : undefined
  }, { requestId });

  const detected = pythonData.anomalies || [];
  await emit(75, 'saving results');

  // Write the new findings BEFORE removing the old ones.
  //
  // The original order deleted first, which meant any failure in between --
  // a validation error, a dropped connection -- left the source with no
  // findings at all rather than the previous run's. Insert-then-prune is
  // recoverable in both directions: a failed insert leaves the old results
  // untouched, and a failed prune leaves duplicates that the next run clears.
  const saved = detected.length
    ? await Anomaly.insertMany(detected.map((a) => ({
        userId,
        dataSourceId: source._id,
        column: a.column,
        rowIndex: a.row_index,
        timestamp: a.timestamp,
        value: a.value,
        expectedMin: a.expected_min,
        expectedMax: a.expected_max,
        zScore: a.z_score,
        method: a.method,
        severity: a.severity,
        explanation: a.explanation,
        suggestion: a.suggestion
      })))
    : [];

  // Now that the new rows are safely stored, drop everything that is not part
  // of this run. With no findings this correctly clears the source.
  await Anomaly.deleteMany({
    userId,
    dataSourceId: source._id,
    _id: { $nin: saved.map((d) => d._id) }
  });

  const result = {
    sourceId: source._id.toString(),
    sourceName: source.name,
    anomalies: saved,
    anomalyCount: saved.length,
    truncated: Boolean(pythonData.truncated),
    columnsAnalyzed: pythonData.columns_analyzed || [],
    numericColumns: pythonData.numeric_columns || [],
    methodsUsed: pythonData.methods_used || []
  };

  if (run) {
    await AnalysisRun.updateOne({ _id: run._id }, {
      status: 'succeeded',
      progress: 100,
      stage: 'complete',
      finishedAt: new Date(),
      anomalyCount: result.anomalyCount,
      truncated: result.truncated,
      columnsAnalyzed: result.columnsAnalyzed,
      numericColumns: result.numericColumns,
      methodsUsed: result.methodsUsed,
      error: null
    });
  }

  await emit(100, 'complete');
  logger.info({ requestId, sourceId, count: result.anomalyCount }, 'analysis complete');
  return result;
}

async function markRunFailed(jobId, error) {
  if (!jobId) return;
  await AnalysisRun.updateOne({ jobId }, {
    status: 'failed',
    stage: 'failed',
    finishedAt: new Date(),
    // The user-facing message, not the stack: these are surfaced in the UI.
    error: error.message || 'Analysis failed'
  }).catch(() => {});
}

module.exports = { runAnalysis, loadAnalysableSource, buildJobId, hashContent, markRunFailed };
