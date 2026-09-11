import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  user: null,
  token: localStorage.getItem('token') || null,
  isAuthenticated: false,
  loading: false,
  error: null
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    loginStart: (state) => {
      state.loading = true;
      state.error = null;
    },
    loginSuccess: (state, action) => {
      state.loading = false;
      state.isAuthenticated = true;
      state.user = action.payload.user;
      state.token = action.payload.token;
      localStorage.setItem('token', action.payload.token);
    },
    loginFailure: (state, action) => {
      state.loading = false;
      state.error = action.payload;
    },
    // Restores the signed-in user after a page refresh. Only the token was
    // persisted, so `user` came back null and the interface had no name to
    // show -- even though the session was perfectly valid.
    sessionRestored: (state, action) => {
      state.user = action.payload;
      state.isAuthenticated = true;
    },
    sessionExpired: (state) => {
      state.user = null;
      state.token = null;
      state.isAuthenticated = false;
      localStorage.removeItem('token');
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.isAuthenticated = false;
      localStorage.removeItem('token');
    }
  }
});

export const {
  loginStart, loginSuccess, loginFailure, logout, sessionRestored, sessionExpired
} = authSlice.actions;
export default authSlice.reducer;