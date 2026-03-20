from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
from io import StringIO
import pandas as pd
import yfinance as yf

app = FastAPI()

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

# ── Data Fetcher (for charting)
@app.post("/data")
def get_data(req: DataRequest):
    try:
        if req.type == "stock":
            symbol = req.config.get("symbol")
            ticker = yf.Ticker(symbol)
            df = ticker.history(period="1mo", timeout=10)
            df = df.reset_index()
            df['Date'] = df['Date'].astype(str)
            return {
                "columns": list(df.columns),
                "rows": df.to_dict(orient="records")
            }

        elif req.type == "csv":
            file_content = req.config.get("fileContent")
            if not file_content:
                raise HTTPException(status_code=400, detail="No file content found")
            df = pd.read_csv(StringIO(file_content))
            return {
                "columns": list(df.columns),
                "rows": df.head(500).to_dict(orient="records")
            }

        else:
            raise HTTPException(status_code=400, detail="Unsupported data source type")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))