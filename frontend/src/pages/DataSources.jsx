import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  addSource, fetchSourcesFailure, fetchSourcesStart, fetchSourcesSuccess, removeSource
} from '../store/slices/dataSlice';
import api from '../services/api';
import warmAnalysisService, { ensureAwake } from '../services/warm';
import ServiceStatus from '../components/ServiceStatus';
import { AppShell, EmptyState, Skeleton, useToast } from '../components/ui';

const ACCEPTED = ['.csv', '.xlsx', '.xls'];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const prettySize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/** Drop target and file picker in one. */
function UploadPanel({ onClose, onUploaded }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState(null);

  const accept = (chosen) => {
    if (!chosen) return;
    const ext = chosen.name.slice(chosen.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED.includes(ext)) {
      setError('That file type is not supported. Use CSV, XLSX or XLS.');
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${prettySize(chosen.size)}. The limit is 8 MB.`);
      return;
    }
    setError(null);
    setFile(chosen);
    // Offer the filename as the source name, so most uploads need no typing.
    if (!name) setName(chosen.name.replace(/\.[^.]+$/, ''));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file) { setError('Choose a file to upload.'); return; }
    if (!name.trim()) { setError('Give this source a name.'); return; }

    setSubmitting(true);
    setError(null);
    try {
      // The API cannot wake the detection service itself, so make sure it is
      // up before handing it work -- otherwise this upload is a guaranteed
      // failure rather than a slow success.
      setWaking(true);
      const awake = await ensureAwake();
      setWaking(false);
      if (!awake) {
        setError('The analysis service could not be reached. Please try again in a moment.');
        setSubmitting(false);
        return;
      }

      const form = new FormData();
      form.append('name', name.trim());
      form.append('file', file);
      const res = await api.post('/api/datasources/file', form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      onUploaded(res.data);
      toast(`Added ${res.data.name}.`);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Upload failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel animate-fade-up p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-base font-semibold text-ink">Add a data source</h3>
          <p className="mt-0.5 text-sm text-graphite">
            CSV, XLSX or XLS up to 8 MB. The first sheet of a workbook is used.
          </p>
        </div>
        <button type="button" onClick={onClose} className="btn-ghost px-2 py-1 text-xs">Close</button>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); accept(e.dataTransfer.files?.[0]); }}
        onClick={() => inputRef.current?.click()}
        className={`mt-4 cursor-pointer rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors
          ${dragging ? 'border-ink bg-sunk' : 'border-rule hover:border-graphite'}`}
      >
        <input
          ref={inputRef} type="file" className="sr-only"
          accept=".csv,.xlsx,.xls"
          onChange={(e) => accept(e.target.files?.[0])}
        />
        {file ? (
          <>
            <p className="font-mono text-sm text-ink">{file.name}</p>
            <p className="mt-1 font-mono text-xs text-graphite">{prettySize(file.size)} · click to replace</p>
          </>
        ) : (
          <>
            <p className="font-sans text-sm text-ink">Drop a file here, or click to browse</p>
            <p className="mt-1 font-mono text-xs text-faint">.csv · .xlsx · .xls</p>
          </>
        )}
      </div>

      <label className="mt-4 block">
        <span className="eyebrow">Name</span>
        <input
          className="field mt-1.5" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Q3 sales export" required
        />
      </label>

      {error && (
        <p role="alert" className="mt-3 rounded border border-high/30 bg-high/[0.06] px-3 py-2 text-sm text-high">
          {error}
        </p>
      )}

      <div className="mt-5 flex gap-2 border-t border-rule pt-4">
        <button type="submit" disabled={submitting} className="btn-primary">
          {waking ? 'Starting the service…' : submitting ? 'Uploading…' : 'Add source'}
        </button>
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <ServiceStatus className="ml-auto" />
      </div>
    </form>
  );
}

export default function DataSources() {
  const dispatch = useDispatch();
  const toast = useToast();
  const { sources, loading } = useSelector((state) => state.data);
  const [showUpload, setShowUpload] = useState(false);
  const [confirming, setConfirming] = useState(null);

  useEffect(() => {
    // Start waking the analysis service now, so it is up by the time a file is
    // chosen rather than only starting to boot on submit.
    warmAnalysisService();
    (async () => {
      dispatch(fetchSourcesStart());
      try {
        const res = await api.get('/api/datasources');
        dispatch(fetchSourcesSuccess(res.data));
      } catch (err) {
        dispatch(fetchSourcesFailure('Could not load your data sources.'));
        toast('Could not load your data sources.', 'error');
      }
    })();
  }, [dispatch, toast]);

  const destroy = async (source) => {
    try {
      await api.delete(`/api/datasources/${source._id}`);
      dispatch(removeSource(source._id));
      toast(`Deleted ${source.name}.`);
    } catch (err) {
      toast('Could not delete that source.', 'error');
    } finally {
      setConfirming(null);
    }
  };

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Data</div>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-ink">
            Sources
          </h1>
        </div>
        {!showUpload && (
          <button
            onClick={() => { warmAnalysisService(); setShowUpload(true); }}
            className="btn-primary"
          >
            Add source
          </button>
        )}
      </div>

      {showUpload && (
        <div className="mt-5">
          <UploadPanel
            onClose={() => setShowUpload(false)}
            onUploaded={(s) => dispatch(addSource(s))}
          />
        </div>
      )}

      {loading ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !sources.length ? (
        <div className="panel mt-6">
          <EmptyState
            title="No data sources"
            action={<button onClick={() => setShowUpload(true)} className="btn-primary">Add your first source</button>}
          >
            Upload a spreadsheet and AnomalyIQ will look for values that do not fit the rest of the data.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {sources.map((s) => (
            <li key={s._id} className="panel px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link
                    to={`/datasources/${s._id}`}
                    className="font-display text-base font-semibold text-ink underline decoration-transparent underline-offset-4 transition hover:decoration-rule"
                  >
                    {s.name}
                  </Link>
                  <p className="mt-1 font-mono text-[11px] text-graphite">
                    {s.rowCount?.toLocaleString()} rows · {s.columns?.length} columns
                    {s.numericColumns?.length ? ` · ${s.numericColumns.length} numeric` : ''}
                    {s.config?.fileName ? ` · ${s.config.fileName}` : ''}
                  </p>

                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {s.columns?.slice(0, 6).map((c) => (
                      <span key={c} className="rounded border border-rule px-1.5 py-0.5 font-mono text-[10px] text-graphite">
                        {c}
                      </span>
                    ))}
                    {s.columns?.length > 6 && (
                      <span className="px-1 py-0.5 font-mono text-[10px] text-faint">
                        +{s.columns.length - 6}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Link to={`/datasources/${s._id}`} className="btn-ghost">Open</Link>
                  {confirming === s._id ? (
                    <span className="flex items-center gap-1.5">
                      <button onClick={() => destroy(s)} className="btn bg-high px-2.5 py-2 text-xs text-paper hover:bg-high/90">
                        Delete
                      </button>
                      <button onClick={() => setConfirming(null)} className="btn-ghost px-2.5 py-2 text-xs">
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirming(s._id)}
                      aria-label={`Delete ${s.name}`}
                      className="btn-ghost px-2.5 py-2 text-xs text-graphite hover:text-high"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
