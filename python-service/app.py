from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Any
from concurrent.futures import ThreadPoolExecutor
from io import StringIO, BytesIO
import base64
import binascii
import math
import os

import pandas as pd
import numpy as np
import yfinance as yf
import requests

app = FastAPI()

# ── Gemini setup
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# How many anomalies get a real AI explanation. The rest fall back to the
# deterministic text. Without this cap a wide file produces hundreds of
# sequential Gemini calls and the request dies at the proxy.
MAX_AI_EXPLANATIONS = int(os.getenv("MAX_AI_EXPLANATIONS", "25"))
AI_CONCURRENCY = int(os.getenv("AI_CONCURRENCY", "5"))
GEMINI_TIMEOUT = int(os.getenv("GEMINI_TIMEOUT", "15"))

# Hard cap on anomalies returned, so one pathological file cannot write
# thousands of documents and flood the websocket.
MAX_ANOMALIES = int(os.getenv("MAX_ANOMALIES", "300"))

SUPPORTED_FORMATS = ("csv", "xlsx", "xls")


# ── Request Models
class StockRequest(BaseModel):
    symbol: str


class IngestFileRequest(BaseModel):
    file_content: str                      # base64, or raw text for legacy csv
    name: str
    file_format: Optional[str] = "csv"     # csv | xlsx | xls
    encoding: Optional[str] = "base64"     # base64 | text


class DataRequest(BaseModel):
    source_id: str
    type: str
    config: dict
    file_content: Optional[str] = None
    file_format: Optional[str] = "csv"
    encoding: Optional[str] = "base64"


class AnalyzeRequest(BaseModel):
    source_id: str
    type: str
    config: dict
    file_content: Optional[str] = None
    file_format: Optional[str] = "csv"
    encoding: Optional[str] = "base64"
    columns: Optional[List[str]] = None


# ── JSON safety helpers
# Starlette serialises with allow_nan=False, so a single NaN/Inf anywhere in a
# response raises "Out of range float values are not JSON compliant" and the
# whole endpoint 500s. Every value that leaves this service goes through here.
def json_safe(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, np.floating):
        f = float(value)
        return f if math.isfinite(f) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, pd.Timestamp):
        return str(value)
    if isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


def clean_records(df: pd.DataFrame) -> list:
    """DataFrame -> list of JSON-safe dicts."""
    return [json_safe(rec) for rec in df.to_dict(orient="records")]


def is_finite(*values) -> bool:
    for v in values:
        if not isinstance(v, (int, float, np.integer, np.floating)):
            return False
        if not math.isfinite(float(v)):
            return False
    return True


# ── File loading
def decode_payload(file_content: str, encoding: str) -> bytes:
    if encoding == "text":
        return file_content.encode("utf-8")
    try:
        return base64.b64decode(file_content, validate=True)
    except (binascii.Error, ValueError):
        # Legacy rows stored raw CSV text rather than base64.
        return file_content.encode("utf-8")


def load_dataframe(file_content: str, file_format: str = "csv",
                   encoding: str = "base64") -> pd.DataFrame:
    """Decode an uploaded file into a DataFrame. Supports csv, xlsx and xls."""
    fmt = (file_format or "csv").lower().lstrip(".")
    if fmt not in SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file format '%s'. Supported: CSV, XLSX, XLS." % fmt
        )

    raw = decode_payload(file_content, encoding or "base64")
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        if fmt == "csv":
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = raw.decode("latin-1")
            df = pd.read_csv(StringIO(text))
        elif fmt == "xlsx":
            df = pd.read_excel(BytesIO(raw), sheet_name=0, engine="openpyxl")
        else:  # xls
            df = pd.read_excel(BytesIO(raw), sheet_name=0, engine="xlrd")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail="Could not read %s file: %s" % (fmt.upper(), e)
        )

    if isinstance(df, dict):          # defensive: sheet_name=0 should not do this
        df = next(iter(df.values()))

    if df.empty:
        raise HTTPException(status_code=400, detail="File contains no rows")

    df = df.reset_index(drop=True)
    df.columns = [str(c) for c in df.columns]
    return df


