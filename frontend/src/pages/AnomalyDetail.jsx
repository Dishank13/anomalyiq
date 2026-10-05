import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../services/api';
import socket from '../services/socket';
import warmAnalysisService from '../services/warm';
import AnalysisConfig from '../components/AnalysisConfig';
import AnomalyChart, { compact, full } from '../components/AnomalyChart';
import {
  AppShell, Crosshair, EmptyState, Field, ProgressBar, SeverityBadge,
  Skeleton, useToast
} from '../components/ui';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const METHOD_LABEL = {
  zscore: 'Z-score (rolling)',
  iqr: 'IQR',
  stl: 'Seasonal (STL)',
  isolation_forest: 'Multivariate'
};

export default function AnomalyDetail() {
  const { id } = useParams();
  const toast = useToast();

  const [source, setSource] = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [rows, setRows] = useState([]);
  const [numericColumns, setNumericColumns] = useState([]);
  const [plotColumn, setPlotColumn] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [job, setJob] = useState(null);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [waking, setWaking] = useState(false);
  const [config, setConfig] = useState({ columns: [], methods: [], zThreshold: 3 });

  /* ── initial load */
  useEffect(() => {
    warmAnalysisService();
    let cancelled = false;
    (async () => {
      try {
        const [srcRes, anomRes] = await Promise.all([
          api.get(`/api/datasources/${id}`),
          api.get(`/api/anomalies/source/${id}?limit=500`)
        ]);
        if (cancelled) return;
        setSource(srcRes.data);
        setAnomalies(anomRes.data.items || []);
        setNumericColumns(srcRes.data.numericColumns || []);
      } catch (err) {
        if (!cancelled) toast(err.response?.data?.message || 'Could not load this data source.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, toast]);

  /* ── the series behind the chart.
        Fetched separately: it is the largest payload on the page, and the
        findings are useful before it arrives. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingSeries(true);
      // The python service may be cold. Say so rather than appearing to hang.
      const wakeTimer = setTimeout(() => { if (!cancelled) setWaking(true); }, 4000);
      try {
        const { data } = await api.get(`/api/datasources/${id}/data`);
        if (!cancelled) setRows(data.rows || []);
      } catch (err) {
        if (!cancelled) toast('Could not load the series behind the chart.', 'error');
      } finally {
        clearTimeout(wakeTimer);
        if (!cancelled) { setLoadingSeries(false); setWaking(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [id, toast]);

  /* ── live job lifecycle */
  const refreshAnomalies = useCallback(async () => {
    const res = await api.get(`/api/anomalies/source/${id}?limit=500`);
    setAnomalies(res.data.items || []);
  }, [id]);

  useEffect(() => {
    socket.connect();
    const mine = (d) => !d.sourceId || String(d.sourceId) === String(id);

    const onConnectError = (err) => {
      if (/unauthorized/i.test(err.message)) {
        toast('Live updates unavailable — your session may have expired.', 'error');
      }
    };
    const onProgress = (d) => {
      if (!mine(d)) return;
      setJob({ status: d.status || 'running', progress: d.progress || 0, stage: d.stage });
    };
    const onCompleted = async (d) => {
      if (!mine(d)) return;
      setJob(null);
      setAnalyzing(false);
      await refreshAnomalies().catch(() => {});
      if (d.numericColumns && d.numericColumns.length) setNumericColumns(d.numericColumns);
      toast(d.anomalyCount
        ? `Analysis complete — ${d.anomalyCount} finding${d.anomalyCount === 1 ? '' : 's'}.`
        : 'Analysis complete — nothing out of range.');
    };
    const onFailed = (d) => {
      if (!mine(d)) return;
      setJob(null);
      setAnalyzing(false);
      toast(d.error || 'Analysis failed.', 'error');
    };

    socket.on('connect_error', onConnectError);
    socket.on('analysis:queued', onProgress);
    socket.on('analysis:running', onProgress);
    socket.on('analysis:progress', onProgress);
    socket.on('analysis:completed', onCompleted);
    socket.on('analysis:failed', onFailed);

    return () => {
      socket.off('connect_error', onConnectError);
      socket.off('analysis:queued', onProgress);
      socket.off('analysis:running', onProgress);
      socket.off('analysis:progress', onProgress);
      socket.off('analysis:completed', onCompleted);
      socket.off('analysis:failed', onFailed);
      socket.disconnect();
    };
  }, [id, toast, refreshAnomalies]);

  /* ── run */
  const pollRun = useCallback(async (jobId) => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const { data } = await api.get(`/api/anomalies/runs/${encodeURIComponent(jobId)}`);
        setJob({ status: data.status, progress: data.progress, stage: data.stage });
        if (data.status === 'succeeded') {
          setJob(null); setAnalyzing(false);
          await refreshAnomalies();
          toast(`Analysis complete — ${data.anomalyCount || 0} findings.`);
          return;
        }
        if (data.status === 'failed') {
          setJob(null); setAnalyzing(false);
          toast(data.error || 'Analysis failed.', 'error');
          return;
        }
      } catch (err) {
        return;
      }
    }
  }, [refreshAnomalies, toast]);

  const runAnalysis = async () => {
    setAnalyzing(true);
    setSelected(null);
    setShowConfig(false);
    setJob({ status: 'queued', progress: 0, stage: 'queued' });
    try {
      const body = {};
      if (config.columns.length) body.columns = config.columns;
      if (config.methods.length) body.methods = config.methods;
      if (config.zThreshold !== 3) body.zThreshold = config.zThreshold;

      const res = await api.post(`/api/anomalies/analyze/${id}`, body);

      if (res.data.mode === 'inline') {
        setAnomalies(res.data.anomalies || []);
        if (res.data.numericColumns && res.data.numericColumns.length) {
          setNumericColumns(res.data.numericColumns);
        }
        setJob(null);
        setAnalyzing(false);
        toast(res.data.anomalyCount
          ? `Analysis complete — ${res.data.anomalyCount} findings.`
          : 'Analysis complete — nothing out of range.');
        return;
      }
      toast(res.data.deduplicated ? 'Already running — following that job.' : 'Analysis queued.');
      pollRun(res.data.jobId);
    } catch (err) {
      setJob(null);
      setAnalyzing(false);
      toast(err.response?.data?.message || 'Analysis failed.', 'error');
    }
  };

  /* ── derived */
  const counts = useMemo(() => {
    const c = { all: anomalies.length, high: 0, medium: 0, low: 0 };
    anomalies.forEach((a) => { c[a.severity] = (c[a.severity] || 0) + 1; });
    return c;
  }, [anomalies]);

  const columnsWithFindings = useMemo(() => {
    const seen = new Map();
    anomalies.forEach((a) => seen.set(a.column, (seen.get(a.column) || 0) + 1));
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [anomalies]);

  // Plot whichever column has the most findings first -- the one worth looking at.
  useEffect(() => {
    if (!plotColumn && columnsWithFindings.length) setPlotColumn(columnsWithFindings[0][0]);
  }, [columnsWithFindings, plotColumn]);

  const visible = useMemo(() => {
    const list = filter === 'all' ? anomalies : anomalies.filter((a) => a.severity === filter);
    return [...list].sort((a, b) =>
      (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
      (Math.abs(b.zScore) - Math.abs(a.zScore)));
  }, [anomalies, filter]);

  const chartAnomalies = useMemo(
    () => anomalies.filter((a) => a.column === plotColumn),
    [anomalies, plotColumn]
  );

  const selectedAnomaly = useMemo(
    () => anomalies.find((a) => a._id === selected) || null,
    [anomalies, selected]
  );

  /* ── render */
  if (loading) {
    return (
      <AppShell wide>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-6 h-[380px] w-full" />
        <Skeleton className="mt-8 h-64 w-full" />
      </AppShell>
    );
  }

  return (
    <AppShell wide>
      {/* ── source header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Source</div>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-ink">
            {source?.name}
          </h1>
          <p className="mt-1 font-mono text-xs text-graphite">
            {source?.rowCount?.toLocaleString()} rows · {source?.columns?.length} columns
            {numericColumns.length ? ` · ${numericColumns.length} numeric` : ''}
            {source?.config?.fileName ? ` · ${source.config.fileName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowConfig((v) => !v)} className="btn-ghost">Configure</button>
          <button onClick={runAnalysis} disabled={analyzing} className="btn-primary">
            {analyzing ? 'Running…' : 'Run analysis'}
          </button>
        </div>
      </div>

      {showConfig && (
        <div className="mt-5">
          <AnalysisConfig
            numericColumns={numericColumns}
            columns={config.columns}
            methods={config.methods}
            zThreshold={config.zThreshold}
            onChange={(patch) => setConfig((c) => ({ ...c, ...patch }))}
            onRun={runAnalysis}
            onClose={() => setShowConfig(false)}
            running={analyzing}
          />
        </div>
      )}

      {job && (
        <div className="mt-5">
          <ProgressBar percent={job.progress} stage={job.stage || job.status} />
        </div>
      )}

      {/* ── the chart */}
      <section className="panel mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
          <div className="flex items-baseline gap-3">
            <span className="eyebrow">Series</span>
            <span className="font-mono text-sm text-ink">{plotColumn || '—'}</span>
          </div>
          {columnsWithFindings.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {columnsWithFindings.map(([c, n]) => (
                <button
                  key={c}
                  onClick={() => { setPlotColumn(c); setSelected(null); }}
                  className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors
                    ${c === plotColumn ? 'border-ink bg-ink text-paper'
                                       : 'border-rule text-graphite hover:border-graphite hover:text-ink'}`}
                >
                  {c} <span className="tnum opacity-60">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-2 py-4">
          {loadingSeries ? (
            <div className="px-3">
              <Skeleton className="h-[340px] w-full" />
              {waking && (
                <p className="mt-3 text-center font-mono text-xs text-graphite">
                  Waking the analysis service — the first request after idle takes about a minute.
                </p>
              )}
            </div>
          ) : rows.length && plotColumn ? (
            <AnomalyChart
              rows={rows}
              column={plotColumn}
              anomalies={chartAnomalies}
              selected={selectedAnomaly?.rowIndex}
              onSelect={(rowIndex) => {
                const hit = anomalies.find((a) => a.rowIndex === rowIndex && a.column === plotColumn);
                setSelected(hit ? hit._id : null);
              }}
            />
          ) : (
            <EmptyState title="Nothing plotted yet">
              Run an analysis to find out-of-range values. They appear marked on the series.
            </EmptyState>
          )}
        </div>

        {rows.length > 0 && (
          <p className="border-t border-rule px-5 py-2 font-mono text-[11px] text-faint">
            First {rows.length.toLocaleString()} rows. Select a marked point to see the range it broke.
          </p>
        )}
      </section>

      {/* ── findings */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold text-ink">
            Findings <span className="font-mono tnum text-base font-normal text-graphite">{counts.all}</span>
          </h2>
          <div className="flex gap-1" role="group" aria-label="Filter by severity">
            {['all', 'high', 'medium', 'low'].map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                aria-pressed={filter === s}
                className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1
                            font-mono text-xs capitalize transition-colors
                  ${filter === s ? 'border-ink bg-ink text-paper'
                                 : 'border-rule text-graphite hover:border-graphite hover:text-ink'}`}
              >
                {s !== 'all' && <Crosshair severity={s} size={9} />}
                {s} <span className="tnum opacity-60">{counts[s] || 0}</span>
              </button>
            ))}
          </div>
        </div>

        {counts.all === 0 ? (
          <div className="panel mt-4">
            <EmptyState
              title="No findings yet"
              action={<button onClick={runAnalysis} className="btn-primary">Run analysis</button>}
            >
              Analysis looks for values that fall outside what the surrounding data predicts.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <ul className="panel max-h-[560px] divide-y divide-rule overflow-y-auto">
              {visible.map((a) => {
                const on = a._id === selected;
                return (
                  <li key={a._id}>
                    <button
                      onClick={() => {
                        setSelected(on ? null : a._id);
                        if (!on && a.column !== plotColumn) setPlotColumn(a.column);
                      }}
                      className={`flex w-full items-baseline gap-4 px-4 py-3 text-left transition-colors
                        ${on ? 'bg-sunk' : 'hover:bg-sunk/60'}`}
                    >
                      <SeverityBadge severity={a.severity} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs text-graphite">{a.column}</span>
                        <span className="mt-0.5 block font-mono tnum text-sm text-ink">{full(a.value)}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono tnum text-sm text-ink">
                          z {Math.abs(a.zScore).toFixed(2)}
                        </span>
                        <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wider text-faint">
                          row {a.rowIndex}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <aside className="panel h-fit lg:sticky lg:top-20">
              {selectedAnomaly ? (
                <div className="animate-fade-up p-5">
                  <div className="flex items-center justify-between">
                    <SeverityBadge severity={selectedAnomaly.severity} />
                    <span className="font-mono text-[11px] text-faint">row {selectedAnomaly.rowIndex}</span>
                  </div>

                  <div className="mt-4">
                    <div className="eyebrow">{selectedAnomaly.column}</div>
                    <div className="mt-1 font-mono tnum text-3xl text-ink">
                      {compact(selectedAnomaly.value)}
                    </div>
                    <div className="mt-1 font-mono tnum text-xs text-graphite">
                      {full(selectedAnomaly.value)}
                    </div>
                  </div>

                  <div className="mt-4 divide-y divide-rule border-y border-rule">
                    <Field label="Expected">
                      {compact(selectedAnomaly.expectedMin)} – {compact(selectedAnomaly.expectedMax)}
                    </Field>
                    <Field label="Z-score">{selectedAnomaly.zScore?.toFixed(2)}</Field>
                    <Field label="Method" mono={false}>
                      <span className="font-sans text-sm">
                        {METHOD_LABEL[selectedAnomaly.method] || selectedAnomaly.method}
                      </span>
                    </Field>
                  </div>

                  {selectedAnomaly.explanation && (
                    <div className="mt-4">
                      <div className="eyebrow">Explanation</div>
                      <p className="mt-1.5 text-sm leading-relaxed text-ink">
                        {selectedAnomaly.explanation}
                      </p>
                    </div>
                  )}
                  {selectedAnomaly.suggestion && (
                    <div className="mt-4 rounded bg-sunk p-3">
                      <div className="eyebrow">Investigate</div>
                      <p className="mt-1.5 text-sm leading-relaxed text-ink">
                        {selectedAnomaly.suggestion}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <EmptyState title="Select a finding">
                  Pick one from the list, or click a marked point on the series above.
                </EmptyState>
              )}
            </aside>
          </div>
        )}
      </section>
    </AppShell>
  );
}
