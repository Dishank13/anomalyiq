import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import { loginFailure, loginStart, loginSuccess } from '../store/slices/authSlice';
import api from '../services/api';
import AuthLayout from './AuthLayout';

export default function Login() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { loading, error } = useSelector((state) => state.auth);
  const [form, setForm] = useState({ email: '', password: '' });

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    dispatch(loginStart());
    try {
      const res = await api.post('/api/auth/login', form);
      dispatch(loginSuccess(res.data));
      navigate('/dashboard');
    } catch (err) {
      dispatch(loginFailure(err.response?.data?.message || 'Could not sign you in.'));
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Pick up where you left off."
      footer={
        <>
          No account?{' '}
          <Link to="/register" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="eyebrow">Email</span>
          <input
            className="field mt-1.5" type="email" name="email" autoComplete="email"
            value={form.email} onChange={change} placeholder="you@example.com" required
          />
        </label>

        <label className="block">
          <span className="eyebrow">Password</span>
          <input
            className="field mt-1.5" type="password" name="password" autoComplete="current-password"
            value={form.password} onChange={change} placeholder="••••••••" required
          />
        </label>

        {error && (
          <p role="alert" className="rounded border border-high/30 bg-high/[0.06] px-3 py-2 text-sm text-high">
            {error}
          </p>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}