def coerce_numeric(df: pd.DataFrame) -> pd.DataFrame:
    """Promote text columns that are really numbers (thousands separators,
    currency symbols, stray spaces) so they get analysed instead of skipped."""
    df = df.copy()
    for col in df.columns:
        if df[col].dtype != object:
            continue
        cleaned = (df[col].astype(str)
                   .str.strip()
                   .str.replace(r"[,$%\s]", "", regex=True)
                   .replace({"": None, "nan": None, "None": None,
                             "NaN": None, "-": None}))
        converted = pd.to_numeric(cleaned, errors="coerce")
        non_null = cleaned.notna().sum()
        if non_null > 0 and converted.notna().sum() >= 0.8 * non_null:
            df[col] = converted
    return df


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
            raise HTTPException(
                status_code=404,
                detail="No data found for symbol %s" % req.symbol
            )
        df = df.reset_index()
        df["Date"] = df["Date"].astype(str)
        return {
            "symbol": req.symbol.upper(),
            "columns": [str(c) for c in df.columns],
            "row_count": len(df),
            "sample": clean_records(df.tail(5))
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── File Ingestor (CSV / Excel)
@app.post("/ingest/file")
def ingest_file(req: IngestFileRequest):
    df = load_dataframe(req.file_content, req.file_format, req.encoding)
    numeric_cols = coerce_numeric(df).select_dtypes(include=[np.number]).columns.tolist()
    return {
        "name": req.name,
        "columns": list(df.columns),
        "numeric_columns": numeric_cols,
        "row_count": len(df),
        "sample": clean_records(df.head(5))
    }


# Kept so an older backend build still works against a new python service.
@app.post("/ingest/csv")
def ingest_csv(req: IngestFileRequest):
    return ingest_file(req)


# ── Data Fetcher
@app.post("/data")
def get_data(req: DataRequest):
    try:
        if req.type == "stock":
            symbol = req.config.get("symbol")
            ticker = yf.Ticker(symbol)
            df = ticker.history(period="1mo", timeout=10)
            if df.empty:
                raise HTTPException(
                    status_code=404,
                    detail="No data found for symbol %s" % symbol
                )
            df = df.reset_index()
            df["Date"] = df["Date"].astype(str)
            return {"columns": [str(c) for c in df.columns], "rows": clean_records(df)}

        if req.type in ("csv", "excel", "file"):
            # The backend now passes the stored content through; fall back to
            # config for older callers.
            content = req.file_content or req.config.get("fileContent")
            if not content:
                raise HTTPException(
                    status_code=400,
                    detail=("File content unavailable for this data source. "
                            "Please re-upload the file.")
                )
            fmt = req.file_format or req.config.get("fileFormat") or "csv"
            df = load_dataframe(content, fmt, req.encoding)
            return {"columns": list(df.columns), "rows": clean_records(df.head(500))}

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
    if z > 3.5:
        return "medium"
    return "low"


def fallback_explanation(column: str, value: float,
                         expected_min: float, expected_max: float) -> dict:
    return {
        "explanation": ("Value %.2f in column '%s' falls outside the expected "
                        "range of %.2f to %.2f."
                        % (value, column, expected_min, expected_max)),
        "suggestion": "Investigate recent changes in this metric."
    }


def explain_anomaly(anomaly: dict, recent_values: list, source_name: str) -> dict:
    column = anomaly["column"]
    value = anomaly["value"]
    expected_min = anomaly["expected_min"]
    expected_max = anomaly["expected_max"]

    if not GEMINI_API_KEY:
        return fallback_explanation(column, value, expected_min, expected_max)

    try:
        url = ("https://generativelanguage.googleapis.com/v1beta/models/"
               "gemini-2.0-flash:generateContent?key=%s" % GEMINI_API_KEY)
        prompt = """You are a data analyst. A statistical anomaly was detected:
- Dataset: %s
- Column: %s
- Anomalous value: %.2f
- Expected range: %.2f to %.2f
- Recent values: %s

In exactly 2 sentences explain why this is anomalous.
In exactly 1 sentence suggest what to investigate.
Format: EXPLANATION: <2 sentences> SUGGESTION: <1 sentence>""" % (
            source_name, column, value, expected_min, expected_max,
            [round(v, 2) for v in recent_values[-5:]]
        )

        response = requests.post(
            url,
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=GEMINI_TIMEOUT
        )
        if response.status_code != 200:
            print("Gemini error %s: %s" % (response.status_code, response.text[:200]))
            return fallback_explanation(column, value, expected_min, expected_max)

        data = response.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        explanation = text.split("SUGGESTION:")[0].replace("EXPLANATION:", "").strip()
        suggestion = (text.split("SUGGESTION:")[1].strip()
                      if "SUGGESTION:" in text else "Investigate this anomaly further.")
        if not explanation:
            return fallback_explanation(column, value, expected_min, expected_max)
        return {"explanation": explanation, "suggestion": suggestion}
    except Exception as e:
        print("Gemini error: %s" % e)
        return fallback_explanation(column, value, expected_min, expected_max)


def detect_anomalies_zscore(series: pd.Series, column: str) -> list:
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
        if not is_finite(value, expected_min, expected_max, z_score):
            continue
        anomalies.append({
            "column": column,
            "row_index": int(series.index[i]),
            "position": i,
            "timestamp": str(series.index[i]),
            "value": float(value),
            "expected_min": float(expected_min),
            "expected_max": float(expected_max),
            "z_score": float(z_score),
            "method": "zscore",
            "severity": get_severity(z_score),
        })
    return anomalies


def detect_anomalies_iqr(series: pd.Series, column: str) -> list:
    anomalies = []
    if len(series) < 10:
        return anomalies

    Q1 = series.quantile(0.25)
    Q3 = series.quantile(0.75)
    IQR = Q3 - Q1
    if pd.isna(IQR) or IQR == 0:
        return anomalies

    lower = Q1 - 1.5 * IQR
    upper = Q3 + 1.5 * IQR
    mean = series.mean()
    std = series.std()

    positions = {idx: pos for pos, idx in enumerate(series.index)}
    outliers = series[(series < lower) | (series > upper)]

    for idx in outliers.index:
        value = series[idx]
        z_score = (value - mean) / std if std and std > 0 else 0.0
        if not is_finite(value, lower, upper, z_score):
            continue
        anomalies.append({
            "column": column,
            "row_index": int(idx),
            "position": positions[idx],
            "timestamp": str(idx),
            "value": float(value),
            "expected_min": float(lower),
            "expected_max": float(upper),
            "z_score": float(z_score),
            "method": "iqr",
            "severity": "high" if abs(z_score) > 3.5 else "medium",
        })
    return anomalies


def enrich_with_ai(anomalies: list, series_by_column: dict, source_name: str) -> None:
    """Attach explanations in place. Only the top MAX_AI_EXPLANATIONS get a real
    Gemini call, and those run concurrently instead of one at a time."""
    for a in anomalies:
        a.update(fallback_explanation(a["column"], a["value"],
                                      a["expected_min"], a["expected_max"]))

    if not GEMINI_API_KEY:
        return

    targets = anomalies[:MAX_AI_EXPLANATIONS]
    if not targets:
        return

    def work(anomaly):
        series = series_by_column.get(anomaly["column"])
        pos = anomaly.get("position", 0)
        recent = list(series.iloc[max(0, pos - 10):pos]) if series is not None else []
        return anomaly, explain_anomaly(anomaly, recent, source_name)

    with ThreadPoolExecutor(max_workers=AI_CONCURRENCY) as pool:
        for anomaly, result in pool.map(work, targets):
            anomaly.update(result)


# ── Main Analyze Endpoint
@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    try:
        if req.type not in ("csv", "excel", "file"):
            raise HTTPException(
                status_code=400,
                detail="Analysis is not supported for '%s' sources yet" % req.type
            )

        content = req.file_content or req.config.get("fileContent")
        if not content:
            raise HTTPException(
                status_code=400,
                detail=("File content unavailable for this data source. "
                        "Please re-upload the file.")
            )

        fmt = req.file_format or req.config.get("fileFormat") or "csv"
        df = load_dataframe(content, fmt, req.encoding)
        source_name = req.config.get("fileName") or req.config.get("name") or "dataset"

        df = coerce_numeric(df)
        numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
        if not numeric_cols:
            raise HTTPException(status_code=400,
                                detail="No numeric columns found for analysis")
        numeric_cols = numeric_cols[:5]

        all_anomalies = []
        series_by_column = {}
        for col in numeric_cols:
            series = df[col].replace([np.inf, -np.inf], np.nan).dropna()
            if series.empty:
                continue
            series_by_column[col] = series

            zscore_anomalies = detect_anomalies_zscore(series, col)
            iqr_anomalies = detect_anomalies_iqr(series, col)
            zscore_indices = {a["row_index"] for a in zscore_anomalies}
            unique_iqr = [a for a in iqr_anomalies
                          if a["row_index"] not in zscore_indices]
            all_anomalies.extend(zscore_anomalies)
            all_anomalies.extend(unique_iqr)

        severity_order = {"high": 0, "medium": 1, "low": 2}
        all_anomalies.sort(key=lambda x: (severity_order.get(x["severity"], 3),
                                          -abs(x["z_score"])))

        truncated = len(all_anomalies) > MAX_ANOMALIES
        all_anomalies = all_anomalies[:MAX_ANOMALIES]

        enrich_with_ai(all_anomalies, series_by_column, source_name)
        for a in all_anomalies:
            a.pop("position", None)

        return json_safe({
            "anomalies": all_anomalies,
            "total": len(all_anomalies),
            "truncated": truncated,
            "columns_analyzed": numeric_cols,
        })

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
