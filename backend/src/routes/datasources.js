const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const auth = require('../middleware/auth');
const DataSource = require('../models/DataSource');

const router = express.Router();

// Multer setup for CSV uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname) !== '.csv') {
      return cb(new Error('Only CSV files allowed'));
    }
    cb(null, true);
  }
});

// GET all data sources for logged in user
router.get('/', auth, async (req, res) => {
  try {
    const sources = await DataSource.find({ userId: req.user.id });
    res.json(sources);
  } catch (error) {
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

    const pythonRes = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/ingest/stock`,
      { symbol }
    );

    const source = await DataSource.create({
      userId: req.user.id,
      name,
      type: 'stock',
      config: { symbol: symbol.toUpperCase() },
      columns: pythonRes.data.columns,
      rowCount: pythonRes.data.row_count,
      lastFetched: new Date()
    });

    res.status(201).json(source);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// POST upload a CSV data source
router.post('/csv', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Name required' });
    }

    // Read file content and send directly to Python service
    const fileContent = fs.readFileSync(req.file.path, 'utf8');

    const pythonRes = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/ingest/csv`,
      { file_content: fileContent, name }
    );

    const source = await DataSource.create({
      userId: req.user.id,
      name,
      type: 'csv',
      config: { filePath: req.file.path, fileName: req.file.originalname },
      columns: pythonRes.data.columns,
      rowCount: pythonRes.data.row_count,
      lastFetched: new Date()
    });

    res.status(201).json(source);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET data for a specific source (for charting)
router.get('/:id/data', auth, async (req, res) => {
  try {
    const source = await DataSource.findOne({
      _id: req.params.id,
      userId: req.user.id
    });

    if (!source) {
      return res.status(404).json({ message: 'Data source not found' });
    }

    const pythonRes = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/data`,
      { source_id: source._id, type: source.type, config: source.config }
    );

    res.json(pythonRes.data);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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