import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { logout } from '../store/slices/authSlice';
import api from '../services/api';
import socket from '../services/socket';

function AnomalyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { user } = useSelector((state) => state.auth);

  const [source, setSource] = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [sourcesRes, anomaliesRes] = await Promise.all([
          api.get('/api/datasources'),
          api.get(`/api/anomalies/source/${id}`)
        ]);
        const src = sourcesRes.data.find(s => s._id === id);
        setSource(src);
        setAnomalies(anomaliesRes.data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [id]);
  useEffect(() => {
  socket.connect();

  const handleNewAnomaly = (data) => {
    if (data.anomaly.dataSourceId === id) {
      setAnomalies(prev => [data.anomaly, ...prev]);
    }
  };

  socket.on('new_anomaly', handleNewAnomaly);

  return () => {
    socket.off('new_anomaly', handleNewAnomaly);
    socket.disconnect();
  };
}, [id]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await api.post(`/api/anomalies/analyze/${id}`, {});
      setAnomalies(prev => [...res.data.anomalies, ...prev]);
      alert(`Analysis complete! Found ${res.data.anomalies.length} new anomalies.`);
    } catch (err) {
      alert('Analysis failed. Please try again.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  const filtered = filter === 'all' ? anomalies : anomalies.filter(a => a.severity === filter);

  const severityColor = (s) => {
    if (s === 'high') return '#ef4444';
    if (s === 'medium') return '#f59e0b';
    return '#3b82f6';
  };

  const severityBg = (s) => {
    if (s === 'high') return '#450a0a';
    if (s === 'medium') return '#451a03';
    return '#0c1a3a';
  };

  if (loading) return <div style={{color:'#94a3b8', padding:'40px'}}>Loading...</div>;

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
        <button style={styles.navBtn} onClick={() => navigate('/datasources')}>Data Sources</button>
      </div>

      {/* Content */}
      <div style={styles.content}>
        {/* Source Info */}
        <div style={styles.sourceInfo}>
          <div>
            <h2 style={styles.sourceName}>{source?.name}</h2>
            <p style={styles.sourceMeta}>{source?.rowCount} rows • {source?.columns?.length} columns • CSV</p>
          </div>
          <button style={styles.analyzeBtn} onClick={handleAnalyze} disabled={analyzing}>
            {analyzing ? '🔍 Analyzing...' : '🔍 Run Analysis'}
          </button>
        </div>

        {/* Stats */}
        <div style={styles.statsRow}>
          {['all', 'high', 'medium', 'low'].map(s => (
            <div
              key={s}
              style={{...styles.statCard, border: filter === s ? '1px solid #3b82f6' : '1px solid #334155', cursor: 'pointer'}}
              onClick={() => setFilter(s)}
            >
              <p style={{...styles.statNumber, color: s === 'all' ? '#f1f5f9' : severityColor(s)}}>
                {s === 'all' ? anomalies.length : anomalies.filter(a => a.severity === s).length}
              </p>
              <p style={styles.statLabel}>{s === 'all' ? 'Total' : s.charAt(0).toUpperCase() + s.slice(1)}</p>
            </div>
          ))}
        </div>

        {/* Anomalies List + Detail */}
        <div style={styles.mainGrid}>
          {/* List */}
          <div style={styles.list}>
            <h3 style={styles.listTitle}>
              {filter === 'all' ? 'All Anomalies' : `${filter.charAt(0).toUpperCase() + filter.slice(1)} Severity`}
              <span style={styles.listCount}>{filtered.length}</span>
            </h3>
            {filtered.length === 0 ? (
              <p style={styles.empty}>No anomalies found. Run analysis to detect anomalies.</p>
            ) : (
              filtered.map((anomaly) => (
                <div
                  key={anomaly._id}
                  style={{...styles.anomalyCard, border: selected?._id === anomaly._id ? '1px solid #3b82f6' : '1px solid #334155'}}
                  onClick={() => setSelected(anomaly)}
                >
                  <div style={styles.anomalyTop}>
                    <span style={{...styles.severityBadge, backgroundColor: severityBg(anomaly.severity), color: severityColor(anomaly.severity)}}>
                      {anomaly.severity.toUpperCase()}
                    </span>
                    <span style={styles.anomalyMethod}>{anomaly.method.toUpperCase()}</span>
                  </div>
                  <p style={styles.anomalyColumn}>{anomaly.column}</p>
                  <p style={styles.anomalyValue}>Value: <strong style={{color: severityColor(anomaly.severity)}}>{Number(anomaly.value).toLocaleString()}</strong></p>
                  <p style={styles.anomalyRange}>Expected: {Number(anomaly.expectedMin).toLocaleString()} – {Number(anomaly.expectedMax).toLocaleString()}</p>
                </div>
              ))
            )}
          </div>

          {/* Detail Panel */}
          <div style={styles.detail}>
            {selected ? (
              <>
                <h3 style={styles.detailTitle}>Anomaly Detail</h3>
                <div style={{...styles.detailSeverity, backgroundColor: severityBg(selected.severity), borderColor: severityColor(selected.severity)}}>
                  <span style={{color: severityColor(selected.severity), fontWeight: 'bold', fontSize: '18px'}}>
                    {selected.severity.toUpperCase()} SEVERITY
                  </span>
                </div>
                <div style={styles.detailSection}>
                  <p style={styles.detailLabel}>Column</p>
                  <p style={styles.detailValue}>{selected.column}</p>
                </div>
                <div style={styles.detailSection}>
                  <p style={styles.detailLabel}>Anomalous Value</p>
                  <p style={{...styles.detailValue, color: severityColor(selected.severity), fontSize: '24px'}}>
                    {Number(selected.value).toLocaleString()}
                  </p>
                </div>
                <div style={styles.detailSection}>
                  <p style={styles.detailLabel}>Expected Range</p>
                  <p style={styles.detailValue}>{Number(selected.expectedMin).toLocaleString()} – {Number(selected.expectedMax).toLocaleString()}</p>
                </div>
                <div style={styles.detailSection}>
                  <p style={styles.detailLabel}>Z-Score</p>
                  <p style={styles.detailValue}>{selected.zScore?.toFixed(2)}</p>
                </div>
                <div style={styles.detailSection}>
                  <p style={styles.detailLabel}>Detection Method</p>
                  <p style={styles.detailValue}>{selected.method === 'zscore' ? 'Z-Score (Rolling Window)' : 'IQR (Interquartile Range)'}</p>
                </div>
                <div style={styles.detailSection}>
                  <p style={styles.detailLabel}>🤖 AI Explanation</p>
                  <p style={styles.detailExplanation}>{selected.explanation}</p>
                </div>
                <div style={styles.detailSection}>
                  <p style={styles.detailLabel}>💡 Suggestion</p>
                  <p style={styles.detailExplanation}>{selected.suggestion}</p>
                </div>
              </>
            ) : (
              <div style={styles.detailEmpty}>
                <p style={styles.detailEmptyText}>👆 Click an anomaly to see details</p>
              </div>
            )}
          </div>
        </div>
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
  content: { padding: '40px' },
  sourceInfo: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' },
  sourceName: { color: '#f1f5f9', margin: '0 0 4px 0', fontSize: '24px' },
  sourceMeta: { color: '#94a3b8', margin: 0 },
  analyzeBtn: { padding: '12px 24px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '16px' },
  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' },
  statCard: { backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', textAlign: 'center' },
  statNumber: { fontSize: '32px', fontWeight: 'bold', margin: '0 0 4px 0' },
  statLabel: { color: '#94a3b8', margin: 0, fontSize: '14px' },
  mainGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' },
  list: { backgroundColor: '#1e293b', borderRadius: '12px', padding: '24px', maxHeight: '600px', overflowY: 'auto' },
  listTitle: { color: '#f1f5f9', marginTop: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  listCount: { backgroundColor: '#0f172a', color: '#94a3b8', padding: '2px 10px', borderRadius: '12px', fontSize: '14px' },
  anomalyCard: { backgroundColor: '#0f172a', padding: '16px', borderRadius: '8px', marginBottom: '12px', cursor: 'pointer' },
  anomalyTop: { display: 'flex', justifyContent: 'space-between', marginBottom: '8px' },
  severityBadge: { padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' },
  anomalyMethod: { color: '#64748b', fontSize: '12px' },
  anomalyColumn: { color: '#f1f5f9', fontWeight: 'bold', margin: '0 0 4px 0' },
  anomalyValue: { color: '#94a3b8', fontSize: '14px', margin: '0 0 2px 0' },
  anomalyRange: { color: '#64748b', fontSize: '12px', margin: 0 },
  empty: { color: '#94a3b8', textAlign: 'center', padding: '40px 0' },
  detail: { backgroundColor: '#1e293b', borderRadius: '12px', padding: '24px' },
  detailTitle: { color: '#f1f5f9', marginTop: 0 },
  detailSeverity: { padding: '16px', borderRadius: '8px', border: '1px solid', marginBottom: '20px', textAlign: 'center' },
  detailSection: { marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid #1e293b' },
  detailLabel: { color: '#64748b', fontSize: '12px', margin: '0 0 4px 0', textTransform: 'uppercase', letterSpacing: '0.05em' },
  detailValue: { color: '#f1f5f9', margin: 0, fontSize: '16px', fontWeight: 'bold' },
  detailExplanation: { color: '#94a3b8', margin: 0, lineHeight: '1.6' },
  detailEmpty: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '300px' },
  detailEmptyText: { color: '#334155', fontSize: '18px' }
};

export default AnomalyDetail;