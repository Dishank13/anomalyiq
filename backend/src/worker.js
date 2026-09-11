/**
 * Standalone worker process: `npm run worker`.
 *
 * Runs the same worker the API can host in-process, but as its own service.
 * It holds no HTTP server and no browser sockets of its own, so it publishes
 * socket events through the Redis adapter and the API process delivers them.
 * That indirection is the entire reason the two topologies are interchangeable.
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

dotenv.config();

const logger = require('./lib/logger');
const { createConnection, isConfigured } = require('./queue/connection');
const { startAnalysisWorker } = require('./queue/analysisWorker');
const { ensureIndexes } = require('./lib/indexes');

async function main() {
  if (!isConfigured()) {
    logger.fatal('REDIS_URL is not set - a standalone worker has no queue to consume');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    logger.fatal('JWT_SECRET is not set - refusing to start');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  logger.info('MongoDB connected');
  await ensureIndexes();

  // A server with no attached HTTP listener: used purely as a publisher, so
  // emitToUser() here reaches sockets held by the API process.
  const io = new Server({ adapter: createAdapter(createConnection('worker-pub'),
                                                 createConnection('worker-sub')) });

  const worker = startAnalysisWorker(io);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'worker shutting down');
    // Let in-flight jobs finish rather than orphaning them mid-analysis.
    if (worker) await worker.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
