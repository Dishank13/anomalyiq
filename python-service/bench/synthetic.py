# -*- coding: utf-8 -*-
"""Synthetic series with known anomalies.

Every generator returns (series_or_frame, true_anomaly_positions). Because the
labels are known by construction, detectors can be scored rather than eyeballed
-- which is the whole point: "we use Z-score and IQR" is an implementation
note, "here is each detector's F1 across five anomaly regimes" is a result.

Each regime is chosen to be hard for a different detector, so no single method
can win everything.
"""
import numpy as np
import pandas as pd


def _rng(seed):
    return np.random.default_rng(seed)


def clean_series(n=500, *, noise=1.0, seed=0):
    """Control case: trend + noise, no anomalies. Measures false positives."""
    r = _rng(seed)
    trend = np.linspace(100, 140, n)
    return pd.Series(trend + r.normal(0, noise, n)), []


def point_spikes(n=500, *, noise=1.0, n_anomalies=8, magnitude=8.0, seed=1):
    """Isolated extreme values on a stable baseline.

    The easy case, and the one the original z-score implementation handled
    worst: a spike included in its own rolling window inflates the sigma it is
    measured against.
    """
    r = _rng(seed)
    values = 100 + r.normal(0, noise, n)
    # Keep spikes clear of the warm-up region where no rolling stats exist yet.
    positions = sorted(r.choice(np.arange(40, n - 5), size=n_anomalies, replace=False))
    for p in positions:
        values[p] += magnitude * noise * r.choice([-1, 1])
    return pd.Series(values), list(positions)


def level_shift(n=500, *, noise=1.0, shift_at=300, magnitude=6.0, seed=2):
    """A step change in the baseline.

    Only the transition is anomalous; the new level afterwards is the new
    normal. A global method like IQR flags the entire tail, which is exactly
    the failure this regime is here to expose.
    """
    r = _rng(seed)
    values = 100 + r.normal(0, noise, n)
    values[shift_at:] += magnitude * noise
    # The shift is detectable for a few points until the rolling window adapts.
    return pd.Series(values), list(range(shift_at, shift_at + 3))


def seasonal_break(n=504, *, noise=0.5, period=7, n_anomalies=6, magnitude=5.0, seed=3):
    """A strong weekly cycle with a few points that break it.

    The anomalous values sit inside the series' overall range, so they are not
    outliers in any global sense -- z-score and IQR are close to blind here.
    STL removes the cycle first and sees them plainly.
    """
    r = _rng(seed)
    t = np.arange(n)
    seasonal = 10 * np.sin(2 * np.pi * t / period)
    values = 100 + seasonal + r.normal(0, noise, n)

    positions = sorted(r.choice(np.arange(2 * period, n - period), size=n_anomalies, replace=False))
    for p in positions:
        # Replace with a value valid elsewhere in the cycle but wrong here:
        # anomalous in phase, unremarkable in magnitude.
        values[p] = 100 - seasonal[p] + magnitude * noise * r.choice([-1, 1])
    return pd.Series(values), list(positions)


def variance_change(n=500, *, noise=1.0, change_at=250, factor=5.0, seed=4):
    """Volatility increases partway through; the mean does not move.

    Nothing is an outlier against the full-series spread, so this mostly
    measures how badly each detector floods the second half with findings.
    """
    r = _rng(seed)
    first = r.normal(100, noise, change_at)
    second = r.normal(100, noise * factor, n - change_at)
    values = np.concatenate([first, second])
    # The genuinely extreme points in the high-variance half.
    tail_z = np.abs(second - 100) / (noise * factor)
    positions = [change_at + int(i) for i in np.flatnonzero(tail_z > 2.5)]
    return pd.Series(values), positions


def multivariate_frame(n=500, *, noise=1.0, n_anomalies=8, seed=5):
    """Two correlated columns plus rows that break the relationship.

    quantity and unit_price are each perfectly ordinary in isolation; the
    anomalous rows pair a high quantity with a high price, a combination that
    never occurs normally. No univariate detector can see this.
    """
    r = _rng(seed)
    quantity = r.normal(50, 10, n)
    # Price normally moves inversely with quantity (bulk discount).
    unit_price = 200 - 1.5 * quantity + r.normal(0, noise, n)

    positions = sorted(r.choice(np.arange(10, n - 5), size=n_anomalies, replace=False))
    for p in positions:
        quantity[p] = 70          # high but not extreme on its own
        unit_price[p] = 160       # also within range on its own
    return pd.DataFrame({"quantity": quantity, "unit_price": unit_price}), list(positions)


# name -> (generator, is_multivariate)
UNIVARIATE_REGIMES = {
    "clean (control)": clean_series,
    "point spikes": point_spikes,
    "level shift": level_shift,
    "seasonal break": seasonal_break,
    "variance change": variance_change,
}

MULTIVARIATE_REGIMES = {
    "multivariate": multivariate_frame,
}
