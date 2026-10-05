import api from './api';

/**
 * Nudge the analysis service awake.
 *
 * Free-tier instances sleep after 15 minutes idle and take 25-50s to wake, and
 * while they wake the platform edge rejects requests. Calling this when a page
 * that will need analysis opens means the wake-up overlaps with the user
 * choosing a file, instead of starting only once they hit submit.
 *
 * Deliberately fire-and-forget: it is an optimisation, and its failure must
 * never surface to the user or block anything.
 */
let lastWarmedAt = 0;
const WARM_INTERVAL_MS = 5 * 60 * 1000;

export default function warmAnalysisService() {
  const now = Date.now();
  if (now - lastWarmedAt < WARM_INTERVAL_MS) return;
  lastWarmedAt = now;
  // /readyz probes the python service, which is what triggers the spin-up.
  api.get('/readyz', { timeout: 8000 }).catch(() => {});
}
