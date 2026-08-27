"""
반도체 공정 수율 시뮬레이터 - 백엔드

실행:
    cd backend
    uvicorn app:app --port 8000

브라우저에서 http://localhost:8000
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from models.base import build_registry
from monitor import MonitorEngine
from pipeline import Pipeline

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.json")
DATA_PATH = os.environ.get(
    "FAB_DATA", os.path.join(BASE_DIR, "..", "data", "merged_all_processes_derived.csv"))


def load_schema() -> Dict[str, Any]:
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        return json.load(f)


schema = load_schema()
registry = build_registry(schema)
pipeline = Pipeline(schema, registry)

monitor = MonitorEngine(pipeline, schema, DATA_PATH) if os.path.exists(DATA_PATH) else None

app = FastAPI(title=schema["meta"]["title"])
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


class PredictRequest(BaseModel):
    params: Dict[str, Any] = {}


class RecommendRequest(BaseModel):
    params: Dict[str, Any] = {}
    from_stage: str | None = None      # 이 공정부터 챔버를 탐색
    top_n: int = 5


class RouteSetRequest(BaseModel):
    params: Dict[str, Any] = {}
    from_stage: str | None = None       # 이 공정부터 재탐색
    lanes: list[str] | None = None      # 현재 라인들의 경로 (앞 공정 고정용)
    available: Dict[str, list] | None = None   # 공정별 사용 가능 챔버
    top_n: int = 3
    mode: str = "auto"                  # auto | fixed | search


@app.get("/api/schema")
def get_schema():
    """프론트가 UI 를 그리기 위해 읽는 설정. 숨김 공정은 제외."""
    pub = json.loads(json.dumps(schema))
    pub["stages"] = [s for s in pub["stages"] if not s.get("hidden")]
    return pub


@app.get("/api/defaults")
def get_defaults():
    params = pipeline.defaults()
    return {"params": params, "prediction": pipeline.run(params)}


@app.post("/api/predict")
def predict(req: PredictRequest):
    return pipeline.run(req.params)


@app.post("/api/recommend")
def recommend(req: RecommendRequest):
    """from_stage 이후 공정의 챔버 조합을 전수 탐색해 수율 순으로 반환."""
    return pipeline.recommend(req.params, req.from_stage, req.top_n)


@app.post("/api/routeset")
def routeset(req: RouteSetRequest):
    """세 라인을 동시 운용한다는 전제로 챔버가 겹치지 않는 최적 경로 조합을 반환."""
    return pipeline.recommend_set(req.params, req.from_stage, req.lanes,
                                  req.available, req.top_n, req.mode)


@app.post("/api/reload")
def reload_models():
    global schema, registry, pipeline
    schema = load_schema()
    registry = build_registry(schema)
    pipeline = Pipeline(schema, registry)
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True,
            "models": {k: type(v).__name__ for k, v in registry.items()}}


if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    @app.get("/monitor")
    def monitor_page():
        return FileResponse(os.path.join(FRONTEND_DIR, "monitor.html"))
