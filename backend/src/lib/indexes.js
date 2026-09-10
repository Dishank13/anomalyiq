const logger = require('./logger');

/**
 * Build every index declared on the schemas, and wait for it.
 *
 * Mongoose's autoIndex is not a safe thing to depend on: it is routinely
 * disabled in production for startup cost, and when it is on it races with the
 * first queries. That matters here because the unique index on User.email is
 * the *only* thing preventing duplicate accounts -- the old findOne() check it
 * replaced lost the race between two concurrent signups. If the index is not
 * actually there, duplicate registrations succeed silently.
 *
 * createIndexes() only adds what is missing, so this is safe to run on every
 * boot and cheap once the indexes exist.
 */
async function ensureIndexes() {
  const models = [
    require('../models/User'),
    require('../models/DataSource'),
    require('../models/Anomaly')
  ];

  for (const Model of models) {
    try {
      await Model.createIndexes();
      logger.debug({ model: Model.modelName }, 'indexes ensured');
    } catch (err) {
      // A failed index build should not stop the server from serving reads,
      // but it must be loud: it means a uniqueness guarantee is missing.
      logger.error({ err, model: Model.modelName }, 'index creation failed');
    }
  }
  logger.info({ models: models.map((m) => m.modelName) }, 'indexes ready');
}

module.exports = { ensureIndexes };
