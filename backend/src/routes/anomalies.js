const express = require('express');
const axios = require('axios');
const fs = require('fs');
const auth = require('../middleware/auth');
const Anomaly = require('../models/Anomaly');
const DataSource = require('../models/DataSource');

module.exports = (io) => {
  const router = express.Router();

  // GET all anomalies for logged in user
  router.get('/', auth, async (req, res) => {
    try {
      const anomalies = await Anomaly.find({ userId: req.user.id })
        .populate('dataSourceId', 'name type')
        .sort({ createdAt: -1 });
      res.json(anomalies);
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  });

  // GET anomalies for a specific data source
  router.get('/source/:sourceId', auth, async (req, res) => {
    try {
      const anomalies = await Anomaly.find({
        userId: req.user.id,
        dataSourceId: req.params.sourceId
      }).sort({ createdAt: -1 });
      res.json(anomalies);
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  });

  // POST trigger analysis on a data source
  router.post('/analyze/:sourceId', auth, async (req, res) => {
    try {
      const source = await DataSource.findOne({
        _id: req.params.sourceId,
        userId: req.user.id
      });

      if (!source) {
        return res.status(404).json({ message: 'Data source not found' });
      }

      let fileContent = null;
      if (source.type === 'csv') {
        fileContent = fs.readFileSync(source.config.filePath, 'utf8');
      }

      const pythonRes = await axios.post(
        `${process.env.PYTHON_SERVICE_URL}/analyze`,
        {
          source_id: source._id.toString(),
          type: source.type,
          config: source.config,
          file_content: fileContent,
          columns: source.columns
        }
      );

      const detectedAnomalies = pythonRes.data.anomalies;

      if (detectedAnomalies.length === 0) {
        return res.json({ message: 'No anomalies detected', anomalies: [] });
      }

      // Save anomalies one by one and emit each via socket
      const savedAnomalies = [];
      for (const a of detectedAnomalies) {
        const saved = await Anomaly.create({
          userId: req.user.id,
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
        });

        savedAnomalies.push(saved);

        // Emit to all connected clients
        io.emit('new_anomaly', {
          anomaly: saved,
          sourceName: source.name
        });
      }

      res.json({
        message: `Found ${savedAnomalies.length} anomalies`,
        anomalies: savedAnomalies
      });

    } catch (error) {
      res.status(500).json({ message: 'Server error', error: error.message });
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
      res.json(anomaly);
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  });

  return router;
};