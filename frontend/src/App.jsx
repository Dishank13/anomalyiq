import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import DataSources from './pages/DataSources';
import AnomalyDetail from './pages/AnomalyDetail';
import { ToastHost } from './components/ui';
import api from './services/api';
import { sessionExpired, sessionRestored } from './store/slices/authSlice';

function PrivateRoute({ children }) {
  const { token } = useSelector((state) => state.auth);
  return token ? children : <Navigate to="/login" />;
}

/**
 * Re-hydrate the session on a cold load.
 *
 * Only the token survives a refresh, so without this the app knew it was
 * authenticated but not who as -- and a token revoked or expired server-side
 * stayed "signed in" until the first API call failed.
 */
function SessionLoader() {
  const dispatch = useDispatch();
  const { token, user } = useSelector((state) => state.auth);

  useEffect(() => {
    if (!token || user) return;
    let cancelled = false;
    api.get('/api/auth/me')
      .then((res) => { if (!cancelled) dispatch(sessionRestored(res.data)); })
      .catch((err) => {
        if (!cancelled && err.response?.status === 401) dispatch(sessionExpired());
      });
    return () => { cancelled = true; };
  }, [token, user, dispatch]);

  return null;
}

function App() {
  return (
    <BrowserRouter>
      <ToastHost>
      <SessionLoader />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        } />
        <Route path="/datasources" element={
          <PrivateRoute>
            <DataSources />
          </PrivateRoute>
        } />
        <Route path="/datasources/:id" element={
          <PrivateRoute>
            <AnomalyDetail />
          </PrivateRoute>
        } />
        <Route path="/" element={<Navigate to="/login" />} />
      </Routes>
      </ToastHost>
    </BrowserRouter>
  );
}

export default App;