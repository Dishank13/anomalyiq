import React from 'react';
import { Link } from 'react-router-dom';

/**
 * The shared frame for sign in and sign up.
 *
 * The right panel is the product's own thesis rather than decoration: a series
 * with one point marked out of range. That is the whole idea in one image, and
 * it is the first thing a new visitor sees.
 */
function ControlChartMotif() {
  // A fixed, hand-picked series -- deterministic, so the marketing image never
  // changes shape between loads.
  const pts = [38, 41, 36, 44, 39, 42, 37, 43, 40, 45, 38, 41, 12, 39, 42, 37, 44, 40, 43, 39];
  const w = 320, h = 170, pad = 14;
  const step = (w - pad * 2) / (pts.length - 1);
  const max = 52, min = 6;
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const path = pts.map((v, i) => `${i ? 'L' : 'M'} ${pad + i * step} ${y(v)}`).join(' ');

  const outlierIdx = 12;
  const ox = pad + outlierIdx * step;
  const oy = y(pts[outlierIdx]);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-sm" role="img"
         aria-label="A data series with one point marked as out of range">
      {/* expected band */}
      <rect x={pad} y={y(46)} width={w - pad * 2} height={y(33) - y(46)}
            fill="#15181B" fillOpacity="0.04" />
      <line x1={pad} y1={y(46)} x2={w - pad} y2={y(46)} stroke="#E2E3DE" strokeDasharray="4 4" />
      <line x1={pad} y1={y(33)} x2={w - pad} y2={y(33)} stroke="#E2E3DE" strokeDasharray="4 4" />

      <path d={path} fill="none" stroke="#15181B" strokeWidth="1.75"
            strokeLinejoin="round" strokeLinecap="round" />

      {/* the one out-of-control point, in the same mark the app uses */}
      <circle cx={ox} cy={oy} r="9.5" fill="none" stroke="#FCFCFB" strokeWidth="3" />
      <circle cx={ox} cy={oy} r="7" fill="#FCFCFB" stroke="#B02015" strokeWidth="2.5" />
      <line x1={ox} y1={oy - 12} x2={ox} y2={oy - 6} stroke="#B02015" strokeWidth="2" />
      <line x1={ox} y1={oy + 6} x2={ox} y2={oy + 12} stroke="#B02015" strokeWidth="2" />
      <line x1={ox - 12} y1={oy} x2={ox - 6} y2={oy} stroke="#B02015" strokeWidth="2" />
      <line x1={ox + 6} y1={oy} x2={ox + 12} y2={oy} stroke="#B02015" strokeWidth="2" />
    </svg>
  );
}

export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="min-h-screen bg-paper lg:grid lg:grid-cols-2">
      {/* form */}
      <div className="flex min-h-screen flex-col justify-center px-6 py-12 sm:px-12 lg:min-h-0">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/" className="inline-flex items-baseline">
            <span className="font-display text-xl font-semibold tracking-tight text-ink">Anomaly</span>
            <span className="relative font-display text-xl font-semibold tracking-tight text-ink">
              IQ
              <svg width="8" height="8" viewBox="0 0 24 24" aria-hidden="true"
                   className="absolute -right-3 -top-0.5">
                <circle cx="12" cy="12" r="8" fill="none" stroke="#B02015" strokeWidth="4" />
              </svg>
            </span>
          </Link>

          <h1 className="mt-10 font-display text-3xl font-semibold tracking-tight text-ink">
            {title}
          </h1>
          {subtitle && <p className="mt-2 text-sm text-graphite">{subtitle}</p>}

          <div className="mt-8">{children}</div>

          {footer && <div className="mt-8 text-sm text-graphite">{footer}</div>}
        </div>
      </div>

      {/* thesis */}
      <div className="hidden items-center justify-center border-l border-rule bg-sunk px-12 lg:flex">
        <div className="max-w-sm">
          <ControlChartMotif />
          <h2 className="mt-8 font-display text-2xl font-semibold leading-snug tracking-tight text-ink">
            One of these values does not belong.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-graphite">
            AnomalyIQ reads a spreadsheet, works out what normal looks like for each
            column, and marks the values that break it — with the statistics behind
            the call and a plain-English reason.
          </p>
          <dl className="mt-8 space-y-3 border-t border-rule pt-6">
            {[
              ['4 methods', 'z-score, IQR, seasonal and multivariate'],
              ['Benchmarked', 'scored against data with known anomalies'],
              ['Explained', 'every finding says why, in a sentence']
            ].map(([k, v]) => (
              <div key={k} className="flex gap-4">
                <dt className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-[0.1em] text-ink">{k}</dt>
                <dd className="text-xs leading-relaxed text-graphite">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
