from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def root():
    return {"message": "AnomalyIQ Python service is running!"}

@app.get("/health")
def health():
    return {"status": "ok"}