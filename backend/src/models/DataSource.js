const mongoose = require('mongoose');

const dataSourceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['csv', 'stock', 'sports'],
    required: true
  },
  config: {
    symbol: String,        // for stocks e.g. "AAPL"
    sport: String,         // for sports
    league: String,
    team: String,
    filePath: String       // for CSV uploads
  },
  columns: [String],       // detected columns from the data
  rowCount: Number,
  lastFetched: Date,
  status: {
    type: String,
    enum: ['active', 'error', 'processing'],
    default: 'active'
  }
}, { timestamps: true });

module.exports = mongoose.model('DataSource', dataSourceSchema);