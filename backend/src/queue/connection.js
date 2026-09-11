const IORedis = require('ioredis');
const logger = require('../lib/logger');

/**
 * Redis connections, or null when Redis is not configured.
 *
 * Redis is optional on purpose. Render dropped its free tier, and a portfolio
 * project that stops working because a managed add-on lapsed is worse than one
 * that degrades to doing the work inline. Every caller treats a null
 * connection as "run synchronously" rather than as an error -- see
 * analysisQueue.isEnabled().
 */
const REDIS_URL = process.env.REDIS_URL || '';

// BullMQ blocks on its connection, so it requires this to be null rather than
// the ioredis default of 20 -- a capped retry count makes a blocking command
// throw instead of waiting for the server to come back.
const BASE_OPTIONS = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Upstash and most managed providers require TLS; rediss:// signals it.
  ...(REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}),
  retryStrategy: (times) => Math.min(times * 500, 5000)
};

let warned = false;

function createConnection(role) {
  if (!REDIS_URL) {
    if (!warned) {
      logger.warn(
        'REDIS_URL is not set - analysis will run synchronously in the request. ' +
        'Set REDIS_URL to enable the background queue.'
      );
      warned = true;
    }
    return null;
  }

  const client = new IORedis(REDIS_URL, BASE_OPTIONS);
  client.on('error', (err) => {
    // Do not let a connection blip take the process down; the queue reports
    // itself unhealthy and callers fall back.
    logger.error({ err: err.message, role }, 'redis connection error');
  });
  client.on('connect', () => logger.info({ role }, 'redis connected'));
  return client;
}

const isConfigured = () => Boolean(REDIS_URL);

module.exports = { createConnection, isConfigured, REDIS_URL, BASE_OPTIONS };
