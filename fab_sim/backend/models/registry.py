"""
모델 레지스트리.

artifacts/{stage_id}.pkl 이 있으면 그것을 쓰고, 없으면 StubPredictor 로 대체한다.
따라서 모델링이 끝나면 pkl 파일만 떨어뜨리면 코드 수정 없이 반영된다.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List

from .base import Predictor, SklearnPredictor, StubPredictor

ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")


def _param_spec(stage: Dict[str, Any]) -> Dict[str, Any]:
    """schema 의 params 를 {key: meta} 형태로 변환."""
    spec = {}
    for p in stage["params"]:
        if p["type"] == "category":
            spec[p["key"]] = {"options": p["options"]}
        else:
            spec[p["key"]] = {"min": p["min"], "max": p["max"]}
    return spec


def _try_load(stage_id: str):
    """artifacts 에서 모델을 읽어온다. 없거나 실패하면 None."""
    path = os.path.join(ARTIFACT_DIR, f"{stage_id}.pkl")
    if not os.path.exists(path):
        return None
    try:
        import joblib
        obj = joblib.load(path)
        if isinstance(obj, dict):
            return SklearnPredictor(
                model=obj["model"],
                feature_keys=obj["feature_keys"],
                preprocessor=obj.get("preprocessor"),
            )
        raise ValueError("pkl 은 {'model':..., 'feature_keys':[...]} 형태여야 합니다.")
    except Exception as e:  # noqa: BLE001
        print(f"[registry] {stage_id} 모델 로드 실패 → 스텁 사용 ({e})")
        return None


def build_registry(schema: Dict[str, Any]) -> Dict[str, Predictor]:
    """스키마를 읽어 stage_id → Predictor 매핑을 만든다."""
    registry: Dict[str, Predictor] = {}
    stages = sorted(schema["stages"], key=lambda s: s["order"])

    for stage in stages:
        sid = stage["id"]
        loaded = _try_load(sid)
        if loaded is not None:
            registry[sid] = loaded
            print(f"[registry] {sid}: 학습된 모델 사용")
            continue

        upstream_keys = [
            _output_key(schema, up) for up in stage.get("upstream", [])
        ]
        registry[sid] = StubPredictor(
            output_range=stage["output"]["range"],
            spec=_param_spec(stage),
            upstream_keys=upstream_keys,
        )
        print(f"[registry] {sid}: 스텁 사용")

    # 수율 모델
    ym = schema["yield_model"]
    loaded = _try_load(ym["id"])
    if loaded is not None:
        registry[ym["id"]] = loaded
        print("[registry] yield: 학습된 모델 사용")
    else:
        mode = schema["meta"].get("yield_input_mode", "hybrid")
        spec: Dict[str, Any] = {}
        upstream_keys: List[str] = []

        if mode in ("direct", "hybrid"):
            for stage in stages:
                spec.update(_param_spec(stage))
        if mode in ("chain", "hybrid"):
            upstream_keys = [s["output"]["key"] for s in stages]

        registry[ym["id"]] = StubPredictor(
            output_range=ym["output"]["range"],
            spec=spec,
            upstream_keys=upstream_keys,
        )
        print(f"[registry] yield: 스텁 사용 (input_mode={mode})")

    return registry


def _output_key(schema: Dict[str, Any], stage_id: str) -> str:
    for s in schema["stages"]:
        if s["id"] == stage_id:
            return s["output"]["key"]
    raise KeyError(stage_id)
