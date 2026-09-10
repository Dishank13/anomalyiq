const pino = require('pino');

// Pretty output is a dev-only convenience; production emits JSON lines so the
// host's log viewer can parse and filter them.
const isProduction = process.env.NODE_ENV === 'production';

// pino-pretty is a devDependency, so it is absent from a production install.
// Probe for it rather than assuming NODE_ENV is set correctly -- a missing
// transport target throws at startup, which would take the whole API down
// over a logging preference.
function prettyTransport() {
  if (isProduction) return null;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } };
  } catch (err) {
    return null;
  }
}

const transport = prettyTransport();

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // Never let a token or an uploaded file body reach the logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      '*.fileContent',
      'config.fileContent'
    ],
    censor: '[redacted]'
  },
  ...(transport ? { transport } : {})
});

module.exports = logger;
