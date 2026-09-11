import React from 'react';

/**
 * What to analyse, and how.
 *
 * The detection service has accepted these options since the methods were
 * benchmarked; until now nothing could send them, so every run used the
 * defaults and analysed whichever five numeric columns happened to come first.
 */

const METHODS = [
  { id: 'zscore', name: 'Z-score', note: 'drift and spikes against a rolling local mean' },
  { id: 'iqr', name: 'IQR', note: 'global outliers, assumes no distribution' },
  { id: 'stl', name: 'Seasonal', note: 'values wrong for their point in a cycle' },
  { id: 'isolation_forest', name: 'Multivariate', note: 'rows odd across several columns at once' }
];

export default function AnalysisConfig({
  numericColumns = [], columns, methods, zThreshold,
  onChange, onRun, onClose, running
}) {
  const toggle = (list, value) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div className="panel animate-fade-up p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-base font-semibold text-ink">Configure analysis</h3>
          <p className="mt-0.5 text-sm text-graphite">
            Leave columns empty to analyse the first five numeric columns.
          </p>
        </div>
        <button onClick={onClose} className="btn-ghost px-2 py-1 text-xs">Close</button>
      </div>

      {/* ── Columns */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Columns</span>
          <span className="font-mono text-[11px] text-faint">
            {columns.length ? `${columns.length} selected` : `default · first 5 of ${numericColumns.length}`}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {numericColumns.map((c) => {
            const on = columns.includes(c);
            return (
              <button
                key={c}
                onClick={() => onChange({ columns: toggle(columns, c) })}
                aria-pressed={on}
                className={`rounded border px-2 py-1 font-mono text-xs transition-colors
                  ${on ? 'border-ink bg-ink text-paper'
                       : 'border-rule bg-paper text-graphite hover:border-graphite hover:text-ink'}`}
              >
                {c}
              </button>
            );
          })}
          {!numericColumns.length && (
            <span className="text-sm text-faint">Run an analysis once to discover the columns.</span>
          )}
        </div>
      </div>

      {/* ── Methods */}
      <div className="mt-5">
        <span className="eyebrow">Methods</span>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {METHODS.map((m) => {
            const on = methods.includes(m.id);
            return (
              <button
                key={m.id}
                onClick={() => onChange({ methods: toggle(methods, m.id) })}
                aria-pressed={on}
                className={`rounded border px-3 py-2 text-left transition-colors
                  ${on ? 'border-ink bg-sunk' : 'border-rule bg-paper hover:border-graphite'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[2px] border
                    ${on ? 'border-ink bg-ink' : 'border-rule'}`}>
                    {on && (
                      <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="#FCFCFB"
                              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="font-sans text-sm font-medium text-ink">{m.name}</span>
                </div>
                <p className="mt-1 pl-[22px] text-xs leading-snug text-graphite">{m.note}</p>
              </button>
            );
          })}
        </div>
        {!methods.length && (
          <p className="mt-1.5 font-mono text-[11px] text-faint">default · z-score and IQR</p>
        )}
      </div>

      {/* ── Threshold */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Z-score threshold</span>
          <span className="font-mono tnum text-sm text-ink">{zThreshold.toFixed(1)}</span>
        </div>
        <input
          type="range" min="2" max="6" step="0.1" value={zThreshold}
          onChange={(e) => onChange({ zThreshold: Number(e.target.value) })}
          className="mt-2 h-1 w-full cursor-pointer appearance-none rounded-full bg-rule
                     accent-ink [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:bg-ink"
          aria-label="Z-score threshold"
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
          <span>2.0 · more findings</span>
          <span>6.0 · only the extremes</span>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 border-t border-rule pt-4">
        <button onClick={onRun} disabled={running} className="btn-primary">
          {running ? 'Running…' : 'Run analysis'}
        </button>
        <button
          onClick={() => onChange({ columns: [], methods: [], zThreshold: 3 })}
          className="btn-ghost"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
