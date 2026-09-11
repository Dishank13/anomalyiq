import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import { loginFailure, loginStart, loginSuccess } from '../store/slices/authSlice';
import api from '../services/api';
import AuthLayout from './AuthLayout';

export default function Register() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { loading, error } = useSelector((state) => state.auth);
  const [form, setForm] = useState({ name: '', email: '', password: '' });

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    dispatch(loginStart());
    try {
      const res = await api.post('/api/auth/register', form);
      dispatch(loginSuccess(res.data));
      navigate('/dashboard');
    } catch (err) {
      // The API returns per-field validation messages; show them rather than
      // a generic failure.
      const data = err.response?.data;
      const detail = data?.errors?.map((e2) => e2.message).join(' · ');
      dispatch(loginFailure(detail || data?.message || 'Could not create your account.'));
    }
  };

  return (
    <AuthLayout
      title="Create an account"
      subtitle="Upload a spreadsheet and see what does not belong in it."
      footer={
        <>
          Already have one?{' '}
          <Link to="/login" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="eyebrow">Name</span>
          <input
            className="field mt-1.5" name="name" autoComplete="name"
            value={form.name} onChange={change} placeholder="Dishank Shah" required
          />
        </label>

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
            className="field mt-1.5" type="password" name="password" autoComplete="new-password"
            value={form.password} onChange={change} placeholder="At least 6 characters"
            minLength={6} required
          />
          <span className="mt-1 block font-mono text-[11px] text-faint">6 characters minimum</span>
        </label>

        {error && (
          <p role="alert" className="rounded border border-high/30 bg-high/[0.06] px-3 py-2 text-sm text-high">
            {error}
          </p>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
