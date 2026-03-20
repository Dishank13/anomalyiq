import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  sources: [],
  loading: false,
  error: null
};

const dataSlice = createSlice({
  name: 'data',
  initialState,
  reducers: {
    fetchSourcesStart: (state) => {
      state.loading = true;
      state.error = null;
    },
    fetchSourcesSuccess: (state, action) => {
      state.loading = false;
      state.sources = action.payload;
    },
    fetchSourcesFailure: (state, action) => {
      state.loading = false;
      state.error = action.payload;
    },
    addSource: (state, action) => {
      state.sources.push(action.payload);
    },
    removeSource: (state, action) => {
      state.sources = state.sources.filter(s => s._id !== action.payload);
    }
  }
});

export const { fetchSourcesStart, fetchSourcesSuccess, fetchSourcesFailure, addSource, removeSource } = dataSlice.actions;
export default dataSlice.reducer;