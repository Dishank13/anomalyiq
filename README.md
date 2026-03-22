# AnomalyIQ — AI-Powered Statistical Anomaly Detection Platform

**Live Demo:** https://anomalyiq.vercel.app  
**GitHub:** https://github.com/Dishank13/anomalyiq

AnomalyIQ is a full-stack platform that detects statistical anomalies in any tabular dataset and explains them in plain English using AI. Upload a CSV, run analysis, and get a real-time feed of anomalies with severity ratings, expected ranges, and AI-generated explanations.

---

## What it does

- Upload any CSV dataset
- Automatically detects anomalies using Z-score (rolling window) and IQR (interquartile range) methods
- Classifies each anomaly as High / Medium / Low severity
- Generates plain-English explanations using Gemini AI
- Pushes anomalies to your dashboard in real time via WebSockets — no refresh needed
- Full authentication with JWT

---

## Architecture
```
┌─────────────────────────────────────────┐
│           React + Redux Frontend         │
│   Login / Data Sources / Anomaly UI     │
└──────────────────┬──────────────────────┘
                   │ REST + WebSocket
┌──────────────────▼──────────────────────┐
│         Node.js / Express Backend        │
│   Auth, Data Sources, Job Queue,         │
│   Socket.io, MongoDB                     │
└──────────┬──────────────────────────────┘
           │ HTTP
┌──────────▼──────────────────────────────┐
│       Python / FastAPI Service           │
│   Z-score, IQR Detection, Gemini AI     │
│   pandas, numpy, scipy                  │
└─────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Redux, React Router, Socket.io-client |
| Backend | Node.js, Express.js, Socket.io, BullMQ |
| Detection | Python, FastAPI, pandas, numpy, scipy |
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

# Create .env file
echo "GEMINI_API_KEY=your_key_here" > .env
echo "JWT_SECRET=your_secret_here" >> .env

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

**Z-Score (Rolling Window)**  
Calculates how many standard deviations a value is from the rolling mean of the last 30 data points. Values beyond 3 standard deviations are flagged.

**IQR (Interquartile Range)**  
Splits data into quartiles and flags values that fall outside Q1 − 1.5×IQR or Q3 + 1.5×IQR. Catches outliers that Z-score might miss.

**Severity Classification**
- High → Z-score > 5
- Medium → Z-score > 3.5
- Low → Z-score > 3

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
│       ├── models/    # User, DataSource, Anomaly
│       └── middleware/ # JWT auth
├── python-service/    # FastAPI
│   ├── app.py         # Detection endpoints + Gemini integration
│   └── requirements.txt
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
