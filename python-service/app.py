from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, List, Any
from io import StringIO, BytesIO
import base64
import binascii
import math
import json
import os
import threading
import time

import pandas as pd
import numpy as np
import yfinance as yf
import requests

app = FastAPI()

# ── Gemini setup
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Google retires model names on a rolling basis. This service shipped against
# "gemini-2.0-flash", which began returning 404; because every failure fell
# through to the deterministic fallback, the app kept serving canned template
# text under an "AI Explanation" heading and nothing surfaced the breakage.
# A "-latest" alias tracks Google's current model so that cannot recur, and
# GEMINI_MODEL pins a specific version if a future default ever regresses.
#
# Flash-Lite over Flash deliberately: writing three sentences about a number
# needs no frontier reasoning, and the lite tier has both a larger free-tier
# quota and far less congestion (plain Flash returns 503 under load).
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")

# Statuses that mean this deployment is misconfigured rather than that one call
# had a bad day. They do not heal on their own, so they get logged loudly.
GEMINI_CONFIG_ERROR_STATUSES = {400, 401, 403, 404}

# Worth waiting out: quota windows and capacity blips both clear on their own.
GEMINI_RETRYABLE_STATUSES = {429, 500, 503}

# Flash-Lite rejects thinkingConfig with a 400. Seed from the model name, then
# correct course if the API disagrees, so a new model family needs no code edit.
_THINKING_UNSUPPORTED = "lite" in GEMINI_MODEL.lower()

# Structured output: a typed JSON array removes the brittle
# "EXPLANATION: ... SUGGESTION: ..." string-splitting the old path relied on.
GEMINI_RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "id": {"type": "INTEGER"},
            "explanation": {"type": "STRING"},
            "suggestion": {"type": "STRING"},
        },
        "required": ["id", "explanation", "suggestion"],
    },
}

# Outcome of the most recent Gemini call, so /health can report whether real
# explanations or fallback text are actually shipping.
AI_STATUS = {
    "configured": bool(GEMINI_API_KEY),
    "model": GEMINI_MODEL,
    "last_ok": None,      # None until the first call of this process
    "last_error": None,
}
_AI_STATUS_LOCK = threading.Lock()


def note_ai_success() -> None:
    with _AI_STATUS_LOCK:
        AI_STATUS["last_ok"] = True
        AI_STATUS["last_error"] = None


def note_ai_failure(message: str, loud: bool = False) -> None:
    with _AI_STATUS_LOCK:
        AI_STATUS["last_ok"] = False
        AI_STATUS["last_error"] = message
    print(("GEMINI CONFIG ERROR: %s" if loud else "Gemini: %s") % message, flush=True)

# How many anomalies get a real AI explanation. The rest fall back to the
# deterministic text. Without this cap a wide file produces hundreds of
# sequential Gemini calls and the request dies at the proxy.
MAX_AI_EXPLANATIONS = int(os.getenv("MAX_AI_EXPLANATIONS", "25"))
GEMINI_TIMEOUT = int(os.getenv("GEMINI_TIMEOUT", "45"))

# Explanations are requested in batches rather than one call per anomaly. The
# free tier allows 5 requests per minute per model, so the old one-call-per-
# anomaly loop could never finish a 25-anomaly run: it burned the entire quota
# in seconds and served fallback text for the remainder. One batched call per
# analysis costs a single request and one round trip instead of twenty-five.
GEMINI_BATCH_SIZE = int(os.getenv("GEMINI_BATCH_SIZE", "25"))
GEMINI_MAX_ATTEMPTS = int(os.getenv("GEMINI_MAX_ATTEMPTS", "3"))
GEMINI_BATCH_PAUSE = float(os.getenv("GEMINI_BATCH_PAUSE", "1.0"))

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


# ── Request correlation
# The Node backend forwards its request id as X-Request-Id. Echoing it back and
# logging it is what makes a single analysis traceable across all three
# services -- without it, a failure here cannot be lined up with the API call
# that caused it.
@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-Id", "-")
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    if request.url.path not in ("/healthz", "/readyz", "/health"):
        print("[%s] %s %s -> %s" % (request_id, request.method,
                                    request.url.path, response.status_code),
              flush=True)
    return response


