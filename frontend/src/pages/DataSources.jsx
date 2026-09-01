import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { fetchSourcesStart, fetchSourcesSuccess, fetchSourcesFailure, addSource, removeSource } from '../store/slices/dataSlice';
import { logout } from '../store/slices/authSlice';
import api from '../services/api';

function DataSources() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { sources, loading } = useSelector((state) => state.data);
  const { user } = useSelector((state) => state.auth);

  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState('file');
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const ACCEPTED = ['.csv', '.xlsx', '.xls'];
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

  useEffect(() => {
    const fetchSources = async () => {
      dispatch(fetchSourcesStart());
      try {
        const res = await api.get('/api/datasources');
        dispatch(fetchSourcesSuccess(res.data));
      } catch (err) {
        dispatch(fetchSourcesFailure('Failed to fetch sources'));
      }
    };
    fetchSources();
  }, [dispatch]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError('Please choose a file to upload.');
      return;
    }

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED.includes(ext)) {
      setError('Unsupported file type. Please upload a CSV, XLSX or XLS file.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('File is too large. Maximum upload size is 8MB.');
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('file', file);
      const res = await api.post('/api/datasources/file', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      dispatch(addSource(res.data));
      setShowForm(false);
      setName('');
      setFile(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to add source');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/api/datasources/${id}`);
      dispatch(removeSource(id));
    } catch (err) {
      alert('Failed to delete source');
    }
  };

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>AnomalyIQ</h1>
        <div style={styles.headerRight}>
          <span style={styles.userName}>{user?.name}</span>
          <button style={styles.logoutBtn} onClick={handleLogout}>Logout</button>
        </div>
      </div>

      {/* Nav */}
      <div style={styles.nav}>
        <button style={styles.navBtn} onClick={() => navigate('/dashboard')}>Dashboard</button>
        <button style={{...styles.navBtn, ...styles.navBtnActive}}>Data Sources</button>
      </div>

      {/* Content */}
      <div style={styles.content}>
        <div style={styles.contentHeader}>
          <h2 style={styles.pageTitle}>Data Sources</h2>
          <button style={styles.addBtn} onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : '+ Add Source'}
          </button>
        </div>

        {/* Add Source Form */}
        {showForm && (
          <div style={styles.form}>
            <h3 style={styles.formTitle}>Add New Data Source</h3>
            {error && <p style={styles.error}>{error}</p>}
            <form onSubmit={handleSubmit}>
              <div style={styles.formRow}>
                <label style={styles.label}>Type</label>
                <select style={styles.input} value={formType} onChange={(e) => setFormType(e.target.value)}>
                  <option value="file">File Upload (CSV or Excel)</option>
                </select>
              </div>
              <div style={styles.formRow}>
                <label style={styles.label}>Name</label>
                <input
                  style={styles.input}
                  type="text"
                  placeholder="e.g. Apple Stock Data"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              {formType === 'file' && (
                <div style={styles.formRow}>
                  <label style={styles.label}>Data File</label>
                  <input
                    style={styles.input}
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={(e) => setFile(e.target.files[0] || null)}
                    required
                  />
                  <p style={styles.hint}>
                    CSV, XLSX or XLS · up to 8MB · the first sheet of a workbook is analyzed
                  </p>
                </div>
              )}
              <button style={styles.submitBtn} type="submit" disabled={submitting}>
                {submitting ? 'Adding...' : 'Add Source'}
              </button>
            </form>
          </div>
        )}

        {/* Sources List */}
        {loading ? (
          <p style={styles.empty}>Loading...</p>
        ) : sources.length === 0 ? (
          <div style={styles.emptyState}>
            <p style={styles.emptyText}>No data sources yet.</p>
            <p style={styles.emptySubtext}>Add a CSV or Excel file to get started.</p>
          </div>
        ) : (
          <div style={styles.grid}>
            {sources.map((source) => (
              <div key={source._id} style={styles.card}>
                <div style={styles.cardHeader}>
                  <span style={styles.cardType}>{source.type.toUpperCase()}</span>
                  <button style={styles.deleteBtn} onClick={() => handleDelete(source._id)}>✕</button>
                </div>
                <h3 style={styles.cardName}>{source.name}</h3>
                <p style={styles.cardInfo}>{source.rowCount} rows • {source.columns?.length} columns</p>
                <p style={styles.cardInfo}>Last fetched: {new Date(source.lastFetched).toLocaleDateString()}</p>
                <div style={styles.cardColumns}>
                  {source.columns?.slice(0, 4).map((col) => (
                    <span key={col} style={styles.columnTag}>{col}</span>
                  ))}
                  {source.columns?.length > 4 && (
                    <span style={styles.columnTag}>+{source.columns.length - 4} more</span>
                  )}
                </div>
                <button style={styles.analyzeBtn} onClick={() => navigate(`/datasources/${source._id}`)}>
                  View & Analyze →
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: '100vh', backgroundColor: '#0f172a' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 40px', backgroundColor: '#1e293b', borderBottom: '1px solid #334155' },
  title: { color: '#3b82f6', margin: 0 },
  headerRight: { display: 'flex', alignItems: 'center', gap: '16px' },
  userName: { color: '#94a3b8' },
  logoutBtn: { padding: '8px 16px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' },
  nav: { display: 'flex', gap: '8px', padding: '16px 40px', backgroundColor: '#1e293b', borderBottom: '1px solid #334155' },
  navBtn: { padding: '8px 16px', backgroundColor: 'transparent', color: '#94a3b8', border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer' },
  navBtnActive: { backgroundColor: '#3b82f6', color: 'white', border: '1px solid #3b82f6' },
  content: { padding: '40px' },
  contentHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' },
  pageTitle: { color: '#f1f5f9', margin: 0 },
  addBtn: { padding: '10px 20px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' },
  form: { backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', marginBottom: '24px', border: '1px solid #334155' },
  formTitle: { color: '#f1f5f9', marginTop: 0 },
  formRow: { marginBottom: '16px' },
  label: { display: 'block', color: '#94a3b8', marginBottom: '6px', fontSize: '14px' },
  hint: { color: '#64748b', fontSize: '12px', margin: '6px 0 0 0' },
  input: { width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #334155', backgroundColor: '#0f172a', color: '#f1f5f9', fontSize: '14px', boxSizing: 'border-box' },
  submitBtn: { padding: '10px 24px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' },
  error: { color: '#ef4444', marginBottom: '16px' },
  emptyState: { textAlign: 'center', padding: '60px' },
  emptyText: { color: '#f1f5f9', fontSize: '20px' },
  emptySubtext: { color: '#94a3b8' },
  empty: { color: '#94a3b8', textAlign: 'center' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' },
  card: { backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  cardType: { backgroundColor: '#0f172a', color: '#3b82f6', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' },
  deleteBtn: { backgroundColor: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: '16px' },
  cardName: { color: '#f1f5f9', margin: '0 0 8px 0' },
  cardInfo: { color: '#94a3b8', fontSize: '14px', margin: '4px 0' },
  cardColumns: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '12px 0' },
  columnTag: { backgroundColor: '#0f172a', color: '#64748b', padding: '2px 8px', borderRadius: '4px', fontSize: '12px' },
  analyzeBtn: { width: '100%', padding: '10px', backgroundColor: 'transparent', color: '#3b82f6', border: '1px solid #3b82f6', borderRadius: '8px', cursor: 'pointer', marginTop: '8px' }
};

export default DataSources;