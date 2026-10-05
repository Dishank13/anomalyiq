import React, { useEffect, useState } from 'react';
import { getState, STATE, subscribe } from '../services/warm';

/**
 * Whether the detection service is awake.
 *
 * Shown only while it is waking or unreachable: a "ready" badge sitting there
 * permanently is noise. On the free tier the service sleeps after 15 minutes,
 * and waking it takes about a minute, so saying so beats an unexplained wait.
 */
export default function ServiceStatus({ className = '' }) {
  const [state, setState] = useState(getState());
  useEffect(() => subscribe(setState), []);

  if (state === STATE.READY || state === STATE.UNKNOWN) return null;

  const waking = state === STATE.WAKING;
  return (
    <span className={`inline-flex items-center gap-2 font-mono text-[11px] ${className}
      ${waking ? 'text-graphite' : 'text-medium'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${waking ? 'animate-pulse bg-graphite' : 'bg-medium'}`} />
      {waking
        ? 'starting the analysis service…'
        : 'analysis service unreachable'}
    </span>
  );
}
