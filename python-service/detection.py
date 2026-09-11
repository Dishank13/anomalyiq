# -*- coding: utf-8 -*-
"""Statistical anomaly detection.

Pure functions over pandas objects: no FastAPI, no HTTP, no I/O. That is what
lets bench/ exercise the detectors directly and measure them against labelled
data, which is the only way to claim one method is better than another.

Four detectors, each covering a failure mode the others miss:

  zscore            rolling deviation from a local mean -- time-series drift
  iqr               quartile fences -- global outliers, no distribution assumed
  stl               seasonal decomposition residual -- "normal, but not for a
                    Tuesday", invisible to both of the above
  isolation_forest  multivariate -- anomalies that exist only in the
                    combination of columns, which no univariate method can see
"""
import math

import numpy as np
import pandas as pd

# ── Defaults. Every detector takes these as keyword arguments so the benchmark
# can sweep them rather than hardcoding one operating point.
DEFAULT_ZSCORE_THRESHOLD = 3.0
DEFAULT_WINDOW = 30
DEFAULT_MIN_PERIODS = 5
DEFAULT_IQR_MULTIPLIER = 1.5
DEFAULT_STL_PERIOD = 7

# Not 3.0. STL residuals are scaled by MAD, which measures the tight core of a
# robustly-fitted residual distribution and runs far narrower than a plain
# standard deviation -- so these z-scores are not on the familiar 3-sigma
# scale. At 3.0 the detector flagged 39 ordinary noise points per clean series.
# Tuned on bench/: 8.0 gives F1 0.97 on seasonal anomalies with zero false
# positives on clean data.
DEFAULT_STL_THRESHOLD = 8.0

# Isolation Forest ranks the planted anomalies correctly but a contamination
# budget that only just covers them loses to the natural tail of the
# distribution, which outranks them. Tuned on bench/: 0.03 lifts recall from
# 0.12 to 1.00 and F1 from 0.14 to 0.70.
DEFAULT_IF_CONTAMINATION = 0.03

MIN_POINTS = 10          # below this there is no distribution worth testing

ALL_METHODS = ("zscore", "iqr", "stl", "isolation_forest")
UNIVARIATE_METHODS = ("zscore", "iqr", "stl")


def available_methods() -> dict:
    """Which detectors can actually run in this deployment.

    stl and isolation_forest depend on statsmodels and scikit-learn, which are
    lazily imported so they stay off the cold-start path. That laziness must
    not become a silent failure: if a dependency is missing the detector
    returns nothing, and without this the UI would keep offering a method that
    quietly does nothing -- the same trap the retired Gemini model fell into.
    """
    def importable(module, attr):
        # Probe the exact symbol the detector uses, not the top-level package.
        # `import sklearn` can succeed while `from sklearn.ensemble import
        # IsolationForest` fails on a broken or partial install -- reporting
        # the method as available in that case is worse than useless.
        try:
            mod = __import__(module, fromlist=[attr])
            return hasattr(mod, attr)
        except Exception:
            return False

    return {
        "zscore": True,
        "iqr": True,
        "stl": importable("statsmodels.tsa.seasonal", "STL"),
        "isolation_forest": importable("sklearn.ensemble", "IsolationForest"),
    }


def get_severity(z_score: float) -> str:
    z = abs(z_score)
    if z > 5:
        return "high"
    if z > 3.5:
        return "medium"
    return "low"


def _finite(*values) -> bool:
    for v in values:
        if not isinstance(v, (int, float, np.integer, np.floating)):
            return False
        if not math.isfinite(float(v)):
            return False
    return True


def _record(column, series, pos, value, expected_min, expected_max, z_score, method):
    """Build one anomaly record, or None if any field is non-finite.

    row_index is the label in the source data; position is the offset within
    the series, which callers use to pull the preceding values for context.
    """
    if not _finite(value, expected_min, expected_max, z_score):
        return None
    return {
        "column": column,
        "row_index": int(series.index[pos]),
        "position": int(pos),
        "timestamp": str(series.index[pos]),
        "value": float(value),
        "expected_min": float(expected_min),
        "expected_max": float(expected_max),
        "z_score": float(z_score),
        "method": method,
        "severity": get_severity(z_score),
    }


