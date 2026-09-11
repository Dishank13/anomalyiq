# -*- coding: utf-8 -*-
"""Plain-English explanations for detected anomalies, via the Gemini REST API.

Explanations are requested in batches, not one call per anomaly: the free tier
allows 5 requests per minute, so the original per-anomaly loop exhausted the
quota within seconds of a 25-anomaly run and served fallback text for the rest.

Every anomaly always carries a deterministic explanation, so any failure here
degrades the wording rather than breaking the response.
"""
import json
import os
import threading
import time

import requests

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


def status_snapshot() -> dict:
    """A consistent copy of the AI status, for the health endpoints."""
    with _AI_STATUS_LOCK:
        return dict(AI_STATUS)


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
