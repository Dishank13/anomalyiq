const express = require('express');
const axios = require('axios');
const auth = require('../middleware/auth');
const Anomaly = require('../models/Anomaly');
const DataSource = require('../models/DataSource');

const axiosConfig = {
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  timeout: 120000
};

function pythonError(error) {
  const detail = error.response?.data?.detail;
  if (detail) {
    return { status: error.response.status === 400 ? 400 : 502, message: detail };
  }
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
    return { status: 503, message: 'Analysis service is unavailable. Please try again shortly.' };
  }
  return { status: 500, message: error.message || 'Server error' };
}

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
      }).select('+config.fileContent');

      if (!source) {
        return res.status(404).json({ message: 'Data source not found' });
      }

      const isFileSource = source.type === 'csv' || source.type === 'excel';
      if (!isFileSource) {
        return res.status(400).json({
          message: `Analysis is not supported for ${source.type} sources yet`
        });
      }

      // Sources uploaded before file contents were stored in Mongo only have a
      // filePath pointing at a disk that no longer exists.
      if (!source.config.fileContent) {
        return res.status(400).json({
          message: 'This data source was uploaded before file storage was fixed, ' +
                   'so its file is no longer available. Please delete it and re-upload the file.'
        });
      }

      const pythonRes = await axios.post(
        `${process.env.PYTHON_SERVICE_URL}/analyze`,
        {
          source_id: source._id.toString(),
          type: source.type,
          config: {
            fileName: source.config.fileName,
            name: source.name
          },
          file_content: source.config.fileContent,
          file_format: source.config.fileFormat || 'csv',
          encoding: 'base64',
          columns: source.columns
        },
        axiosConfig
      );

      const detectedAnomalies = pythonRes.data.anomalies || [];

      if (detectedAnomalies.length === 0) {
        return res.json({ message: 'No anomalies detected', anomalies: [] });
      }

      // Re-running analysis on unchanged data used to append a fresh duplicate
      // set every time. Replace the previous run instead.
      await Anomaly.deleteMany({ userId: req.user.id, dataSourceId: source._id });

      const savedAnomalies = await Anomaly.insertMany(
        detectedAnomalies.map((a) => ({
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
        }))
      );

      // Notify other open tabs/clients. The caller gets the full list in the
      // HTTP response, and dedupes by _id, so this cannot double-count.
      for (const saved of savedAnomalies) {
        io.emit('new_anomaly', { anomaly: saved, sourceName: source.name });
      }

      res.json({
        message: `Found ${savedAnomalies.length} anomalies`,
        anomalies: savedAnomalies,
        truncated: Boolean(pythonRes.data.truncated),
        columnsAnalyzed: pythonRes.data.columns_analyzed || []
      });
    } catch (error) {
      const { status, message } = pythonError(error);
      res.status(status).json({ message });
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
      res.status(500).json({ message: 'Server error' });
    }
  });

  return router;
};
