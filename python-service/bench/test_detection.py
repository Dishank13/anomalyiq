# -*- coding: utf-8 -*-
"""Regression guard on the detection maths.

    pytest bench/            (from python-service/)

These are not illustrative examples -- they are the floor the benchmark
established. If a change to detection.py drops a detector below the F1 it
reached here, or reintroduces the rolling-window masking bug, these fail.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import detection  # noqa: E402
from bench import synthetic  # noqa: E402
from bench.evaluate import mean_over_noise, run_univariate, run_multivariate, score  # noqa: E402


# ── Each detector must still win the regime it exists for ────────────────────
@pytest.mark.parametrize("method,regime,floor", [
    ("zscore", "point spikes", 0.70),
    ("zscore", "level shift", 0.45),      # the only method that works here
    ("stl", "seasonal break", 0.90),      # STL's whole reason for existing
    ("stl", "point spikes", 0.85),
    ("iqr", "point spikes", 0.60),
])
def test_detector_meets_benchmark_floor(method, regime, floor):
    got = mean_over_noise(run_univariate, method, synthetic.UNIVARIATE_REGIMES[regime])
    assert got["f1"] >= floor, "%s on %s: F1 %.2f < %.2f" % (method, regime, got["f1"], floor)


def test_stl_sees_seasonal_anomalies_that_zscore_cannot():
    """The claim that justifies shipping STL at all."""
    gen = synthetic.UNIVARIATE_REGIMES["seasonal break"]
    stl = mean_over_noise(run_univariate, "stl", gen)["f1"]
    zscore = mean_over_noise(run_univariate, "zscore", gen)["f1"]
    assert stl > 0.85 and zscore < 0.2, "stl=%.2f zscore=%.2f" % (stl, zscore)


def test_isolation_forest_beats_every_univariate_method_on_multivariate_data():
    """The claim that justifies shipping Isolation Forest."""
    gen = synthetic.MULTIVARIATE_REGIMES["multivariate"]
    forest = mean_over_noise(run_multivariate, "isolation_forest", gen)["f1"]
    best_uni = max(mean_over_noise(run_multivariate, m, gen)["f1"]
                   for m in ("zscore", "iqr", "stl"))
    assert forest > 0.5, "isolation_forest F1 %.2f" % forest
    assert forest > best_uni * 2, "forest=%.2f best univariate=%.2f" % (forest, best_uni)


# ── The masking bug must not come back ───────────────────────────────────────
def test_rolling_window_is_causal():
    """A point must not appear in its own reference window.

    Constructed so the difference is unambiguous: a flat series with one huge
    spike. Included in its own window, the spike inflates the sigma it is
    measured against and its z-score collapses.
    """
    values = np.full(200, 100.0)
    values[150] = 100.0 + 50.0          # a 50-unit spike on a flat line
    values[:150] += np.random.default_rng(0).normal(0, 1, 150)
    values[151:] += np.random.default_rng(1).normal(0, 1, 49)
    series = pd.Series(values)

    causal = detection.detect_zscore(series, "v", causal=True)
    leaky = detection.detect_zscore(series, "v", causal=False)

    z_causal = next((abs(a["z_score"]) for a in causal if a["position"] == 150), 0)
    z_leaky = next((abs(a["z_score"]) for a in leaky if a["position"] == 150), 0)

    assert z_causal > z_leaky, "causal z=%.1f should exceed leaky z=%.1f" % (z_causal, z_leaky)
    # The masking is severe, not marginal.
    assert z_causal > z_leaky * 2


def test_causal_window_never_reads_the_future():
    """Truncating the series must not change verdicts on earlier points."""
    series, _ = synthetic.point_spikes(n=300, seed=11)
    full = {a["position"] for a in detection.detect_zscore(series, "v")}
    prefix = {a["position"] for a in detection.detect_zscore(series.iloc[:200], "v")}
    # Everything found in the prefix must also be found in the full series.
    assert prefix <= full, "future data changed a past verdict: %s" % sorted(prefix - full)


# ── Output contract ──────────────────────────────────────────────────────────
REQUIRED_FIELDS = {"column", "row_index", "position", "timestamp", "value",
                   "expected_min", "expected_max", "z_score", "method", "severity"}


@pytest.mark.parametrize("method", ["zscore", "iqr", "stl"])
def test_record_shape_is_uniform_across_detectors(method):
    series, _ = synthetic.point_spikes(noise=1.0)
    found = {"zscore": detection.detect_zscore,
             "iqr": detection.detect_iqr,
             "stl": detection.detect_stl}[method](series, "v")
    assert found, "%s found nothing on point spikes" % method
    for a in found:
        assert REQUIRED_FIELDS <= set(a), "missing %s" % (REQUIRED_FIELDS - set(a))
        assert a["severity"] in ("low", "medium", "high")
        assert a["method"] == method
        # Anything non-finite breaks JSON serialisation at the API boundary.
        for k in ("value", "expected_min", "expected_max", "z_score"):
            assert np.isfinite(a[k]), "%s.%s is not finite" % (method, k)


def test_detectors_are_quiet_on_constant_and_tiny_input():
    """Degenerate input must return nothing, not divide by zero."""
    for series in (pd.Series([5.0] * 100),          # zero variance
                   pd.Series([1.0, 2.0, 3.0]),      # below MIN_POINTS
                   pd.Series([], dtype=float)):
        for fn in (detection.detect_zscore, detection.detect_iqr, detection.detect_stl):
            assert fn(series, "v") == []


def test_dedupe_keeps_one_finding_per_cell():
    series, _ = synthetic.point_spikes(noise=1.0)
    found, _ = detection.detect_all(series.to_frame("v"), ["v"], methods=("zscore", "iqr", "stl"))
    keys = [(a["column"], a["row_index"]) for a in found]
    assert len(keys) == len(set(keys)), "the same cell was reported more than once"


def test_results_are_sorted_most_significant_first():
    series, _ = synthetic.point_spikes(noise=1.0)
    found, _ = detection.detect_all(series.to_frame("v"), ["v"], methods=("zscore", "iqr"))
    rank = {"high": 0, "medium": 1, "low": 2}
    keys = [(rank[a["severity"]], -abs(a["z_score"])) for a in found]
    assert keys == sorted(keys)


def test_method_selection_is_honoured():
    series, _ = synthetic.point_spikes(noise=1.0)
    found, _ = detection.detect_all(series.to_frame("v"), ["v"], methods=("iqr",))
    assert found and {a["method"] for a in found} == {"iqr"}
