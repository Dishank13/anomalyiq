const mongoose = require('mongoose');

/**
 * One analysis attempt, queued or synchronous.
 *
 * Exists so a run is observable after the fact: a websocket that dropped, a
 * tab that was closed, or a worker that died mid-job all used to leave the
 * user with no way to find out what happened. This is also what
 * GET /api/anomalies/runs/:jobId reads, so the UI has a poll fallback when the
 * socket is unavailable.
 */
const analysisRunSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataSourceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DataSource',
    required: true
  },
  // Deterministic, derived from the source and its file contents, so
  // re-triggering an identical analysis collapses onto the same job rather
  // than queueing a duplicate.
  jobId: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['queued', 'running', 'succeeded', 'failed'],
    default: 'queued',
    required: true
  },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  stage: String,                 // human-readable: "detecting", "explaining"
  mode: {
    type: String,
    enum: ['queued', 'inline'],  // inline = ran synchronously, no Redis
    default: 'queued'
  },
  options: {
    columns: [String],
    methods: [String],
    zThreshold: Number
  },
  anomalyCount: Number,
  truncated: Boolean,
  columnsAnalyzed: [String],
  numericColumns: [String],
  methodsUsed: [String],
  error: String,
  attempts: { type: Number, default: 0 },
  requestId: String,             // ties the run to the log trail
  startedAt: Date,
  finishedAt: Date
}, { timestamps: true });

// "the latest runs for this source", which is what the UI asks for.
analysisRunSchema.index({ userId: 1, dataSourceId: 1, createdAt: -1 });

analysisRunSchema.methods.toStatus = function toStatus() {
  return {
    jobId: this.jobId,
    status: this.status,
    progress: this.progress,
    stage: this.stage,
    mode: this.mode,
    anomalyCount: this.anomalyCount,
    truncated: this.truncated,
    columnsAnalyzed: this.columnsAnalyzed,
    numericColumns: this.numericColumns,
    methodsUsed: this.methodsUsed,
    error: this.error,
    dataSourceId: this.dataSourceId,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt
  };
};

module.exports = mongoose.model('AnalysisRun', analysisRunSchema);
