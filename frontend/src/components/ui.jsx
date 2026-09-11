import React, { createContext, useCallback, useContext, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { logout } from '../store/slices/authSlice';

/* ─────────────────────────────────────────────────────────── severity ──── */

export const SEVERITIES = ['high', 'medium', 'low'];

export const severityColor = {
  high: '#B02015',
  medium: '#CE8500',
  low: '#1668B0'
};

const severityClass = {
  high: 'text-high border-high/30 bg-high/[0.06]',
  medium: 'text-medium border-medium/30 bg-medium/[0.06]',
  low: 'text-low border-low/30 bg-low/[0.06]'
};

/**
 * The crosshair mark used for every anomaly, on the chart and beside it.
 *
 * Out-of-control points in a control chart get their own glyph rather than
 * just a different colour -- which also means severity is never communicated
 * by colour alone.
 */
export function Crosshair({ severity = 'low', size = 12, className = '' }) {
  const c = severityColor[severity] || severityColor.low;
  const r = size / 2;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke={c} strokeWidth="2.5" />
      <line x1="12" y1="0" x2="12" y2="5" stroke={c} strokeWidth="2.5" />
      <line x1="12" y1="19" x2="12" y2="24" stroke={c} strokeWidth="2.5" />
      <line x1="0" y1="12" x2="5" y2="12" stroke={c} strokeWidth="2.5" />
      <line x1="19" y1="12" x2="24" y2="12" stroke={c} strokeWidth="2.5" />
      {r < 0 && null}
    </svg>
  );
}

export function SeverityBadge({ severity, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5
                  font-mono text-[10px] uppercase tracking-[0.1em]
                  ${severityClass[severity] || severityClass.low} ${className}`}
    >
      <Crosshair severity={severity} size={9} />
      {severity}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────── readouts ──── */

/** A labelled number. Mono, tabular, label beneath -- an instrument reading. */
export function Readout({ label, value, tone = 'ink', hint }) {
  const toneClass = { ink: 'text-ink', high: 'text-high', medium: 'text-medium', low: 'text-low' }[tone];
  return (
    <div>
      <div className={`font-mono tnum text-2xl ${toneClass}`}>{value}</div>
      <div className="eyebrow mt-1">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-faint">{hint}</div>}
    </div>
  );
}

/** Key/value row used throughout the detail panel. */
export function Field({ label, children, mono = true }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="eyebrow shrink-0">{label}</span>
      <span className={`text-right text-sm text-ink ${mono ? 'font-mono tnum' : ''}`}>{children}</span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── states ──── */

export function EmptyState({ title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {/* An empty plot frame: the shape of what will be here. */}
      <svg width="56" height="40" viewBox="0 0 56 40" className="mb-4" aria-hidden="true">
        <rect x="0.5" y="0.5" width="55" height="39" fill="none" stroke="#E2E3DE" />
        <line x1="0" y1="26" x2="56" y2="26" stroke="#E2E3DE" strokeDasharray="3 3" />
        <line x1="0" y1="13" x2="56" y2="13" stroke="#E2E3DE" strokeDasharray="3 3" />
      </svg>
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-sm text-graphite">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return (
    <div className={`relative overflow-hidden rounded bg-sunk ${className}`}>
      <div className="absolute inset-y-0 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-paper/70 to-transparent" />
    </div>
  );
}

/** Progress for a running analysis. Shows the stage, not just a spinner. */
export function ProgressBar({ percent = 0, stage }) {
  return (
    <div className="panel px-4 py-3">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{stage || 'working'}</span>
        <span className="font-mono tnum text-xs text-graphite">{Math.round(percent)}%</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-sunk">
        <div
          className="h-full rounded-full bg-ink transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── toast ──── */

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto animate-fade-up rounded-lg border bg-paper px-4 py-3
                        text-sm shadow-lifted ${t.tone === 'error'
                          ? 'border-high/40 text-high'
                          : 'border-rule text-ink'}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ─────────────────────────────────────────────────────────────── shell ──── */

/**
 * Wordmark. The dot over the "I" is a crosshair -- the same mark the charts
 * use for an out-of-control point.
 */
function Wordmark() {
  return (
    <Link to="/dashboard" className="group inline-flex items-baseline">
      <span className="font-display text-lg font-semibold tracking-tight text-ink">Anomaly</span>
      <span className="relative font-display text-lg font-semibold tracking-tight text-ink">
        IQ
        <svg
          width="7" height="7" viewBox="0 0 24 24" aria-hidden="true"
          className="absolute -right-2.5 -top-0.5"
        >
          <circle cx="12" cy="12" r="8" fill="none" stroke="#B02015" strokeWidth="4" />
        </svg>
      </span>
    </Link>
  );
}

const NAV = [
  { to: '/dashboard', label: 'Overview' },
  { to: '/datasources', label: 'Data' }
];

export function AppShell({ children, wide = false }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useSelector((state) => state.auth);

  const signOut = () => {
    dispatch(logout());
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/90 backdrop-blur">
        <div className={`mx-auto flex h-14 items-center gap-6 px-4 sm:px-6 ${wide ? 'max-w-[1600px]' : 'max-w-6xl'}`}>
          <Wordmark />

          <nav className="flex items-center gap-1" aria-label="Main">
            {NAV.map((item) => {
              const active = pathname === item.to ||
                (item.to === '/datasources' && pathname.startsWith('/datasources'));
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded px-2.5 py-1.5 font-sans text-sm transition-colors
                    ${active ? 'text-ink' : 'text-graphite hover:text-ink'}`}
                >
                  <span className={active ? 'border-b-2 border-ink pb-1' : ''}>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-xs text-graphite sm:inline">{user?.name}</span>
            <button onClick={signOut} className="btn-ghost px-2.5 py-1.5 text-xs">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className={`mx-auto px-4 py-8 sm:px-6 ${wide ? 'max-w-[1600px]' : 'max-w-6xl'}`}>
        {children}
      </main>
    </div>
  );
}
