const mongoose = require('mongoose');

const anomalySchema = new mongoose.Schema({
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
  column: {
    type: String,
    required: true
  },
  rowIndex: Number,
  timestamp: String,
  value: Number,
  expectedMin: Number,
  expectedMax: Number,
  zScore: Number,
  method: {
    type: String,
    enum: ['zscore', 'iqr'],
    required: true
  },
  severity: {
    type: String,
    enum: ['low', 'medium', 'high'],
    required: true
  },
  explanation: String,
  suggestion: String,
  isRead: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

module.exports = mongoose.model('Anomaly', anomalySchema);