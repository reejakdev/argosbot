#!/usr/bin/env python3
"""
GLiNER anonymization server for Argos.

Replaces the LLM second-pass anonymizer with a lightweight NER model.
GLiNER is a span-extraction model — zero hallucination risk, <50ms latency.

Usage:
    pip install gliner fastapi uvicorn
    python gliner_server.py [--port 7688] [--model urchade/gliner_medium-v2.1]

Config in ~/.argos/.config.json:
    { "anonymizer": { "glinerUrl": "http://127.0.0.1:7688" } }
"""

import argparse
import logging
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("gliner-server")

# ── Labels → Argos PII categories ────────────────────────────────────────────
# GLiNER supports arbitrary labels — we use the same taxonomy as llm-anonymizer.ts
LABELS = [
    "person",
    "organization",
    "company",
    "location",
    "project",
    "product",
    "account",
    "contract",
    "fund",
    "vault",
]

LABEL_TO_TYPE = {
    "person":       "person",
    "organization": "company",
    "company":      "company",
    "location":     "location",
    "project":      "project",
    "product":      "project",
    "account":      "account",
    "contract":     "account",
    "fund":         "project",
    "vault":        "project",
}

# ── Model (loaded once at startup) ───────────────────────────────────────────
model = None

# ── FastAPI ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    log.info(f"Loading GLiNER model: {app.state.model_name}")
    from gliner import GLiNER
    model = GLiNER.from_pretrained(app.state.model_name)
    log.info("GLiNER model ready")
    yield

app = FastAPI(title="GLiNER Anonymizer", version="1.0", lifespan=lifespan)


class DetectRequest(BaseModel):
    text: str
    threshold: float = 0.4  # GLiNER confidence threshold (0–1)


class Finding(BaseModel):
    text: str
    type: str          # person | company | project | location | account | other
    confidence: str    # high | medium | low (mapped from GLiNER score)
    score: float       # raw GLiNER score


class DetectResponse(BaseModel):
    findings: list[Finding]
    model: str
    text_length: int


def score_to_confidence(score: float) -> str:
    if score >= 0.75:
        return "high"
    if score >= 0.5:
        return "medium"
    return "low"


@app.get("/health")
def health():
    return {"status": "ok", "model": app.state.model_name, "ready": model is not None}


@app.post("/detect", response_model=DetectResponse)
def detect(req: DetectRequest):
    if model is None:
        return JSONResponse(status_code=503, content={"error": "Model not loaded yet"})

    # GLiNER predict — returns list of {text, label, score, start, end}
    entities = model.predict_entities(
        req.text,
        LABELS,
        threshold=req.threshold,
    )

    # Deduplicate by (text.lower(), type) — keep highest score
    seen: dict[tuple, Finding] = {}
    for ent in entities:
        pii_type = LABEL_TO_TYPE.get(ent["label"], "other")
        key = (ent["text"].lower(), pii_type)
        if key not in seen or ent["score"] > seen[key].score:
            seen[key] = Finding(
                text=ent["text"],
                type=pii_type,
                confidence=score_to_confidence(ent["score"]),
                score=round(ent["score"], 3),
            )

    findings = list(seen.values())
    log.debug(f"Detected {len(findings)} entities in {len(req.text)} chars")
    return DetectResponse(
        findings=findings,
        model=app.state.model_name,
        text_length=len(req.text),
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7688)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="urchade/gliner_medium-v2.1")
    args = parser.parse_args()

    app.state.model_name = args.model
    log.info(f"Starting GLiNER server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
