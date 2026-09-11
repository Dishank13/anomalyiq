import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../services/api';
import {
  AppShell, Crosshair, EmptyState, Readout, severityColor, Skeleton, useToast
} from '../components/ui';

/**
 * Where the anomalies fall along one source's rows.
 *
 * A count tells you a source is noisy; this tells you *where* the noise is --
 * clustered at the end, spread evenly, or one bad patch in the middle. That
 * distinction is the first thing worth knowing, and it costs one thin strip.
 */
function SeverityStrip({ anomalies, rowCount }) {
  const span = Math.max(rowCount || 1, 1);
  // Draw high severity last so it is never hidden under a low marker.
  const ordered = useMemo(() => {
    const rank = { low: 0, medium: 1, high: 2 };
    return [...anomalies].sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [anomalies]);

  return (
    <div className="relative h-7 w-full overflow-hidden rounded border border-rule bg-sunk">
      {/* Quarter rules, so a position on the strip is readable. */}
      {[0.25, 0.5, 0.75].map((f) => (
        <span key={f} className="absolute inset-y-0 w-px bg-rule" style={{ left: `${f * 100}%` }} />
      ))}
      {ordered.map((a) => (
        <span
          key={a._id}
          title={`${a.column} · row ${a.rowIndex} · ${a.severity}`}
          className="absolute top-1/2 w-[3px] -translate-y-1/2 rounded-full"
          style={{
            left: `calc(${Math.min(100, (a.rowIndex / span) * 100)}% - 1.5px)`,
            height: a.severity === 'high' ? '18px' : a.severity === 'medium' ? '13px' : '9px',
            background: severityColor[a.severity],
            opacity: a.severity === 'low' ? 0.75 : 1
          }}
        />
      ))}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [sources, setSources] = useState([]);
  const [anomalies, setAnomalies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [srcRes, anomRes] = await Promise.all([
          api.get('/api/datasources'),
          api.get('/api/anomalies?limit=500')
        ]);
        if (cancelled) return;
        setSources(srcRes.data || []);
        setAnomalies(anomRes.data.items || []);
      } catch (err) {
        if (!cancelled) toast('Could not load your overview.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [toast]);

  const totals = useMemo(() => {
    const t = { all: anomalies.length, high: 0, medium: 0, low: 0 };
    anomalies.forEach((a) => { t[a.severity] = (t[a.severity] || 0) + 1; });
    return t;
  }, [anomalies]);

  const bySource = useMemo(() => {
    const map = new Map();
    anomalies.forEach((a) => {
      const key = String(a.dataSourceId?._id || a.dataSourceId);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    });
    return map;
  }, [anomalies]);

  const ranked = useMemo(() => {
    const weight = { high: 100, medium: 10, low: 1 };
    return [...sources]
      .map((s) => {
        const found = bySource.get(String(s._id)) || [];
        const score = found.reduce((acc, a) => acc + (weight[a.severity] || 0), 0);
        return { source: s, found, score };
      })
      .sort((a, b) => b.score - a.score);
  }, [sources, bySource]);

  if (loading) {
    return (
      <AppShell>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-8 h-20 w-full" />
        <Skeleton className="mt-8 h-56 w-full" />
      </AppShell>
    );
  }

  if (!sources.length) {
    return (
      <AppShell>
        <div className="panel mt-6">
          <EmptyState
            title="Nothing to watch yet"
            action={
              <button onClick={() => navigate('/datasources')} className="btn-primary">
                Add a data source
              </button>
            }
          >
            Upload a CSV or Excel file and AnomalyIQ will find the values that do not
            fit the rest of the data, and explain why.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="eyebrow">Overview</div>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-ink">
        {totals.all
          ? `${totals.all} finding${totals.all === 1 ? '' : 's'} across ${sources.length} source${sources.length === 1 ? '' : 's'}`
          : 'No findings yet'}
      </h1>

      {/* ── readings */}
      <div className="mt-7 grid grid-cols-2 gap-x-8 gap-y-6 border-y border-rule py-6 sm:grid-cols-4">
        <Readout label="Sources" value={sources.length} />
        <Readout label="High" value={totals.high} tone="high" />
        <Readout label="Medium" value={totals.medium} tone="medium" />
        <Readout label="Low" value={totals.low} tone="low" />
      </div>

      {/* ── proportion, only when there is something to divide */}
      {totals.all > 0 && (
        <div className="mt-6">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-sunk" role="img"
               aria-label={`${totals.high} high, ${totals.medium} medium, ${totals.low} low severity findings`}>
            {['high', 'medium', 'low'].map((s) =>
              totals[s] ? (
                <span
                  key={s}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{
                    width: `${(totals[s] / totals.all) * 100}%`,
                    background: severityColor[s],
                    // 2px surface gap keeps adjacent segments from merging.
                    boxShadow: 'inset -2px 0 0 #FCFCFB'
                  }}
                />
              ) : null
            )}
          </div>
        </div>
      )}

      {/* ── sources, worst first */}
      <section className="mt-10">
        <div className="flex items-end justify-between">
          <h2 className="font-display text-xl font-semibold text-ink">Sources</h2>
          <Link to="/datasources" className="font-sans text-sm text-graphite underline decoration-rule underline-offset-4 hover:text-ink">
            Manage
          </Link>
        </div>

        <ul className="mt-4 space-y-3">
          {ranked.map(({ source, found }) => {
            const counts = found.reduce((acc, a) => {
              acc[a.severity] = (acc[a.severity] || 0) + 1; return acc;
            }, {});
            return (
              <li key={source._id}>
                <Link
                  to={`/datasources/${source._id}`}
                  className="panel block px-5 py-4 transition-colors hover:border-graphite"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-display text-base font-semibold text-ink">{source.name}</span>
                    <span className="font-mono text-[11px] text-faint">
                      {source.rowCount?.toLocaleString()} rows · {source.type.toUpperCase()}
                    </span>
                  </div>

                  <div className="mt-3">
                    {found.length ? (
                      <SeverityStrip anomalies={found} rowCount={source.rowCount} />
                    ) : (
                      <div className="flex h-7 items-center rounded border border-dashed border-rule px-3">
                        <span className="font-mono text-[11px] text-faint">
                          not analyzed yet
                        </span>
                      </div>
                    )}
                  </div>

                  {found.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                      {['high', 'medium', 'low'].map((s) =>
                        counts[s] ? (
                          <span key={s} className="inline-flex items-center gap-1.5">
                            <Crosshair severity={s} size={10} />
                            <span className="font-mono tnum text-xs text-ink">{counts[s]}</span>
                            <span className="font-mono text-[10px] uppercase tracking-wider text-faint">{s}</span>
                          </span>
                        ) : null
                      )}
                      <span className="ml-auto font-mono text-[11px] text-faint">
                        rows 0 – {source.rowCount?.toLocaleString()}
                      </span>
                    </div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </AppShell>
  );
}