# ── Health
@app.get("/")
def root():
    return {"message": "AnomalyIQ Python service is running!"}


# Liveness: is the process up? Checks nothing else on purpose, so a degraded
# dependency cannot get the container restarted.
@app.get("/healthz")
def healthz():
    return {"status": "ok"}


# Readiness: can this process actually do the work it exists for?
@app.get("/readyz")
def readyz():
    with _AI_STATUS_LOCK:
        ai = dict(AI_STATUS)
    # Detection is the core capability and needs no external service, so the
    # process is ready even when Gemini is down -- explanations simply fall
    # back to deterministic text.
    return {
        "status": "ready",
        "checks": {
            "detection": True,
            "aiExplanations": ai["last_ok"],
            "aiConfigured": ai["configured"],
        },
    }


@app.get("/health")
def health():
    with _AI_STATUS_LOCK:
        ai = dict(AI_STATUS)
    return {
        "status": "ok",
        "ai_explanations": {
            "configured": ai["configured"],
            "model": ai["model"],
            # None until this process has attempted an explanation; afterwards
            # it says whether real AI text or fallback text is being served.
            "working": ai["last_ok"],
            "last_error": ai["last_error"],
        },
    }


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


def extract_gemini_text(data: dict) -> str:
    """Pull the answer text out of a generateContent response.

    Not as simple as parts[0]["text"]: Gemini 3.x interleaves thought parts that
    carry a thoughtSignature and no text, and a filtered or truncated response
    can carry no parts at all. Both used to raise, get swallowed, and silently
    degrade the whole feature to template text.
    """
    candidates = data.get("candidates") or []
    if not candidates:
        reason = (data.get("promptFeedback") or {}).get("blockReason", "unknown reason")
        raise ValueError("no candidates returned (%s)" % reason)

    candidate = candidates[0]
    parts = (candidate.get("content") or {}).get("parts") or []
    texts = [p["text"] for p in parts if isinstance(p, dict) and p.get("text")]
    if not texts:
        raise ValueError("response carried no text parts (finishReason=%s)"
                         % candidate.get("finishReason"))
    return "\n".join(texts).strip()


def retry_delay_seconds(payload: dict, attempt: int) -> float:
    """Honour the server's own RetryInfo when it sends one, else back off."""
    for detail in (payload.get("error", {}).get("details") or []):
        raw = detail.get("retryDelay")
        if isinstance(raw, str) and raw.endswith("s"):
            try:
                return min(float(raw[:-1]), 30.0)
            except ValueError:
                pass
    return min(2.0 * (2 ** attempt), 30.0)


def call_gemini(prompt: str) -> str:
    """POST one prompt and return the model's text, retrying transient failures.

    Raises RuntimeError when the request cannot be completed; callers fall back
    to deterministic explanations.
    """
    global _THINKING_UNSUPPORTED

    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           "%s:generateContent?key=%s" % (GEMINI_MODEL, GEMINI_API_KEY))

    for attempt in range(GEMINI_MAX_ATTEMPTS):
        generation_config = {
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_RESPONSE_SCHEMA,
            "temperature": 0.3,
        }
        if not _THINKING_UNSUPPORTED:
            # Three sentences of prose do not need a reasoning budget, and the
            # latency would be paid on every analysis.
            generation_config["thinkingConfig"] = {"thinkingBudget": 0}

        try:
            response = requests.post(
                url,
                json={"contents": [{"parts": [{"text": prompt}]}],
                      "generationConfig": generation_config},
                timeout=GEMINI_TIMEOUT,
            )
        except requests.RequestException as e:
            if attempt + 1 < GEMINI_MAX_ATTEMPTS:
                time.sleep(retry_delay_seconds({}, attempt))
                continue
            raise RuntimeError("request failed: %s" % e)

        if response.status_code == 200:
            return extract_gemini_text(response.json())

        try:
            payload = response.json()
        except ValueError:
            payload = {}
        detail = response.text[:300]

        # A model that rejects thinkingConfig says so with a 400; drop the field
        # and retry rather than writing the deployment off as misconfigured.
        if (response.status_code == 400 and not _THINKING_UNSUPPORTED
                and "thinking" in detail.lower()):
            _THINKING_UNSUPPORTED = True
            continue

        if (response.status_code in GEMINI_RETRYABLE_STATUSES
                and attempt + 1 < GEMINI_MAX_ATTEMPTS):
            time.sleep(retry_delay_seconds(payload, attempt))
            continue

        if response.status_code in GEMINI_CONFIG_ERROR_STATUSES:
            note_ai_failure(
                "HTTP %s for model '%s' - configuration problem, not a transient one. "
                "Every explanation will be fallback text until this is fixed. %s"
                % (response.status_code, GEMINI_MODEL, detail),
                loud=True,
            )
        raise RuntimeError("HTTP %s: %s" % (response.status_code, detail))

    raise RuntimeError("exhausted %d attempts" % GEMINI_MAX_ATTEMPTS)


