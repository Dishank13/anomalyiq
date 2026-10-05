/**
 * Wake the detection service from the browser.
 *
 * Render will not spin up a sleeping free instance for traffic that originates
 * inside its own network: the edge answers 429 and the service stays asleep.
 * This was measured -- over nine minutes of continuous requests from the API
 * never woke it, while a single request from outside woke it in ~25 seconds.
 * So the API physically cannot warm the detection service on its own, and
 * retrying there is futile.
 *
 * The user's browser is an external client, so it can. Pinging /healthz when a
 * page that will need analysis opens means the ~1 minute spin-up overlaps with
 * the user choosing a file instead of running headlong into a failure.
 *
 * Uses plain fetch rather than the axios instance on purpose: that instance
 * attaches the user's JWT, and the detection service has no business receiving
 * it.
 */

const PYTHON_URL = (process.env.REACT_APP_PYTHON_URL ||
  'https://anomalyiq-python.onrender.com').replace(/\/$/, '');

// Render documents roughly a minute to restart; allow headroom.
const WAKE_TIMEOUT_MS = 100000;
// Once awake it stays awake for 15 minutes of traffic; re-ping well inside that.
const FRESH_FOR_MS = 5 * 60 * 1000;

export const STATE = { UNKNOWN: 'unknown', WAKING: 'waking', READY: 'ready', UNREACHABLE: 'unreachable' };

let state = STATE.UNKNOWN;
let readyAt = 0;
let inFlight = null;
const listeners = new Set();

function setState(next) {
  if (state === next) return;
  state = next;
  listeners.forEach((fn) => { try { fn(state); } catch (e) { /* a bad listener must not break warming */ } });
}

export function getState() {
  // Readiness goes stale: the service sleeps again after 15 minutes idle.
  if (state === STATE.READY && Date.now() - readyAt > FRESH_FOR_MS) return STATE.UNKNOWN;
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Start (or join) a wake-up. Returns a promise resolving true once the service
 * answers. Safe to call repeatedly -- concurrent callers share one request.
 */
export function ensureAwake() {
  if (getState() === STATE.READY) return Promise.resolve(true);
  if (inFlight) return inFlight;

  setState(STATE.WAKING);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAKE_TIMEOUT_MS);

  inFlight = fetch(`${PYTHON_URL}/healthz`, { signal: controller.signal, cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new Error(`healthz ${res.status}`);
      readyAt = Date.now();
      setState(STATE.READY);
      return true;
    })
    .catch(() => {
      setState(STATE.UNREACHABLE);
      return false;
    })
    .finally(() => {
      clearTimeout(timer);
      inFlight = null;
    });

  return inFlight;
}

/** Fire-and-forget warm-up for page mount. Never throws, never blocks. */
export default function warmAnalysisService() {
  if (getState() === STATE.READY) return;
  ensureAwake().catch(() => {});
}
