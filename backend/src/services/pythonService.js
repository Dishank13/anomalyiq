const axios = require('axios');

// Render free instances spin down after 15 minutes, so the first call after an
// idle period can take ~50s to wake the service.
const REQUEST_TIMEOUT = Number(process.env.PYTHON_TIMEOUT_MS || 90000);
const RETRY_DELAY_MS = Number(process.env.PYTHON_RETRY_DELAY_MS || 2000);

// Transient upstream failures worth one retry. A cold-starting or briefly
// rate-limited free instance answers fine a couple of seconds later.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  // A timeout already burned the full budget; retrying just doubles the wait.
  if (error.code === 'ECONNABORTED') return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  return Boolean(error.response && RETRYABLE_STATUSES.has(error.response.status));
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
      return {
        status: 503,
        message: 'The analysis service is busy or waking up. Please try again in a moment.' +
                 (detail ? ` (upstream ${res.status}: ${detail})` : ` (upstream ${res.status})`)
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

async function callPython(path, payload) {
  const url = `${process.env.PYTHON_SERVICE_URL}${path}`;
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.post(url, payload, {
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: REQUEST_TIMEOUT
      });
      return res.data;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isRetryable(error)) {
        console.warn(
          `python ${path} failed (${error.response ? error.response.status : error.code}); retrying once`
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  const { status, message } = describeError(lastError);
  const err = new Error(message);
  err.status = status;
  err.upstreamStatus = lastError.response ? lastError.response.status : null;
  err.upstreamCode = lastError.code || null;
  console.error(
    `python ${path} -> ${status} (upstream ${err.upstreamStatus || err.upstreamCode}): ${message}`
  );
  throw err;
}

module.exports = { callPython, describeError };