# ──────────────────────────────────────────────────────────────── Z-score ────
def detect_zscore(series: pd.Series, column: str, *,
                  threshold: float = DEFAULT_ZSCORE_THRESHOLD,
                  window: int = DEFAULT_WINDOW,
                  min_periods: int = DEFAULT_MIN_PERIODS,
                  causal: bool = True) -> list:
    """Flag points that deviate from a rolling local mean.

    `causal` controls whether the point under test is allowed into its own
    reference window. It must not be: a large outlier included in its own mean
    and standard deviation inflates the sigma it is then measured against,
    suppressing its own z-score. That is textbook masking, and it is what the
    original implementation did -- series.rolling() without a shift. The
    benchmark quantifies the difference; the flag exists so it can.
    """
    if len(series) < MIN_POINTS:
        return []

    window = min(window, len(series))
    reference = series.shift(1) if causal else series

    rolling_mean = reference.rolling(window=window, min_periods=min_periods).mean()
    rolling_std = reference.rolling(window=window, min_periods=min_periods).std()

    # Vectorised: the original looped over every row in Python, which is the
    # dominant cost on large files.
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (series - rolling_mean) / rolling_std

    flagged = (rolling_std.notna() & (rolling_std > 0)
               & rolling_mean.notna() & z.abs().gt(threshold))

    anomalies = []
    for pos in np.flatnonzero(flagged.to_numpy()):
        mean, std = rolling_mean.iloc[pos], rolling_std.iloc[pos]
        rec = _record(column, series, pos, series.iloc[pos],
                      mean - threshold * std, mean + threshold * std,
                      z.iloc[pos], "zscore")
        if rec:
            anomalies.append(rec)
    return anomalies


# ──────────────────────────────────────────────────────────────────── IQR ────
def detect_iqr(series: pd.Series, column: str, *,
               multiplier: float = DEFAULT_IQR_MULTIPLIER) -> list:
    """Flag points outside the quartile fences.

    Non-parametric and resistant to extreme values, so it catches global
    outliers that a z-score with an inflated sigma would miss.
    """
    if len(series) < MIN_POINTS:
        return []

    q1, q3 = series.quantile(0.25), series.quantile(0.75)
    iqr = q3 - q1
    if pd.isna(iqr) or iqr == 0:
        return []

    lower, upper = q1 - multiplier * iqr, q3 + multiplier * iqr
    mean, std = series.mean(), series.std()
    flagged = (series < lower) | (series > upper)

    anomalies = []
    for pos in np.flatnonzero(flagged.to_numpy()):
        value = series.iloc[pos]
        z = (value - mean) / std if std and std > 0 else 0.0
        rec = _record(column, series, pos, value, lower, upper, z, "iqr")
        if rec:
            # IQR carries no rolling context, so severity comes from the
            # global z-score rather than get_severity's rolling assumption.
            rec["severity"] = "high" if abs(z) > 3.5 else "medium"
            anomalies.append(rec)
    return anomalies


# ──────────────────────────────────────────────────────────────────── STL ────
def detect_stl(series: pd.Series, column: str, *,
               period: int = DEFAULT_STL_PERIOD,
               threshold: float = DEFAULT_STL_THRESHOLD) -> list:
    """Flag points whose seasonal-decomposition residual is extreme.

    Z-score and IQR both judge a value against the recent level. Neither can
    see a value that is perfectly ordinary in absolute terms but wrong for its
    position in the cycle -- a weekday's traffic appearing on a Sunday. STL
    strips trend and seasonality first, so only the unexplained part is tested.
    """
    # statsmodels is heavy; importing it lazily keeps it off the cold-start
    # path for the detectors that do not need it.
    try:
        from statsmodels.tsa.seasonal import STL
    except Exception as e:
        # ImportError is the expected "optional dependency absent" case. A
        # broken install raises something else entirely, and silently
        # returning no anomalies would look exactly like a clean dataset.
        if not isinstance(e, ImportError):
            print("stl unavailable: %r" % e, flush=True)
        return []

    # STL needs at least two full cycles to separate season from trend.
    if len(series) < max(MIN_POINTS, 2 * period + 1) or period < 2:
        return []

    values = pd.Series(np.asarray(series, dtype=float))
    try:
        resid = pd.Series(STL(values, period=period, robust=True).fit().resid)
    except Exception as e:
        # Degenerate input (constant, too short for the chosen period).
        print("stl failed on %d points, period=%d: %r" % (len(values), period, e), flush=True)
        return []

    # A robust scale estimate, so one huge residual cannot hide the others the
    # way a plain standard deviation would.
    median = resid.median()
    mad = (resid - median).abs().median()
    scale = mad * 1.4826 if mad > 0 else resid.std()

    # Guard against floating-point dust, not just exact zero. A constant column
    # -- a status flag, a fixed unit price -- decomposes into residuals around
    # 1e-15. Those are not small enough to trip an `== 0` check, and dividing by
    # a MAD that size turns pure rounding error into z-scores in the thousands.
    # The threshold has to scale with the data, so compare against the series'
    # own magnitude rather than an absolute epsilon.
    magnitude = float(np.nanmax(np.abs(values.to_numpy()))) or 1.0
    if not math.isfinite(float(scale)) or float(scale) <= magnitude * 1e-9:
        return []

    z = (resid - median) / scale
    flagged = z.abs().gt(threshold)

    anomalies = []
    for pos in np.flatnonzero(flagged.to_numpy()):
        value = series.iloc[pos]
        # The expected range is the value minus its unexplained residual,
        # widened by the residual scale -- i.e. what the seasonal model
        # predicted for this position.
        predicted = float(value) - float(resid.iloc[pos])
        rec = _record(column, series, pos, value,
                      predicted - threshold * scale, predicted + threshold * scale,
                      z.iloc[pos], "stl")
        if rec:
            anomalies.append(rec)
    return anomalies


