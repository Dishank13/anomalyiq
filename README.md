# AnomalyIQ — AI-Powered Statistical Anomaly Detection Platform

**Live Demo:** https://anomalyiq.vercel.app  
**GitHub:** https://github.com/Dishank13/anomalyiq

AnomalyIQ is a full-stack platform that detects statistical anomalies in any tabular dataset and explains them in plain English using AI. Upload a CSV, run analysis, and get a real-time feed of anomalies with severity ratings, expected ranges, and AI-generated explanations.

---

## What it does

- Upload any CSV or Excel dataset
- Detects anomalies with four selectable methods -- Z-score (causal rolling window),
  IQR, STL seasonal decomposition, and Isolation Forest for multivariate outliers
- Choose which columns to monitor and tune the detection threshold
- Classifies each anomaly as High / Medium / Low severity
- Generates plain-English explanations using Gemini AI
- Runs analysis as a background job with retries, and streams progress live over WebSockets
- Plots the series with every finding marked, so you can see the outlier in context
- Explains each finding in plain English, with the statistics behind the call
- Full authentication with JWT

---

## Architecture
```
          ┌──────────────────────────────────────┐
          │        React + Redux Frontend        │
          │  Login / Sources / Anomalies / Jobs  │
          └───────────────┬──────────────────────┘
                REST + WebSocket (per-user rooms)
          ┌───────────────▼──────────────────────┐
          │        Node.js / Express API         │
          │  Auth, uploads, job orchestration    │
          └────┬─────────────────────────┬───────┘
       enqueue │                         │ Socket.io
          ┌────▼──────┐             ┌────▼───────┐
          │   Redis   │◄────────────┤  MongoDB   │
          │ BullMQ +  │   results   │ users,     │
          │ socket    │             │ sources,   │
          │ adapter   │             │ anomalies, │
          └────┬──────┘             │ runs       │
       consume │                    └────────────┘
          ┌────▼─────────────────────────────────┐
          │         Analysis Worker              │
          │  (own container, or in-process)      │
          └───────────────┬──────────────────────┘
                          │ HTTP (X-Request-Id)
          ┌───────────────▼──────────────────────┐
          │       Python / FastAPI Service       │
          │  4 detectors + batched Gemini calls  │
          └──────────────────────────────────────┘
```

### Analysis is a job, not a request

`POST /api/anomalies/analyze/:id` returns **202 + a jobId** and a worker does the
work; progress streams back over Socket.io. It used to block the request for up
to 90 seconds, which on a cold free-tier python service looks exactly like a
frozen browser.

- **Idempotent.** The job id is derived from the source id, a SHA-256 of the
  file, and the analysis options, so double-clicking "Run Analysis" joins the
  existing job instead of starting a rival one.
- **Retried.** Three attempts with exponential backoff; failures are kept for
  24 hours, successes for one.
- **Observable.** Every run is persisted as an `AnalysisRun`, so a dropped
  websocket or a closed tab does not make a run unobservable —
  `GET /api/anomalies/runs/:jobId` is the poll fallback.
- **Optional.** With no `REDIS_URL` the same runner executes inline in the
  request and emits the same events. The app is fully functional without Redis,
  so a lapsed free-tier add-on degrades latency rather than causing an outage.

The worker runs either as its own container (docker-compose, the real topology)
or inside the API process via `RUN_WORKER_INLINE` (free-tier hosting, where a
second always-on service is a second thing to keep awake). The same module runs
in both; the socket.io Redis adapter is what lets a separate worker process
reach browser connections held by the API.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Redux, React Router, Tailwind CSS, Recharts, Socket.io-client |
| Backend | Node.js, Express.js, Socket.io, BullMQ, Redis |
| Detection | Python, FastAPI, pandas, numpy, statsmodels, scikit-learn |
| AI | Google Gemini API (REST) |
| Database | MongoDB + Mongoose |
| Cache | Redis |
| Auth | JWT + bcrypt |
| DevOps | Docker, Docker Compose |
| Hosting | Vercel (frontend), Render (backend + Python), MongoDB Atlas |

---

## Running Locally

### Prerequisites
- Docker Desktop
- Node.js 20+
- Python 3.11+
- Git

### Setup
```bash
# Clone the repo
git clone https://github.com/Dishank13/anomalyiq.git
cd anomalyiq

# Create .env from the template and fill it in
cp .env.example .env

# Start all services
docker compose up --build
```

### Services
| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Backend | http://localhost:5000 |
| Python Service | http://localhost:8000 |

---

## How Anomaly Detection Works

Four detectors, each covering a failure mode the others miss. They are selectable
per analysis, because no single configuration is best for all data.

| Method | Catches | Blind to |
|---|---|---|
| **Z-score** (rolling) | drift and spikes against a local mean | anything the window has adapted to |
| **IQR** | global outliers, no distribution assumed | anything within the quartile fences |
| **STL** | values wrong *for their point in a cycle* | non-seasonal data |
| **Isolation Forest** | rows unusual across several columns at once | single-column anomalies |

### Measured, not asserted

