# -*- coding: utf-8 -*-
"""Score every detector against every synthetic regime.

Run directly to regenerate benchmark_results.md:

    python -m bench.evaluate          (from python-service/)

Metrics are computed here rather than pulled from sklearn so the benchmark
stays runnable without it, and so the matching rule is explicit: a detection
counts as a true positive if it lands within TOLERANCE positions of a labelled
anomaly, and each labelled anomaly can be matched only once -- a detector
cannot inflate recall by firing repeatedly around one event.

The clean control is scored separately. F1 is undefined in any useful sense
when there is nothing to find; what matters there is how many points a
detector invents, so it is reported as a false-positive count.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import detection  # noqa: E402
from bench import synthetic  # noqa: E402

TOLERANCE = 2
NOISE_LEVELS = (0.5, 1.0, 2.0)
METHODS = ["zscore", "iqr", "stl", "isolation_forest"]

# Regimes that contain real anomalies, so F1 means something.
ANOMALY_REGIMES = {k: v for k, v in synthetic.UNIVARIATE_REGIMES.items()
                   if k != "clean (control)"}


def score(predicted_positions, true_positions, tolerance=TOLERANCE):
    predicted = sorted(set(int(p) for p in predicted_positions))
    remaining = sorted(set(int(t) for t in true_positions))

    tp = 0
    for p in predicted:
        hit = next((t for t in remaining if abs(t - p) <= tolerance), None)
        if hit is not None:
            remaining.remove(hit)
            tp += 1

    fp, fn = len(predicted) - tp, len(remaining)
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"precision": precision, "recall": recall, "f1": f1,
            "tp": tp, "fp": fp, "fn": fn, "n_predicted": len(predicted)}


def detect_univariate(method, series, column="v", *, causal=True):
    if method == "zscore":
        return detection.detect_zscore(series, column, causal=causal)
    if method == "iqr":
        return detection.detect_iqr(series, column)
    if method == "stl":
        return detection.detect_stl(series, column)
    return []


def run_univariate(method, generator, noise, *, causal=True):
    series, truth = generator(noise=noise)
    found = detect_univariate(method, series, causal=causal)
    return score([a["position"] for a in found], truth)


def run_multivariate(method, generator, noise):
    frame, truth = generator(noise=noise)
    columns = list(frame.columns)
    if method == "isolation_forest":
        found = detection.detect_isolation_forest(frame, columns)
    else:
        # Univariate methods get the union of their per-column findings, the
        # fairest comparison available on multivariate data.
        found = []
        for c in columns:
            found += detect_univariate(method, frame[c], c)
    return score([a["position"] for a in found], truth)


def mean_over_noise(fn, *args, **kwargs):
    runs = [fn(*args, noise=n, **kwargs) for n in NOISE_LEVELS]
    return {k: sum(r[k] for r in runs) / len(runs)
            for k in ("precision", "recall", "f1")}


def false_positives(method, *, causal=True):
    """Mean detections per clean series -- every one of them is wrong."""
    counts = []
    for noise in NOISE_LEVELS:
        series, _ = synthetic.clean_series(noise=noise)
        counts.append(len(detect_univariate(method, series, causal=causal)))
    return sum(counts) / len(counts)


def build_f1_table():
    table = {}
    for regime, generator in ANOMALY_REGIMES.items():
        table[regime] = {m: (None if m == "isolation_forest"
                             else mean_over_noise(run_univariate, m, generator))
                         for m in METHODS}
    for regime, generator in synthetic.MULTIVARIATE_REGIMES.items():
        table[regime] = {m: mean_over_noise(run_multivariate, m, generator)
                         for m in METHODS}
    return table


def causal_comparison():
    out = {}
    for regime, generator in ANOMALY_REGIMES.items():
        out[regime] = {
            "causal": mean_over_noise(run_univariate, "zscore", generator, causal=True),
            "leaky": mean_over_noise(run_univariate, "zscore", generator, causal=False),
        }
    return out


ENSEMBLES = (
    ("zscore only", ("zscore",)),
    ("zscore+iqr (shipped before)", ("zscore", "iqr")),
    ("all univariate", ("zscore", "iqr", "stl")),
)


def ensemble_comparison():
    out = {}
    for regime, generator in ANOMALY_REGIMES.items():
        rows = {}
        for label, methods in ENSEMBLES:
            runs = []
            for noise in NOISE_LEVELS:
                series, truth = generator(noise=noise)
                found, _ = detection.detect_all(series.to_frame("v"), ["v"], methods=methods)
                runs.append(score([a["position"] for a in found], truth))
            rows[label] = {k: sum(r[k] for r in runs) / len(runs)
                           for k in ("precision", "recall", "f1")}
        out[regime] = rows
    return out


def cell(c, key="f1"):
    return "n/a" if c is None else "%.2f" % c[key]


def render_markdown():
    table = build_f1_table()
    L = [
        "# Detection benchmark",
        "",
        "Detectors scored against synthetic series whose anomaly positions are known",
        "by construction, averaged over noise levels %s."
        % ", ".join(str(n) for n in NOISE_LEVELS),
        "A detection counts as correct if it lands within %d positions of a labelled" % TOLERANCE,
        "anomaly; each labelled anomaly can be matched only once.",
        "",
        "Regenerate with `python -m bench.evaluate` from `python-service/`.",
        "",
        "## F1 by regime and method",
        "",
        "| Regime | " + " | ".join(METHODS) + " |",
        "|---|" + "---|" * len(METHODS),
    ]
    for regime, row in table.items():
        L.append("| %s | %s |" % (regime, " | ".join(cell(row[m]) for m in METHODS)))

    L += ["", "Each regime is built to defeat a different detector, so no column wins",
          "everywhere. That is the argument for running several rather than one.", "",
          "- **point spikes** - isolated extremes; the classic case.",
          "- **level shift** - a step change, where only the transition is anomalous",
          "  and the new level is the new normal. IQR flags the entire tail.",
          "- **seasonal break** - values that are ordinary in magnitude but wrong for",
          "  their position in the cycle. Invisible to z-score and IQR; STL's purpose.",
          "- **variance change** - volatility rises, the mean does not move.",
          "- **multivariate** - each column is unremarkable alone, only the",
          "  combination is impossible. No univariate method can see it.", ""]

    # ── false positives on clean data
    L += ["## False positives on clean data", "",
          "No anomalies exist in this series, so every detection is wrong. F1 is not",
          "a meaningful score here, which is why this is reported separately.", "",
          "| Method | mean false positives per 500-point series |", "|---|---|"]
    for m in ("zscore", "iqr", "stl"):
        L.append("| %s | %.1f |" % (m, false_positives(m)))
    L += ["",
          "z-score's false positives are not random noise -- they come from the trend.",
          "A causal rolling mean necessarily *lags* a rising series, and that systematic",
          "offset is read as deviation. Removing the trend from the control series drops",
          "it from ~6 to ~2 per series, which is the level the t-distribution predicts for",
          "an estimated sigma over a 30-point window. STL scores 0 here precisely because",
          "it removes trend and seasonality before testing anything -- another reason the",
          "two detectors are complementary rather than redundant."]

    # ── causal window
    L += ["", "## The rolling-window fix, measured", "",
          "The original z-score computed its rolling mean and standard deviation over",
          "a window that **included the point being tested**. An extreme value inflates",
          "the sigma it is then compared against and partially hides itself -- textbook",
          "masking. Shifting the window by one makes it causal, using only prior points.", "",
          "| Regime | leaky (original) | causal (fixed) | change |", "|---|---|---|---|"]
    causal = causal_comparison()
    for regime, row in causal.items():
        leaky, fixed = row["leaky"]["f1"], row["causal"]["f1"]
        L.append("| %s | %.2f | %.2f | %+.2f |" % (regime, leaky, fixed, fixed - leaky))
    mean_leaky = sum(r["leaky"]["f1"] for r in causal.values()) / len(causal)
    mean_fixed = sum(r["causal"]["f1"] for r in causal.values()) / len(causal)
    L.append("| **mean** | **%.2f** | **%.2f** | **%+.2f** |"
             % (mean_leaky, mean_fixed, mean_fixed - mean_leaky))
    L += ["", "The causal window is also strictly more sensitive, so it costs some false",
          "positives on clean data (%.1f vs %.1f per series). That is the correct trade:"
          % (false_positives("zscore", causal=True), false_positives("zscore", causal=False)),
          "a detector that hides the anomalies it was built to find is not usefully quiet.", ""]

    # ── ensemble
    L += ["## Does combining detectors help?", "", "| Regime | " +
          " | ".join(label for label, _ in ENSEMBLES) + " |",
          "|---|" + "---|" * len(ENSEMBLES)]
    ens = ensemble_comparison()
    for regime, rows in ens.items():
        L.append("| %s | %s |" % (regime, " | ".join("%.2f" % rows[l]["f1"] for l, _ in ENSEMBLES)))
    for label, _ in ENSEMBLES:
        pass
    means = {label: sum(r[label]["f1"] for r in ens.values()) / len(ens) for label, _ in ENSEMBLES}
    L.append("| **mean** | %s |" % " | ".join("**%.2f**" % means[l] for l, _ in ENSEMBLES))
    L += ["", "Adding detectors raises recall and lowers precision. Which wins depends on",
          "the regime, which is why methods are selectable per analysis rather than",
          "fixed -- there is no single configuration that is best for all data.", ""]
    return "\n".join(L)


if __name__ == "__main__":
    report = render_markdown()
    out = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       "..", "benchmark_results.md"))
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(report)
    print(report)
    print("\nwritten to", out)
