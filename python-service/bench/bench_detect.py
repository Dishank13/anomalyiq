# -*- coding: utf-8 -*-
"""Measure the vectorised z-score against the original row-by-row loop.

    python -m bench.bench_detect          (from python-service/)

The original implementation is reproduced verbatim below rather than described,
so the comparison is against what actually shipped -- and so the claim in the
README is reproducible by anyone who clones the repo.
"""
import os
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import detection  # noqa: E402

SIZES = (10_000, 100_000, 1_000_000)
REPEATS = 3


def detect_zscore_original(series: pd.Series, column: str) -> list:
    """The shipped implementation, before Phase 2. Kept for comparison only.

    Note it is also non-causal -- the window includes the point under test --
    which is the masking bug the benchmark quantifies separately.
    """
    anomalies = []
    if len(series) < 10:
        return anomalies

    window = min(30, len(series))
    rolling_mean = series.rolling(window=window, min_periods=5).mean()
    rolling_std = series.rolling(window=window, min_periods=5).std()

    for i in range(len(series)):
        mean = rolling_mean.iloc[i]
        std = rolling_std.iloc[i]
        if pd.isna(std) or pd.isna(mean) or std == 0:
            continue
        value = series.iloc[i]
        z_score = (value - mean) / std
        if abs(z_score) <= 3:
            continue
        expected_min = mean - 3 * std
        expected_max = mean + 3 * std
        anomalies.append({
            "column": column,
            "row_index": int(series.index[i]),
            "value": float(value),
            "expected_min": float(expected_min),
            "expected_max": float(expected_max),
            "z_score": float(z_score),
            "method": "zscore",
        })
    return anomalies


def make_series(n, seed=0):
    r = np.random.default_rng(seed)
    values = 100 + np.linspace(0, 20, n) + r.normal(0, 1, n)
    # ~0.3% planted spikes, so both paths do comparable record-building work.
    idx = r.choice(np.arange(40, n), size=max(1, n // 300), replace=False)
    values[idx] += r.normal(0, 1, len(idx)) * 15 + 25
    return pd.Series(values)


def timed(fn, *args):
    best = float("inf")
    result = None
    for _ in range(REPEATS):
        t0 = time.perf_counter()
        result = fn(*args)
        best = min(best, time.perf_counter() - t0)
    return best, result


def main():
    print("Vectorised z-score vs the original row-by-row loop")
    print("(best of %d runs; both paths build the same records)\n" % REPEATS)
    print("%12s | %12s | %12s | %8s | %s" %
          ("rows", "original", "vectorised", "speedup", "found (orig/new)"))
    print("-" * 74)

    rows = []
    for n in SIZES:
        series = make_series(n)
        t_old, old = timed(detect_zscore_original, series, "v")
        # causal=False so the comparison isolates the vectorisation, not the
        # separate rolling-window fix.
        t_new, new = timed(lambda s, c: detection.detect_zscore(s, c, causal=False), series, "v")
        speedup = t_old / t_new if t_new else float("inf")
        rows.append((n, t_old, t_new, speedup))
        print("%12s | %10.3f s | %10.3f s | %7.1fx | %d / %d" %
              ("{:,}".format(n), t_old, t_new, speedup, len(old), len(new)))

    print("\nEquivalence check (same input, same flagged rows):")
    series = make_series(50_000, seed=7)
    old = {a["row_index"] for a in detect_zscore_original(series, "v")}
    new = {a["row_index"] for a in detection.detect_zscore(series, "v", causal=False)}
    print("  original flagged %d, vectorised flagged %d, identical: %s"
          % (len(old), len(new), old == new))

    best = max(r[3] for r in rows)
    print("\nPeak speedup: %.1fx at %s rows" %
          (best, "{:,}".format(next(r[0] for r in rows if r[3] == best))))


if __name__ == "__main__":
    main()
