const axios = require('axios');
const logger = require('../lib/logger');

// Render free instances spin down after 15 minutes of inactivity. The first
// request after that has to wake the service, which takes 25-50s, and while it
// is waking Render's edge rejects requests outright -- with 429 rather than a
// 503, which is why this used to surface as a nonsensical "Too Many Requests".
const REQUEST_TIMEOUT = Number(process.env.PYTHON_TIMEOUT_MS || 90000);

// Backoff schedule, in ms, for the gaps between attempts.
//
// The old behaviour was a single retry after 2s. A cold start takes an order of
// magnitude longer than that, so both attempts landed inside the wake-up window
// and the user saw a failure for a service that was simply still booting. This
// schedule spans ~42s of waiting, which covers a normal cold start, and gives
// up rather than hanging forever if the service is genuinely down.
const RETRY_SCHEDULE_MS = (process.env.PYTHON_RETRY_SCHEDULE || '1000,3000,6000,12000,20000')
  .split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n >= 0);

// Transient upstream failures worth waiting out. 429 is included because that
// is what a spinning-up free instance returns, not because we are being rate
// limited -- see the comment above.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  // A timeout already burned the full budget; retrying just doubles the wait.
  if (error.code === 'ECONNABORTED') return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  return Boolean(error.response && RETRYABLE_STATUSES.has(error.response.status));
}

/** Respect the server's own Retry-After when present, else use the schedule. */
function retryDelay(error, attempt) {
  const scheduled = RETRY_SCHEDULE_MS[attempt] != null
    ? RETRY_SCHEDULE_MS[attempt]
    : RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] || 2000;

  const header = error.response && error.response.headers &&
    (error.response.headers['retry-after'] || error.response.headers['Retry-After']);
  if (header) {
    const seconds = Number(header);
    // Cap it: a wildly large Retry-After must not hold the request open.
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30000);
  }
  return scheduled;
}


function bodySnippet(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (typeof data === 'object') {
    if (typeof data.detail === 'string') return data.detail;
    if (typeof data.message === 'string') return data.message;
    try { return JSON.stringify(data).slice(0, 200); } catch (e) { return ''; }
  }
  return '';
}

/**
 * Translate an upstream failure into a status + message worth showing a user.
 * Preserves the real upstream status instead of collapsing everything into a
 * generic 500 with an opaque "Request failed with status code NNN".
 */
function describeError(error) {
  const res = error.response;

  if (res) {
    const detail = bodySnippet(res.data);

    // FastAPI's own validation/business errors.
    if (res.status === 400) {
      return { status: 400, message: detail || 'The analysis service rejected the request.' };
    }
    if (res.status === 404) {
      return { status: 404, message: detail || 'Not found in the analysis service.' };
    }
    if (RETRYABLE_STATUSES.has(res.status)) {
      // Deliberately does not repeat the upstream status. A 429 here means the
      // instance is still booting, and telling a user "Too Many Requests" when
      // they have made one request is actively misleading.
      return {
        status: 503,
        message: 'The analysis service is still starting up. This can take up to a ' +
                 'minute on the free tier — please try again shortly.'
      };
    }
    return {
      status: 502,
      message: detail
        ? `Analysis service error: ${detail}`
        : `Analysis service returned an unexpected status (${res.status}).`
    };
  }

  if (error.code === 'ECONNABORTED') {
    return { status: 504, message: 'The analysis service took too long to respond. Please try again.' };
  }
  if (RETRYABLE_CODES.has(error.code)) {
    return { status: 503, message: 'Could not reach the analysis service. Please try again in a moment.' };
  }
  return { status: 500, message: error.message || 'Server error' };
}

/**
 * Call the python service.
 *
 * `requestId` is forwarded as X-Request-Id so a single analysis can be traced
 * across all three services in the logs -- otherwise a failure in python is
 * impossible to line up with the API request that caused it.
 */
async function callPython(path, payload, { requestId } = {}) {
  const url = `${process.env.PYTHON_SERVICE_URL}${path}`;
  const log = logger.child({ requestId, upstream: path });
  let lastError;

  const maxAttempts = RETRY_SCHEDULE_MS.length + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await axios.post(url, payload, {
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: REQUEST_TIMEOUT,
        headers: requestId ? { 'X-Request-Id': requestId } : {}
      });
      if (attempt > 0) {
        log.info({ attempt }, 'python call succeeded after waiting out a cold start');
      } else {
        log.info({ ms: Date.now() - startedAt }, 'python call succeeded');
      }
      return res.data;
    } catch (error) {
      lastError = error;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !isRetryable(error)) break;

      const delay = retryDelay(error, attempt);
      log.warn({
        status: error.response ? error.response.status : error.code,
        ms: Date.now() - startedAt,
        attempt: attempt + 1,
        of: maxAttempts,
        retryInMs: delay
      }, 'python call failed, retrying');
      await sleep(delay);
    }
  }

  const { status, message } = describeError(lastError);
  const err = new Error(message);
  err.status = status;
  err.upstreamStatus = lastError.response ? lastError.response.status : null;
  err.upstreamCode = lastError.code || null;
  log.error(
    { status, upstreamStatus: err.upstreamStatus, upstreamCode: err.upstreamCode },
    message
  );
  throw err;
}

module.exports = { callPython, describeError };
