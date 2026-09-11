const express = require('express');
const auth = require('../middleware/auth');
const { emitToUser } = require('../socket');
const { pagination } = require('../middleware/validate');
const logger = require('../lib/logger');
const analysisQueue = require('../queue/analysisQueue');
const {
  runAnalysis, loadAnalysableSource, buildJobId, hashContent, markRunFailed
} = require('../services/analysisRunner');
const Anomaly = require('../models/Anomaly');
const AnalysisRun = require('../models/AnalysisRun');
const DataSource = require('../models/DataSource');

module.exports = (io) => {
  const router = express.Router();

  // GET all anomalies for the logged in user
  router.get('/', auth, async (req, res) => {
    try {
      const { limit, page, skip } = pagination(req.query);
      const filter = { userId: req.user.id };
      const [items, total] = await Promise.all([
        Anomaly.find(filter)
          .populate('dataSourceId', 'name type')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        Anomaly.countDocuments(filter)
      ]);
      res.json({ items, total, page, limit });
    } catch (error) {
      logger.error({ err: error }, 'list anomalies failed');
      res.status(500).json({ message: 'Server error' });
    }
  });

  // GET anomalies for a specific data source
  router.get('/source/:sourceId', auth, async (req, res) => {
    try {
      const { limit, page, skip } = pagination(req.query);
      const filter = { userId: req.user.id, dataSourceId: req.params.sourceId };
      const [items, total] = await Promise.all([
        Anomaly.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Anomaly.countDocuments(filter)
      ]);
      res.json({ items, total, page, limit });
    } catch (error) {
      logger.error({ err: error, sourceId: req.params.sourceId }, 'list source anomalies failed');
      res.status(500).json({ message: 'Server error' });
    }
  });

  // POST trigger analysis on a data source.
  //
  // Returns 202 + jobId when a queue is available, or 200 with the full result
  // when it is not. Either way the response carries a jobId and a status, so
  // the client follows one code path regardless of the server's mode.
  router.post('/analyze/:sourceId', auth, async (req, res) => {
    const sourceId = req.params.sourceId;
    let jobId;

    try {
      const { columns, methods, zThreshold, window: win, stlPeriod } = req.body || {};
      const options = {
        columns: Array.isArray(columns) ? columns : undefined,
        methods: Array.isArray(methods) ? methods : undefined,
        zThreshold: typeof zThreshold === 'number' ? zThreshold : undefined,
        window: typeof win === 'number' ? win : undefined,
        stlPeriod: typeof stlPeriod === 'number' ? stlPeriod : undefined
      };

      // Validate before queueing. Someone who picked a deleted source should
      // be told now, not after waiting on a worker.
      const source = await loadAnalysableSource(req.user.id, sourceId);

      // Hash the stored file so identical re-runs collapse onto one job.
      // Backfilled for sources uploaded before the field existed.
      let fileHash = source.config.fileHash;
      if (!fileHash) {
        fileHash = hashContent(source.config.fileContent);
        await DataSource.updateOne({ _id: source._id }, { 'config.fileHash': fileHash });
      }

      jobId = buildJobId(sourceId, fileHash, options);
      const queued = analysisQueue.isEnabled();

      // An in-flight run over exactly this data with exactly these options is
      // the job we already have; a second click should join it, not race it.
      const existing = await AnalysisRun.findOne({ jobId });
      if (existing && ['queued', 'running'].includes(existing.status)) {
        return res.status(202).json({
          ...existing.toStatus(),
          message: 'This analysis is already running.',
          deduplicated: true
        });
      }

      // Two simultaneous clicks can both pass the check above and race this
      // upsert; the unique index on jobId turns the loser into an E11000.
      // That collision means the other request already created the run, which
      // is exactly the outcome we wanted, so treat it as success.
      await AnalysisRun.findOneAndUpdate(
        { jobId },
        {
          userId: req.user.id,
          dataSourceId: source._id,
          jobId,
          status: 'queued',
          progress: 0,
          stage: 'queued',
          mode: queued ? 'queued' : 'inline',
          options: {
            columns: options.columns || [],
            methods: options.methods || [],
            zThreshold: options.zThreshold
          },
          error: null,
          attempts: 0,
          requestId: req.id,
          startedAt: null,
          finishedAt: null
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).catch((err) => {
        if (err.code !== 11000) throw err;
      });

      // -- Queued path
      if (queued) {
        await analysisQueue.enqueueAnalysis(jobId, {
          userId: req.user.id, sourceId, options, requestId: req.id
        });
        emitToUser(io, req.user.id, 'analysis:queued', {
          jobId, sourceId, status: 'queued', progress: 0
        });
        logger.info({ jobId, sourceId, requestId: req.id }, 'analysis queued');
        return res.status(202).json({
          jobId,
          status: 'queued',
          mode: 'queued',
          sourceId,
          message: 'Analysis queued.'
        });
      }

      // -- Inline fallback: no Redis, so do the work inside the request. Same
      // runner, same events, same persisted AnalysisRun; only the timing
      // differs, which is what stops this path from rotting unnoticed.
      const result = await runAnalysis({
        userId: req.user.id,
        sourceId,
        options: Object.assign({}, options, { jobId }),
        requestId: req.id,
        onProgress: (progress, stage) => {
          emitToUser(io, req.user.id, 'analysis:progress', {
            jobId, sourceId, status: 'running', progress, stage
          });
        }
      });

      for (const saved of result.anomalies) {
        emitToUser(io, req.user.id, 'new_anomaly', {
          anomaly: saved, sourceName: result.sourceName
        });
      }
      emitToUser(io, req.user.id, 'analysis:completed', {
        jobId,
        sourceId,
        status: 'succeeded',
        progress: 100,
        anomalyCount: result.anomalyCount,
        truncated: result.truncated,
        columnsAnalyzed: result.columnsAnalyzed,
        numericColumns: result.numericColumns,
        methodsUsed: result.methodsUsed
      });

      return res.json({
        jobId,
        status: 'succeeded',
        mode: 'inline',
        sourceId,
        message: result.anomalyCount
          ? 'Found ' + result.anomalyCount + ' anomalies'
          : 'No anomalies detected',
        anomalies: result.anomalies,
        anomalyCount: result.anomalyCount,
        truncated: result.truncated,
        columnsAnalyzed: result.columnsAnalyzed,
        numericColumns: result.numericColumns,
        methodsUsed: result.methodsUsed
      });
    } catch (error) {
      await markRunFailed(jobId, error);
      if (!error.status || error.status >= 500) {
        logger.error({ err: error, sourceId, jobId }, 'analysis failed');
      }
      res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
  });

  // GET the status of one run.
  // The poll fallback for when the websocket is unavailable or dropped: a
  // closed tab must not make a run unobservable.
  router.get('/runs/:jobId', auth, async (req, res) => {
    try {
      const run = await AnalysisRun.findOne({ jobId: req.params.jobId, userId: req.user.id });
      if (!run) {
        return res.status(404).json({ message: 'Analysis run not found' });
      }
      res.json(run.toStatus());
    } catch (error) {
      logger.error({ err: error, jobId: req.params.jobId }, 'fetch run failed');
      res.status(500).json({ message: 'Server error' });
    }
  });

  // GET recent runs for a data source.
  router.get('/runs/source/:sourceId', auth, async (req, res) => {
    try {
      const runs = await AnalysisRun.find({
        userId: req.user.id, dataSourceId: req.params.sourceId
      }).sort({ createdAt: -1 }).limit(10);
      res.json({ items: runs.map((r) => r.toStatus()) });
    } catch (error) {
      logger.error({ err: error }, 'list runs failed');
      res.status(500).json({ message: 'Server error' });
    }
  });

  // PATCH mark anomaly as read
  router.patch('/:id/read', auth, async (req, res) => {
    try {
      const anomaly = await Anomaly.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.id },
        { isRead: true },
        { new: true }
      );
      if (!anomaly) {
        return res.status(404).json({ message: 'Anomaly not found' });
      }
      res.json(anomaly);
    } catch (error) {
      logger.error({ err: error }, 'mark anomaly read failed');
      res.status(500).json({ message: 'Server error' });
    }
  });

  return router;
};
