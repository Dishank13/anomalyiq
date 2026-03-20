import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { logout } from '../store/slices/authSlice';

function Dashboard() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { user } = useSelector((state) => state.auth);

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>AnomalyIQ</h1>
        <div style={styles.headerRight}>
          <span style={styles.userName}>{user?.name}</span>
          <button style={styles.logoutBtn} onClick={handleLogout}>Logout</button>
        </div>
      </div>
      <div style={styles.content}>
        <h2 style={styles.welcome}>Welcome, {user?.name || 'User'}! 👋</h2>
        <p style={styles.subtitle}>Your anomaly detection dashboard is ready.</p>
        <button style={styles.addBtn} onClick={() => navigate('/datasources')}>
          Manage Data Sources →
        </button>
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
  content: { padding: '60px 40px', textAlign: 'center' },
  welcome: { color: '#f1f5f9', fontSize: '32px' },
  subtitle: { color: '#94a3b8', fontSize: '18px' },
  addBtn: { marginTop: '24px', padding: '12px 24px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '16px' }
};

export default Dashboard;