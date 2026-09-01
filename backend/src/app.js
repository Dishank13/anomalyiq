const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const multer = require('multer');
const { Server } = require('socket.io');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Allow the production frontend, local dev, Vercel preview deployments, and
// anything set via CORS_ORIGINS (comma separated).
const staticOrigins = [
  'https://anomalyiq.vercel.app',
  'http://localhost:3000',
  ...(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)
];

const corsOrigin = (origin, callback) => {
  // Non-browser callers (curl, health checks) send no Origin header.
  if (!origin) return callback(null, true);
  if (staticOrigins.includes(origin)) return callback(null, true);
  // Vercel preview URLs, e.g. https://anomalyiq-git-branch-user.vercel.app
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return callback(null, true);
  return callback(new Error(`Not allowed by CORS: ${origin}`));
};

const io = new Server(server, {
  cors: { origin: corsOrigin, credentials: true }
});

// Middleware
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/datasources', require('./routes/datasources'));
app.use('/api/anomalies', require('./routes/anomalies')(io));

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'AnomalyIQ backend is running!' });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Error handler. Without this, a rejected upload fell through to Express's
// default handler and returned an HTML stack trace, so the frontend could only
// show a generic failure message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File is too large. Maximum upload size is 8MB.' });
    }
    return res.status(400).json({ message: `Upload failed: ${err.message}` });
  }
  if (err && /Not allowed by CORS/.test(err.message)) {
    return res.status(403).json({ message: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
