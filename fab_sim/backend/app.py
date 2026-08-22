"""
반도체 공정 수율 시뮬레이터 - 백엔드

실행:
    cd backend
    uvicorn app:app --reload --port 8000

브라우저에서 http://localhost:8000 접속
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from models.registry import build_registry
from pipeline import Pipeline

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.json")


def load_schema() -> Dict[str, Any]:
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        return json.load(f)


schema = load_schema()
registry = build_registry(schema)
pipeline = Pipeline(schema, registry)

app = FastAPI(title=schema["meta"]["title"])
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


class PredictRequest(BaseModel):
    params: Dict[str, Any] = {}


# ---------------------------------------------------------------- API
@app.get("/api/schema")
def get_schema():
    """프론트엔드가 UI를 그리기 위해 읽는 설정."""
    return schema


@app.get("/api/defaults")
def get_defaults():
    """기본값 + 기본값 기준 초기 예측 결과."""
    params = pipeline.defaults()
    return {"params": params, "prediction": pipeline.run(params)}


@app.post("/api/predict")
def predict(req: PredictRequest):
    """슬라이더가 움직일 때마다 호출되는 엔드포인트."""
    return pipeline.run(req.params)


@app.post("/api/reload")
def reload_models():
    """artifacts 에 새 모델을 넣은 뒤 서버 재시작 없이 반영."""
    global schema, registry, pipeline
    schema = load_schema()
    registry = build_registry(schema)
    pipeline = Pipeline(schema, registry)
    return {"ok": True, "stages": [s["id"] for s in schema["stages"]]}


@app.get("/api/health")
def health():
    return {"ok": True, "yield_input_mode": pipeline.yield_mode}


# ---------------------------------------------------------------- 정적 파일
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
