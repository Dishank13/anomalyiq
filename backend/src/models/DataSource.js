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
    enum: ['csv', 'excel', 'stock', 'sports'],
    required: true
  },
  config: {
    symbol: String,        // for stocks e.g. "AAPL"
    sport: String,         // for sports
    league: String,
    team: String,
    fileName: String,      // original upload name, e.g. "sales.xlsx"
    fileFormat: String,    // csv | xlsx | xls
    fileSize: Number,      // bytes, before base64 encoding
    // The uploaded file itself, base64 encoded. Stored in Mongo rather than on
    // disk because the host filesystem is ephemeral: it is wiped on every
    // restart, redeploy and idle spin-down, which used to make "Run Analysis"
    // fail with ENOENT for every source uploaded before the last restart.
    // select:false keeps it out of list queries — ask for it explicitly with
    // .select('+config.fileContent') when you actually need to parse the file.
    fileContent: { type: String, select: false }
  },
  columns: [String],       // detected columns from the data
  numericColumns: [String],
  rowCount: Number,
  lastFetched: Date,
  status: {
    type: String,
    enum: ['active', 'error', 'processing'],
    default: 'active'
  }
}, { timestamps: true });

module.exports = mongoose.model('DataSource', dataSourceSchema);
