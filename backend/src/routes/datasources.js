const express = require('express');
const multer = require('multer');
const path = require('path');
const auth = require('../middleware/auth');
const { callPython } = require('../services/pythonService');
const DataSource = require('../models/DataSource');
const logger = require('../lib/logger');
const { hashContent } = require('../services/analysisRunner');

const router = express.Router();

// A Mongo document is capped at 16MB and base64 inflates by ~33%, so keep the
// raw upload well under that ceiling.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const ALLOWED_EXTENSIONS = {
  '.csv': 'csv',
  '.xlsx': 'xlsx',
  '.xls': 'xls'
};

// Files are held in memory and persisted to Mongo — never written to the
// container's disk, which does not survive a restart.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS[ext]) {
      const err = new Error('Unsupported file type. Please upload a CSV, XLSX or XLS file.');
      err.status = 400;   // otherwise the generic handler reports it as a 500
      return cb(err);
    }
    cb(null, true);
  }
});

// GET all data sources for logged in user
// fileContent is select:false, so this never ships uploaded files to the client.
router.get('/', auth, async (req, res) => {
  try {
    const sources = await DataSource.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(sources);
  } catch (error) {
    logger.error({ err: error }, 'list data sources failed');
    res.status(500).json({ message: 'Server error' });
  }
});

// POST create a stock data source
router.post('/stock', auth, async (req, res) => {
  try {
    const { name, symbol } = req.body;
    if (!name || !symbol) {
      return res.status(400).json({ message: 'Name and symbol required' });
    }

    const pythonData = await callPython('/ingest/stock', { symbol }, { requestId: req.id });

    const source = await DataSource.create({
      userId: req.user.id,
      name,
      type: 'stock',
      config: { symbol: symbol.toUpperCase() },
      columns: pythonData.columns,
      rowCount: pythonData.row_count,
      lastFetched: new Date()
    });

    res.status(201).json(source);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Server error' });
  }
});

// POST upload a CSV or Excel data source
async function handleFileUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name required' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileFormat = ALLOWED_EXTENSIONS[ext];
    if (!fileFormat) {
      return res.status(400).json({
        message: 'Unsupported file type. Please upload a CSV, XLSX or XLS file.'
      });
    }

    const fileContent = req.file.buffer.toString('base64');

    const pythonData = await callPython('/ingest/file', {
      file_content: fileContent,
      name: name.trim(),
      file_format: fileFormat,
      encoding: 'base64'
    }, { requestId: req.id });

    const source = await DataSource.create({
      userId: req.user.id,
      name: name.trim(),
      type: fileFormat === 'csv' ? 'csv' : 'excel',
      config: {
        fileName: req.file.originalname,
        fileFormat,
        fileSize: req.file.size,
        fileContent,
        fileHash: hashContent(fileContent)
      },
      columns: pythonData.columns,
      numericColumns: pythonData.numeric_columns || [],
      rowCount: pythonData.row_count,
      lastFetched: new Date()
    });

    // Strip the stored file out of the response.
    const payload = source.toObject();
    delete payload.config.fileContent;
    res.status(201).json(payload);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Server error' });
  }
}

router.post('/file', auth, upload.single('file'), handleFileUpload);
// Retained so an older frontend build keeps working.
router.post('/csv', auth, upload.single('file'), handleFileUpload);

// GET one data source.
// AnomalyDetail used to fetch the entire source list and find() the one it
// wanted client-side, which grows worse with every upload.
router.get('/:id', auth, async (req, res) => {
  try {
    const source = await DataSource.findOne({ _id: req.params.id, userId: req.user.id });
    if (!source) {
      return res.status(404).json({ message: 'Data source not found' });
    }
    res.json(source);
  } catch (error) {
    logger.error({ err: error, sourceId: req.params.id }, 'fetch data source failed');
    res.status(500).json({ message: 'Server error' });
  }
});

// GET data for a specific source (for charting)
router.get('/:id/data', auth, async (req, res) => {
  try {
    const source = await DataSource.findOne({
      _id: req.params.id,
      userId: req.user.id
    }).select('+config.fileContent');

    if (!source) {
      return res.status(404).json({ message: 'Data source not found' });
    }

    const pythonData = await callPython('/data', {
      source_id: source._id.toString(),
      type: source.type,
      config: { symbol: source.config.symbol, fileName: source.config.fileName },
      file_content: source.config.fileContent || null,
      file_format: source.config.fileFormat || 'csv',
      encoding: 'base64'
    }, { requestId: req.id });

    res.json(pythonData);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Server error' });
  }
});

// DELETE a data source
router.delete('/:id', auth, async (req, res) => {
  try {
    const source = await DataSource.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id
    });

    if (!source) {
      return res.status(404).json({ message: 'Data source not found' });
    }

    res.json({ message: 'Data source deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
