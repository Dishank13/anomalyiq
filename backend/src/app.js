const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const crypto = require('crypto');
const multer = require('multer');
const helmet = require('helmet');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const { Server } = require('socket.io');

const { createAdapter } = require('@socket.io/redis-adapter');

const logger = require('./lib/logger');
const { registerSocketAuth } = require('./socket');
const { createConnection, isConfigured: redisConfigured } = require('./queue/connection');
const analysisQueue = require('./queue/analysisQueue');

dotenv.config();

if (!process.env.JWT_SECRET) {
  // Failing loudly at boot beats signing tokens with `undefined` and only
  // finding out when every login silently stops verifying.
  logger.fatal('JWT_SECRET is not set - refusing to start');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Render terminates TLS at its proxy, so without this every request appears to
// come from the same address and the rate limiter would throttle all users as one.
app.set('trust proxy', 1);

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

// With the Redis adapter, an emit from the worker process reaches sockets held
// by this one. It is the piece that makes "worker in-process" and "worker as
// its own service" interchangeable without touching a line of worker code.
if (redisConfigured()) {
  io.adapter(createAdapter(createConnection('socket-pub'), createConnection('socket-sub')));
  logger.info('socket.io redis adapter enabled');
}

registerSocketAuth(io);

// On a free tier a second always-on service is a second thing to keep awake,
// so the worker can run inside the API process. docker-compose runs it as its
// own container instead -- same module, same behaviour.
if (redisConfigured() && process.env.RUN_WORKER_INLINE !== 'false') {
  require('./queue/analysisWorker').startAnalysisWorker(io);
}

// ── Middleware
app.use(helmet({
  // This is a JSON API consumed by a browser app on another origin; the
  // default same-origin resource policy would block it.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}));

app.use(pinoHttp({
  logger,
  // Reuse an upstream id when there is one so a trace survives across hops.
  genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    // Health checks would otherwise dominate the logs.
    if (req.url === '/healthz' || req.url === '/readyz') return 'silent';
    return 'info';
  }
}));

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Broad ceiling against runaway clients.
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again shortly.' }
}));

// Credential endpoints get their own, much tighter budget: login previously
// accepted unlimited attempts, which is a free offline-speed password oracle.
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX || 10),
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in a few minutes.' }
}));
app.use('/api/auth/register', rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REGISTER_RATE_LIMIT_MAX || 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many accounts created from this address. Please try again later.' }
}));

// ── Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/datasources', require('./routes/datasources'));
app.use('/api/anomalies', require('./routes/anomalies')(io));

app.get('/', (req, res) => {
  res.json({ message: 'AnomalyIQ backend is running!' });
});

// Liveness: is this process up? Deliberately checks nothing else, so a
// degraded dependency does not get the container killed and restarted.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: can this process actually serve traffic?
app.get('/readyz', async (req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;

  let pythonUp = false;
  try {
    const probe = await axios.get(`${process.env.PYTHON_SERVICE_URL}/healthz`, { timeout: 3000 });
    pythonUp = probe.status === 200;
  } catch (err) {
    pythonUp = false;
  }

  // Mongo is required to serve anything; the python service only gates
  // analysis, so a cold one is reported but not treated as failure. Redis is
  // optional by design -- without it analysis runs inline.
  const ready = mongoUp;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not ready',
    checks: {
      mongo: mongoUp,
      pythonService: pythonUp,
      redis: redisConfigured(),
      analysisMode: analysisQueue.isEnabled() ? 'queued' : 'inline'
    }
  });
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
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ message: err.message });
  }
  logger.error({ err, requestId: req.id }, 'unhandled error');
  res.status(500).json({ message: 'Server error' });
});

// ── MongoDB
const { ensureIndexes } = require('./lib/indexes');

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    logger.info('MongoDB connected');
    await ensureIndexes();
  })
  .catch((err) => logger.error({ err }, 'MongoDB connection failed'));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info({
    port: PORT,
    analysisMode: analysisQueue.isEnabled() ? 'queued' : 'inline (no REDIS_URL)'
  }, 'backend listening');
});

// Finish in-flight work instead of dropping it when the platform recycles us.
const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down');
  server.close();
  await analysisQueue.closeQueue().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, io };