def build_batch_prompt(batch: list, source_name: str) -> str:
    """One prompt describing every anomaly in the batch, keyed by id."""
    lines = []
    for item in batch:
        a = item["anomaly"]
        lines.append(
            "- id %d | column '%s' | value %.2f | expected %.2f to %.2f | "
            "recent values %s"
            % (item["id"], a["column"], a["value"], a["expected_min"],
               a["expected_max"], [round(v, 2) for v in item["recent"][-5:]])
        )

    return (
        "You are a data analyst reviewing statistical anomalies detected in the "
        "dataset '%s'.\n\nAnomalies:\n%s\n\n"
        "For each anomaly return an object with its id, a 2-sentence explanation "
        "of why the value is anomalous, and a 1-sentence suggestion of what to "
        "investigate. Return exactly one object per anomaly listed above."
        % (source_name, "\n".join(lines))
    )


def explain_batch(batch: list, source_name: str) -> dict:
    """Return {id: {explanation, suggestion}} for one batch of anomalies."""
    parsed = json.loads(call_gemini(build_batch_prompt(batch, source_name)))
    if isinstance(parsed, dict):        # a lone object when the batch had one item
        parsed = [parsed]

    results = {}
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        explanation = (entry.get("explanation") or "").strip()
        if not explanation:
            continue
        try:
            key = int(entry.get("id"))
        except (TypeError, ValueError):
            continue
        suggestion = (entry.get("suggestion") or "").strip()
        results[key] = {
            "explanation": explanation,
            "suggestion": suggestion or "Investigate this anomaly further.",
        }
    return results


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
    """Attach explanations in place.

    Every anomaly starts with a deterministic explanation, so a Gemini failure
    degrades the wording rather than breaking the response. The top
    MAX_AI_EXPLANATIONS are then upgraded with real explanations, requested in
    batches of GEMINI_BATCH_SIZE.
    """
    for a in anomalies:
        a.update(fallback_explanation(a["column"], a["value"],
                                      a["expected_min"], a["expected_max"]))

    if not GEMINI_API_KEY:
        return

    targets = anomalies[:MAX_AI_EXPLANATIONS]
    if not targets:
        return

    items = []
    for i, anomaly in enumerate(targets):
        series = series_by_column.get(anomaly["column"])
        pos = anomaly.get("position", 0)
        recent = list(series.iloc[max(0, pos - 10):pos]) if series is not None else []
        items.append({"id": i, "anomaly": anomaly, "recent": recent})

    batches = [items[i:i + GEMINI_BATCH_SIZE]
               for i in range(0, len(items), GEMINI_BATCH_SIZE)]
    explained = 0

    for batch_no, batch in enumerate(batches):
        if batch_no:
            time.sleep(GEMINI_BATCH_PAUSE)      # stay inside the per-minute quota
        try:
            results = explain_batch(batch, source_name)
        except (RuntimeError, ValueError, KeyError, TypeError) as e:
            note_ai_failure("batch %d/%d failed: %s" % (batch_no + 1, len(batches), e))
            continue

        for item in batch:
            result = results.get(item["id"])
            if result:
                item["anomaly"].update(result)
                explained += 1

    if explained:
        note_ai_success()
    print("Gemini: explained %d/%d anomalies in %d request(s)"
          % (explained, len(targets), len(batches)), flush=True)


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
