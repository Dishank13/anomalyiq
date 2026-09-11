# -*- coding: utf-8 -*-
"""AnomalyIQ detection service -- HTTP layer only.

Parsing lives in loaders.py, the statistics in detection.py, and the Gemini
calls in ai.py. Keeping detection free of FastAPI is what lets bench/ score it
against labelled data directly.
"""
import os
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

import numpy as np
import pandas as pd
import yfinance as yf

import ai
import detection
from loaders import clean_records, coerce_numeric, json_safe, load_dataframe

app = FastAPI(title="AnomalyIQ detection service")

# Hard cap on anomalies returned, so one pathological file cannot write
# thousands of documents and flood the websocket.
MAX_ANOMALIES = int(os.getenv("MAX_ANOMALIES", "300"))

# Analysing every column of a wide file is rarely what anyone wants and costs
# real time. This is a default, not a silent truncation: the response reports
# which columns were analysed and which others were available, so the UI can
# offer the rest rather than pretending they do not exist.
DEFAULT_MAX_COLUMNS = int(os.getenv("MAX_COLUMNS", "5"))


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
    # Previously accepted and silently ignored, so the documented "select
    # columns to monitor" feature did not actually exist.
    columns: Optional[List[str]] = None
    methods: Optional[List[str]] = None
    z_threshold: Optional[float] = None
    window: Optional[int] = None
    stl_period: Optional[int] = None


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
    status = ai.status_snapshot()
    # Detection is the core capability and needs no external service, so the
    # process is ready even when Gemini is down -- explanations simply fall
    # back to deterministic text.
    return {
        "status": "ready",
        "checks": {
            "detection": True,
            "aiExplanations": status["last_ok"],
            "aiConfigured": status["configured"],
        },
    }


@app.get("/health")
def health():
    status = ai.status_snapshot()
    return {
        "status": "ok",
        "ai_explanations": {
            "configured": status["configured"],
            "model": status["model"],
            # None until this process has attempted an explanation; afterwards
            # it says whether real AI text or fallback text is being served.
            "working": status["last_ok"],
            "last_error": status["last_error"],
        },
        "detection": {
            "methods": list(detection.ALL_METHODS),
            # A method listed as unavailable would return nothing rather than
            # error, so say so plainly instead of letting it fail quietly.
            "available": detection.available_methods(),
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


# ── Analysis configuration
def resolve_columns(df: pd.DataFrame, requested):
    """Pick the numeric columns to analyse.

    Returns (selected, all_numeric). An explicit choice is honoured as given;
    otherwise the first DEFAULT_MAX_COLUMNS are used and the full list is
    reported back so the caller can offer the others.
    """
    numeric = df.select_dtypes(include=[np.number]).columns.tolist()
    if not numeric:
        raise HTTPException(status_code=400,
                            detail="No numeric columns found for analysis")

    if requested:
        chosen = [c for c in requested if c in numeric]
        if not chosen:
            raise HTTPException(
                status_code=400,
                detail=("None of the requested columns are numeric. Available: %s"
                        % ", ".join(numeric[:20]))
            )
        return chosen, numeric

    return numeric[:DEFAULT_MAX_COLUMNS], numeric


def resolve_methods(requested):
    if not requested:
        return ("zscore", "iqr")
    chosen = tuple(m for m in requested if m in detection.ALL_METHODS)
    if not chosen:
        raise HTTPException(
            status_code=400,
            detail="Unknown detection method. Available: %s"
                   % ", ".join(detection.ALL_METHODS)
        )

    # Fail loudly rather than returning an empty result that looks like "no
    # anomalies found".
    available = detection.available_methods()
    missing = [m for m in chosen if not available.get(m)]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=("Detection method(s) %s are unavailable in this deployment "
                    "(missing optional dependency). Available: %s"
                    % (", ".join(missing),
                       ", ".join(m for m, ok in available.items() if ok)))
        )
    return chosen


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
        df = coerce_numeric(load_dataframe(content, fmt, req.encoding))
        source_name = req.config.get("fileName") or req.config.get("name") or "dataset"

        columns, all_numeric = resolve_columns(df, req.columns)
        methods = resolve_methods(req.methods)

        anomalies, series_by_column = detection.detect_all(
            df, columns,
            methods=methods,
            z_threshold=req.z_threshold or detection.DEFAULT_ZSCORE_THRESHOLD,
            window=req.window or detection.DEFAULT_WINDOW,
            stl_period=req.stl_period or detection.DEFAULT_STL_PERIOD,
        )

        truncated = len(anomalies) > MAX_ANOMALIES
        anomalies = anomalies[:MAX_ANOMALIES]

        ai.enrich_with_ai(anomalies, series_by_column, source_name)
        for a in anomalies:
            a.pop("position", None)

        return json_safe({
            "anomalies": anomalies,
            "total": len(anomalies),
            "truncated": truncated,
            "columns_analyzed": columns,
            "numeric_columns": all_numeric,
            "methods_used": list(methods),
        })

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