Detectors are scored against synthetic series whose anomaly positions are known by
construction, so the choice of method is backed by numbers rather than intuition.
Full results in [`python-service/benchmark_results.md`](python-service/benchmark_results.md).

**F1 by regime** (averaged over three noise levels):

| Regime | zscore | iqr | stl | isolation_forest |
|---|---|---|---|---|
| point spikes | 0.76 | 0.67 | **0.94** | n/a |
| level shift | **0.50** | 0.00 | 0.00 | n/a |
| seasonal break | 0.00 | 0.00 | **0.97** | n/a |
| variance change | **0.29** | 0.10 | 0.20 | n/a |
| multivariate | 0.11 | 0.20 | 0.00 | **0.70** |

Each regime defeats a different detector, which is the argument for running several.
STL scores 0.97 on seasonal anomalies that z-score and IQR both score 0.00 on;
Isolation Forest scores 0.70 on multivariate anomalies where the best univariate
method manages 0.20.

### Two fixes the benchmark made visible

**The rolling window was leaking.** The original z-score computed its mean and
standard deviation over a window that *included the point being tested*. An extreme
value inflates the sigma it is then measured against and partially hides itself --
textbook masking. Shifting the window by one makes it causal. Mean F1 across
regimes: 0.35 -> 0.39.

**The loop was the bottleneck.** Detection iterated every row in Python. Vectorising
it produced identical output, verified row for row:

| Rows | Original | Vectorised | Speedup |
|---|---|---|---|
| 10,000 | 0.124 s | 0.002 s | 71x |
| 100,000 | 1.354 s | 0.022 s | 61x |
| 1,000,000 | 14.017 s | 0.194 s | **72x** |

### Severity

| \|Z\| | Severity | Statistical rarity |
|---|---|---|
| > 5.0 | High | < 0.00003% of normal data |
| 3.5 - 5.0 | Medium | < 0.05% |
| 3.0 - 3.5 | Low | < 0.3% |

---

## Interface

The governing rule is that **colour encodes severity and nothing else**. Buttons,
links, focus rings and chrome are all ink; in a tool whose job is to pull your eye
to outliers, a coloured button competes with the signal.

The three severity colours were validated for colour-vision deficiency rather than
picked by eye — worst adjacent pair ΔE 18.6 (deutan), 22.1 (normal vision) against
the page surface — and severity is never carried by colour alone: every finding also
gets a crosshair glyph and a text label.

**The control chart is the hero.** Findings are marked on the actual series with a
ring-and-crosshair mark, borrowed from the statistical process control convention
where an out-of-control point gets its own glyph. Selecting a finding reveals the
exact range *that* point violated.

There is deliberately no continuous "expected range" band: the rolling bounds are
only known at the points the analysis actually tested, so drawing one everywhere
would mean interpolating limits that were never computed.

Every numeral is set in IBM Plex Mono with tabular figures, so a column of z-scores
can be compared by scanning it.

---

## Running the benchmarks

```bash
cd python-service
pip install -r requirements-dev.txt

pytest bench/                  # regression guard on the detection maths
python -m bench.evaluate       # regenerate benchmark_results.md
python -m bench.bench_detect   # vectorised vs original timings
```

The test suite pins each detector to the F1 it achieved here, so a regression in
`detection.py` fails the build rather than quietly degrading results.

---

## Project Structure
```
anomalyiq/
├── frontend/          # React + Redux
│   └── src/
│       ├── pages/     # Login, Register, Dashboard, DataSources, AnomalyDetail
│       ├── store/     # Redux slices (auth, data)
│       └── services/  # axios API, socket.io client
├── backend/           # Node.js + Express
│   └── src/
│       ├── routes/    # auth, datasources, anomalies
│       ├── models/    # User, DataSource, Anomaly, AnalysisRun
│       ├── queue/     # BullMQ queue, worker, redis connection
│       ├── services/  # analysisRunner (shared by worker and inline path)
│       ├── lib/       # logger, token, indexes
│       └── middleware/ # JWT auth, validation
├── python-service/    # FastAPI
│   ├── app.py         # HTTP layer only
│   ├── detection.py   # the four detectors (pure functions, no FastAPI)
│   ├── loaders.py     # CSV/Excel parsing, JSON-safety
│   ├── ai.py          # batched Gemini explanations
│   └── bench/         # synthetic data, scoring, regression tests
└── docker-compose.yml
```

---

## Deployment

| Service | Platform | URL |
|---|---|---|
| Frontend | Vercel | https://anomalyiq.vercel.app |
| Backend | Render | https://anomalyiq-backend.onrender.com |
| Python | Render | https://anomalyiq-python.onrender.com |
| Database | MongoDB Atlas | AWS Mumbai |

> Note: Render free tier spins down after 15 minutes of inactivity. First request after idle may take ~50 seconds.

---

## Author

**Dishank Shah**  
B.Tech Computer and Communication Engineering  
Manipal Institute of Technology  
[LinkedIn](https://www.linkedin.com/in/dishank-shah-b43b5029a) • [GitHub](https://github.com/Dishank13)