# ─────────────────────────────────────────────────────── Isolation Forest ────
def detect_isolation_forest(df: pd.DataFrame, columns: list, *,
                            contamination: float = DEFAULT_IF_CONTAMINATION,
                            random_state: int = 42) -> list:
    """Flag rows that are unusual across several columns at once.

    Every other detector here is univariate, so none of them can see a row
    whose individual values are all unremarkable but whose *combination* is:
    an order with a normal quantity and a normal unit price that together
    imply an impossible total. This one scores whole rows.

    Each flagged row is attributed to whichever of its columns deviates most,
    so the result still names a column and reads the same as the others.
    """
    try:
        from sklearn.ensemble import IsolationForest
    except Exception as e:
        if not isinstance(e, ImportError):
            print("isolation_forest unavailable: %r" % e, flush=True)
        return []

    usable = [c for c in columns if c in df.columns]
    if len(usable) < 2:
        return []               # multivariate needs more than one dimension

    frame = df[usable].replace([np.inf, -np.inf], np.nan).dropna()
    if len(frame) < MIN_POINTS:
        return []

    try:
        model = IsolationForest(contamination=contamination,
                                random_state=random_state, n_estimators=100)
        flags = model.fit_predict(frame.to_numpy())
    except Exception as e:
        print("isolation_forest failed on %d rows x %d cols: %r"
              % (len(frame), len(usable), e), flush=True)
        return []

    # Per-column z-scores, used only to decide which column to blame.
    means, stds = frame.mean(), frame.std(ddof=0).replace(0, np.nan)
    zs = ((frame - means) / stds).abs()

    anomalies = []
    for row_pos in np.flatnonzero(flags == -1):
        label = frame.index[row_pos]
        row_z = zs.iloc[row_pos]
        if row_z.isna().all():
            continue
        column = row_z.idxmax()
        series = frame[column]
        pos = frame.index.get_loc(label)
        signed_z = (frame[column].iloc[row_pos] - means[column]) / (stds[column] or 1.0)

        rec = _record(column, series, pos, frame[column].iloc[row_pos],
                      means[column] - 3 * (stds[column] or 0.0),
                      means[column] + 3 * (stds[column] or 0.0),
                      signed_z, "isolation_forest")
        if rec:
            anomalies.append(rec)
    return anomalies


# ───────────────────────────────────────────────────────────── Orchestration ──
def dedupe(anomalies: list) -> list:
    """Collapse detections of the same cell found by several methods.

    Methods are kept in ALL_METHODS order, so the first to flag a point wins
    and the rest are dropped rather than reported as separate findings.
    """
    seen, unique = set(), []
    for a in anomalies:
        key = (a["column"], a["row_index"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(a)
    return unique


def sort_by_significance(anomalies: list) -> list:
    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(anomalies,
                  key=lambda a: (order.get(a["severity"], 3), -abs(a["z_score"])))


def detect_all(df: pd.DataFrame, columns: list, *,
               methods: tuple = ("zscore", "iqr"),
               z_threshold: float = DEFAULT_ZSCORE_THRESHOLD,
               window: int = DEFAULT_WINDOW,
               stl_period: int = DEFAULT_STL_PERIOD,
               causal: bool = True) -> tuple:
    """Run the requested detectors over the requested columns.

    Returns (anomalies, series_by_column). The series are handed back so the
    caller can pull recent context for a column without re-deriving them.
    """
    chosen = [m for m in ALL_METHODS if m in methods]
    found, series_by_column = [], {}

    for column in columns:
        if column not in df.columns:
            continue
        series = df[column].replace([np.inf, -np.inf], np.nan).dropna()
        if series.empty:
            continue
        series_by_column[column] = series

        if "zscore" in chosen:
            found.extend(detect_zscore(series, column, threshold=z_threshold,
                                       window=window, causal=causal))
        if "iqr" in chosen:
            found.extend(detect_iqr(series, column))
        if "stl" in chosen:
            found.extend(detect_stl(series, column, period=stl_period))

    if "isolation_forest" in chosen:
        found.extend(detect_isolation_forest(df, columns))

    return sort_by_significance(dedupe(found)), series_by_column
