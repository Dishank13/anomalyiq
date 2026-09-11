# -*- coding: utf-8 -*-
"""Reading uploaded files, and making their contents safe to serialise.

Split out of app.py so the routing layer does not also own file parsing, and
so these can be exercised without standing up FastAPI.
"""
from io import StringIO, BytesIO
from typing import Any
import base64
import binascii
import math

import numpy as np
import pandas as pd
from fastapi import HTTPException

SUPPORTED_FORMATS = ("csv", "xlsx", "xls")


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
