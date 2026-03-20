from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from io import StringIO
import pandas as pd
import numpy as np
import yfinance as yf
import os
import google.generativeai as genai

app = FastAPI()

# ── Gemini setup
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

# ── Request Models
class StockRequest(BaseModel):
    symbol: str

class CSVRequest(BaseModel):
    file_content: str
    name: str

class DataRequest(BaseModel):
    source_id: str
    type: str
    config: dict

class AnalyzeRequest(BaseModel):
    source_id: str
    type: str
    config: dict
    file_content: Optional[str] = None
    columns: Optional[List[str]] = None

# ── Health
@app.get("/")
def root():
    return {"message": "AnomalyIQ Python service is running!"}

@app.get("/health")
def health():
    return {"status": "ok"}

# ── Stock Ingestor
@app.post("/ingest/stock")
def ingest_stock(req: StockRequest):
    try:
        ticker = yf.Ticker(req.symbol)
        df = ticker.history(period="1mo", timeout=10)
        if df.empty:
            df = ticker.history(period="6mo", timeout=10)
        if df.empty:
            raise HTTPException(status_code=404, detail=f"No data found for symbol {req.symbol}")
        df = df.reset_index()
        df['Date'] = df['Date'].astype(str)
        return {
            "symbol": req.symbol.upper(),
            "columns": list(df.columns),
            "row_count": len(df),
            "sample": df.tail(5).to_dict(orient="records")
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── CSV Ingestor
@app.post("/ingest/csv")
def ingest_csv(req: CSVRequest):
    try:
        df = pd.read_csv(StringIO(req.file_content))
        if df.empty:
            raise HTTPException(status_code=400, detail="CSV file is empty")
        return {
            "name": req.name,
            "columns": list(df.columns),
            "row_count": len(df),
            "sample": df.head(5).to_dict(orient="records")
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Data Fetcher
@app.post("/data")
def get_data(req: DataRequest):
    try:
        if req.type == "stock":
            symbol = req.config.get("symbol")
            ticker = yf.Ticker(symbol)
            df = ticker.history(period="1mo", timeout=10)
            df = df.reset_index()
            df['Date'] = df['Date'].astype(str)
            return {"columns": list(df.columns), "rows": df.to_dict(orient="records")}
        elif req.type == "csv":
            file_content = req.config.get("fileContent")
            if not file_content:
                raise HTTPException(status_code=400, detail="No file content found")
            df = pd.read_csv(StringIO(file_content))
            return {"columns": list(df.columns), "rows": df.head(500).to_dict(orient="records")}
        else:
            raise HTTPException(status_code=400, detail="Unsupported data source type")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Anomaly Detection Helpers
def get_severity(z_score: float) -> str:
    z = abs(z_score)
    if z > 5:
        return "high"
    elif z > 3.5:
        return "medium"
    else:
        return "low"

def explain_anomaly(column: str, value: float, expected_min: float, expected_max: float, recent_values: list, source_name: str) -> dict:
    if not GEMINI_API_KEY:
        return {
            "explanation": f"Value {value:.2f} in column '{column}' is outside the expected range of {expected_min:.2f} to {expected_max:.2f}.",
            "suggestion": "Investigate recent changes in this metric."
        }
    try:
        model = genai.GenerativeModel("gemini-2.0-flash")
        prompt = f"""You are a data analyst. A statistical anomaly was detected:
- Dataset: {source_name}
- Column: {column}
- Anomalous value: {value:.2f}
- Expected range: {expected_min:.2f} to {expected_max:.2f}
- Recent values: {[round(v, 2) for v in recent_values[-5:]]}

In exactly 2 sentences explain why this is anomalous.
In exactly 1 sentence suggest what to investigate.
Format: EXPLANATION: <2 sentences> SUGGESTION: <1 sentence>"""

        response = model.generate_content(prompt)
        text = response.text
        explanation = text.split("SUGGESTION:")[0].replace("EXPLANATION:", "").strip()
        suggestion = text.split("SUGGESTION:")[1].strip() if "SUGGESTION:" in text else "Investigate this anomaly further."
        return {"explanation": explanation, "suggestion": suggestion}
    except Exception:
        return {
            "explanation": f"Value {value:.2f} in '{column}' is outside expected range {expected_min:.2f} to {expected_max:.2f}.",
            "suggestion": "Investigate recent changes in this metric."
        }

def detect_anomalies_zscore(df: pd.DataFrame, column: str, source_name: str) -> list:
    anomalies = []
    series = df[column].dropna()
    if len(series) < 10:
        return anomalies

    window = min(30, len(series))
    rolling_mean = series.rolling(window=window, min_periods=5).mean()
    rolling_std = series.rolling(window=window, min_periods=5).std()

    for i in range(len(series)):
        mean = rolling_mean.iloc[i]
        std = rolling_std.iloc[i]
        if std == 0 or pd.isna(std) or pd.isna(mean):
            continue
        value = series.iloc[i]
        z_score = (value - mean) / std
        if abs(z_score) > 3:
            expected_min = mean - 3 * std
            expected_max = mean + 3 * std
            recent = list(series.iloc[max(0, i-10):i])
            ai = explain_anomaly(column, value, expected_min, expected_max, recent, source_name)
            timestamp = str(df.index[i]) if not isinstance(df.index, pd.RangeIndex) else str(i)
            anomalies.append({
                "column": column,
                "row_index": int(series.index[i]),
                "timestamp": timestamp,
                "value": float(value),
                "expected_min": float(expected_min),
                "expected_max": float(expected_max),
                "z_score": float(z_score),
                "method": "zscore",
                "severity": get_severity(z_score),
                "explanation": ai["explanation"],
                "suggestion": ai["suggestion"]
            })
    return anomalies

def detect_anomalies_iqr(df: pd.DataFrame, column: str, source_name: str) -> list:
    anomalies = []
    series = df[column].dropna()
    if len(series) < 10:
        return anomalies

    Q1 = series.quantile(0.25)
    Q3 = series.quantile(0.75)
    IQR = Q3 - Q1
    lower = Q1 - 1.5 * IQR
    upper = Q3 + 1.5 * IQR

    outliers = series[(series < lower) | (series > upper)]
    for idx in outliers.index:
        value = series[idx]
        z_score = (value - series.mean()) / series.std() if series.std() > 0 else 0
        recent = list(series.iloc[max(0, list(series.index).index(idx)-10):list(series.index).index(idx)])
        ai = explain_anomaly(column, value, lower, upper, recent, source_name)
        anomalies.append({
            "column": column,
            "row_index": int(idx),
            "timestamp": str(idx),
            "value": float(value),
            "expected_min": float(lower),
            "expected_max": float(upper),
            "z_score": float(z_score),
            "method": "iqr",
            "severity": float(abs(z_score)) > 3.5 and "high" or "medium",
            "explanation": ai["explanation"],
            "suggestion": ai["suggestion"]
        })
    return anomalies

# ── Main Analyze Endpoint
@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    try:
        # Load data
        if req.type == "csv":
            if not req.file_content:
                raise HTTPException(status_code=400, detail="No file content provided")
            df = pd.read_csv(StringIO(req.file_content))
        else:
            raise HTTPException(status_code=400, detail="Unsupported type for analysis")

        source_name = req.config.get("fileName", "dataset")

        # Get numeric columns only
        numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
        if not numeric_cols:
            raise HTTPException(status_code=400, detail="No numeric columns found for analysis")

        # Limit to first 5 numeric columns to avoid too many API calls
        numeric_cols = numeric_cols[:5]

        all_anomalies = []
        for col in numeric_cols:
            zscore_anomalies = detect_anomalies_zscore(df, col, source_name)
            iqr_anomalies = detect_anomalies_iqr(df, col, source_name)

            # Deduplicate — prefer zscore results
            zscore_indices = {a["row_index"] for a in zscore_anomalies}
            unique_iqr = [a for a in iqr_anomalies if a["row_index"] not in zscore_indices]

            all_anomalies.extend(zscore_anomalies)
            all_anomalies.extend(unique_iqr)

        # Sort by severity
        severity_order = {"high": 0, "medium": 1, "low": 2}
        all_anomalies.sort(key=lambda x: severity_order.get(x["severity"], 3))

        return {"anomalies": all_anomalies, "total": len(all_anomalies)}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))