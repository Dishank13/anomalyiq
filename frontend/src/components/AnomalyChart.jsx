import React, { useMemo } from 'react';
import {
  CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis
} from 'recharts';
import { severityColor } from './ui';

/* Compact numerals, so a y-axis of share volumes does not need 9 digits. */
export function compact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n === 0) return '0';          // otherwise toPrecision(3) renders "0.00"
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  if (abs >= 1) return n.toFixed(2).replace(/\.00$/, '');
  return n.toPrecision(3);
}

export const full = (n) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * The out-of-control mark.
 *
 * A ring with a crosshair rather than a filled dot: it stays legible where
 * points overlap, it reads at a glance against the line, and it means severity
 * is never carried by colour alone. The paper-coloured outer ring is the 2px
 * surface gap that keeps two adjacent marks from merging.
 */
function CrosshairMark(props) {
  const { cx, cy, payload, selected } = props;
  if (cx == null || cy == null) return null;
  const c = severityColor[payload.severity] || severityColor.low;
  const r = payload.severity === 'high' ? 7 : payload.severity === 'medium' ? 6 : 5;
  const isSel = selected === payload.rowIndex;

  return (
    <g style={{ cursor: 'pointer' }}>
      {/* Surface ring: separates overlapping marks. */}
      <circle cx={cx} cy={cy} r={r + 2.5} fill="none" stroke="#FCFCFB" strokeWidth="3" />
      {isSel && <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke={c} strokeWidth="1" opacity="0.5" />}
      <circle cx={cx} cy={cy} r={r} fill="#FCFCFB" stroke={c} strokeWidth={isSel ? 3 : 2.25} />
      <line x1={cx} y1={cy - r - 4} x2={cx} y2={cy - r + 1} stroke={c} strokeWidth="2" />
      <line x1={cx} y1={cy + r - 1} x2={cx} y2={cy + r + 4} stroke={c} strokeWidth="2" />
      <line x1={cx - r - 4} y1={cy} x2={cx - r + 1} y2={cy} stroke={c} strokeWidth="2" />
      <line x1={cx + r - 1} y1={cy} x2={cx + r + 4} y2={cy} stroke={c} strokeWidth="2" />
      {/* Generous invisible hit target. */}
      <circle cx={cx} cy={cy} r={r + 8} fill="transparent" />
    </g>
  );
}

function ChartTooltip({ active, payload, column }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  const anomaly = p.severity;
  return (
    <div className="pointer-events-none rounded-md border border-rule bg-paper px-3 py-2 shadow-lifted">
      <div className="eyebrow">row {p.i}</div>
      <div className="mt-1 font-mono tnum text-sm text-ink">{full(p.value)}</div>
      <div className="mt-0.5 text-[11px] text-graphite">{column}</div>
      {anomaly && (
        <div className="mt-2 border-t border-rule pt-1.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em]"
               style={{ color: severityColor[p.severity] }}>
            {p.severity} · z {p.zScore?.toFixed(2)}
          </div>
          <div className="mt-0.5 font-mono tnum text-[11px] text-graphite">
            expected {compact(p.expectedMin)} – {compact(p.expectedMax)}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The series, with its out-of-control points marked.
 *
 * There is deliberately no continuous "expected range" band. The rolling
 * bounds are only known at the points the server actually tested, so drawing a
 * band everywhere would mean interpolating limits the analysis never computed.
 * Instead, selecting an anomaly reveals the exact range *that* point violated
 * -- which is the question the chart exists to answer.
 */
export default function AnomalyChart({ rows, column, anomalies, selected, onSelect, height = 340 }) {
  const data = useMemo(() => {
    const byRow = new Map();
    (anomalies || []).forEach((a) => byRow.set(a.rowIndex, a));
    return (rows || []).map((r, i) => {
      const value = Number(r[column]);
      const a = byRow.get(i);
      return {
        i,
        value: Number.isFinite(value) ? value : null,
        ...(a ? {
          severity: a.severity, zScore: a.zScore, rowIndex: a.rowIndex,
          expectedMin: a.expectedMin, expectedMax: a.expectedMax, anomalyValue: value
        } : {})
      };
    });
  }, [rows, column, anomalies]);

  const marks = useMemo(() => data.filter((d) => d.severity && d.value != null), [data]);
  const sel = useMemo(
    () => marks.find((m) => m.rowIndex === selected) || null,
    [marks, selected]
  );

  if (!rows || !rows.length) return null;

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
          {/* Recessive grid: present enough to read a value against, quiet
              enough that the line and the marks stay dominant. */}
          <CartesianGrid stroke="#E2E3DE" strokeDasharray="2 4" vertical={false} />

          {/* The range the selected point actually violated. */}
          {sel && (
            <ReferenceArea
              y1={sel.expectedMin} y2={sel.expectedMax}
              fill={severityColor[sel.severity]} fillOpacity={0.07}
              stroke={severityColor[sel.severity]} strokeOpacity={0.3} strokeDasharray="4 4"
            />
          )}
          {sel && (
            <ReferenceLine x={sel.i} stroke={severityColor[sel.severity]}
                           strokeOpacity={0.35} strokeDasharray="3 3" />
          )}

          <XAxis
            dataKey="i" type="number" domain={['dataMin', 'dataMax']}
            tick={{ fill: '#9AA0A5', fontSize: 11, fontFamily: 'IBM Plex Mono' }}
            tickLine={false} axisLine={{ stroke: '#E2E3DE' }} minTickGap={40}
          />
          <YAxis
            tickFormatter={compact} width={60}
            tick={{ fill: '#9AA0A5', fontSize: 11, fontFamily: 'IBM Plex Mono' }}
            tickLine={false} axisLine={false}
          />
          <Tooltip
            content={<ChartTooltip column={column} />}
            cursor={{ stroke: '#9AA0A5', strokeWidth: 1, strokeDasharray: '3 3' }}
          />

          <Line
            type="linear" dataKey="value" stroke="#15181B" strokeWidth={1.75}
            dot={false} activeDot={{ r: 3, fill: '#15181B', stroke: '#FCFCFB', strokeWidth: 2 }}
            connectNulls isAnimationActive={false}
          />

          <Scatter
            data={marks} dataKey="value"
            shape={<CrosshairMark selected={selected} />}
            onClick={(p) => onSelect && onSelect(p.rowIndex)}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
