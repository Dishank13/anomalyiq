# Detection benchmark

Detectors scored against synthetic series whose anomaly positions are known
by construction, averaged over noise levels 0.5, 1.0, 2.0.
A detection counts as correct if it lands within 2 positions of a labelled
anomaly; each labelled anomaly can be matched only once.

Regenerate with `python -m bench.evaluate` from `python-service/`.

## F1 by regime and method

| Regime | zscore | iqr | stl | isolation_forest |
|---|---|---|---|---|
| point spikes | 0.76 | 0.67 | 0.94 | n/a |
| level shift | 0.50 | 0.00 | 0.00 | n/a |
| seasonal break | 0.00 | 0.00 | 0.97 | n/a |
| variance change | 0.29 | 0.10 | 0.20 | n/a |
| multivariate | 0.11 | 0.20 | 0.00 | 0.70 |

Each regime is built to defeat a different detector, so no column wins
everywhere. That is the argument for running several rather than one.

- **point spikes** - isolated extremes; the classic case.
- **level shift** - a step change, where only the transition is anomalous
  and the new level is the new normal. IQR flags the entire tail.
- **seasonal break** - values that are ordinary in magnitude but wrong for
  their position in the cycle. Invisible to z-score and IQR; STL's purpose.
- **variance change** - volatility rises, the mean does not move.
- **multivariate** - each column is unremarkable alone, only the
  combination is impossible. No univariate method can see it.

## False positives on clean data

No anomalies exist in this series, so every detection is wrong. F1 is not
a meaningful score here, which is why this is reported separately.

| Method | mean false positives per 500-point series |
|---|---|
| zscore | 6.3 |
| iqr | 0.0 |
| stl | 0.0 |

z-score's false positives are not random noise -- they come from the trend.
A causal rolling mean necessarily *lags* a rising series, and that systematic
offset is read as deviation. Removing the trend from the control series drops
it from ~6 to ~2 per series, which is the level the t-distribution predicts for
an estimated sigma over a 30-point window. STL scores 0 here precisely because
it removes trend and seasonality before testing anything -- another reason the
two detectors are complementary rather than redundant.

## The rolling-window fix, measured

The original z-score computed its rolling mean and standard deviation over
a window that **included the point being tested**. An extreme value inflates
the sigma it is then compared against and partially hides itself -- textbook
masking. Shifting the window by one makes it causal, using only prior points.

| Regime | leaky (original) | causal (fixed) | change |
|---|---|---|---|
| point spikes | 0.75 | 0.76 | +0.01 |
| level shift | 0.40 | 0.50 | +0.10 |
| seasonal break | 0.00 | 0.00 | +0.00 |
| variance change | 0.25 | 0.29 | +0.04 |
| **mean** | **0.35** | **0.39** | **+0.04** |

The causal window is also strictly more sensitive, so it costs some false
positives on clean data (6.3 vs 0.3 per series). That is the correct trade:
a detector that hides the anomalies it was built to find is not usefully quiet.

## Does combining detectors help?

| Regime | zscore only | zscore+iqr (shipped before) | all univariate |
|---|---|---|---|
| point spikes | 0.76 | 0.64 | 0.64 |
| level shift | 0.50 | 0.50 | 0.50 |
| seasonal break | 0.00 | 0.00 | 0.97 |
| variance change | 0.29 | 0.10 | 0.09 |
| **mean** | **0.39** | **0.31** | **0.55** |

Adding detectors raises recall and lowers precision. Which wins depends on
the regime, which is why methods are selectable per analysis rather than
fixed -- there is no single configuration that is best for all data.
