"""
공정 파이프라인 실행기.

schema 의 order 순서대로 모델을 돌리며, 상류 공정의 예측값을
하류 모델 입력에 자동으로 끼워 넣는다.
"""
from __future__ import annotations

from typing import Any, Dict, List


class Pipeline:
    def __init__(self, schema: Dict[str, Any], registry: Dict[str, Any]):
        self.schema = schema
        self.registry = registry
        self.stages = sorted(schema["stages"], key=lambda s: s["order"])
        self.yield_id = schema["yield_model"]["id"]
        self.yield_mode = schema["meta"].get("yield_input_mode", "hybrid")

    # ------------------------------------------------------------------
    def defaults(self) -> Dict[str, Any]:
        """모든 파라미터의 기본값 딕셔너리."""
        out: Dict[str, Any] = {}
        for stage in self.stages:
            for p in stage["params"]:
                out[p["key"]] = p["default"]
        return out

    # ------------------------------------------------------------------
    def run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        params: {param_key: value} 전체 (프론트에서 통째로 보냄)
        return: {"stages": {stage_id: {...}}, "yield": {...}}
        """
        merged = self.defaults()
        merged.update({k: v for k, v in params.items() if v is not None})

        outputs: Dict[str, float] = {}          # output_key -> 예측값
        stage_results: Dict[str, Any] = {}

        for stage in self.stages:
            sid = stage["id"]
            okey = stage["output"]["key"]

            features: Dict[str, Any] = {
                p["key"]: merged[p["key"]] for p in stage["params"]
            }
            # 상류 공정의 예측값을 0~1 로 정규화해서 주입
            for up_id in stage.get("upstream", []):
                up = self._stage(up_id)
                up_key = up["output"]["key"]
                if up_key in outputs:
                    features[up_key] = _scale(outputs[up_key], up["output"]["range"])

            value = float(self.registry[sid].predict(features))
            outputs[okey] = value
            stage_results[sid] = {
                "key": okey,
                "name": stage["output"]["name"],
                "unit": stage["output"]["unit"],
                "value": round(value, 4),
                "range": stage["output"]["range"],
                "ratio": _scale(value, stage["output"]["range"]),
            }

        # ------- 수율 모델 -------
        y_features: Dict[str, Any] = {}
        if self.yield_mode in ("direct", "hybrid"):
            y_features.update(merged)
        if self.yield_mode in ("chain", "hybrid"):
            for stage in self.stages:
                okey = stage["output"]["key"]
                y_features[okey] = _scale(outputs[okey], stage["output"]["range"])

        ycfg = self.schema["yield_model"]["output"]
        yval = float(self.registry[self.yield_id].predict(y_features))

        return {
            "stages": stage_results,
            "yield": {
                "key": ycfg["key"],
                "name": ycfg["name"],
                "unit": ycfg["unit"],
                "value": round(yval, 3),
                "range": ycfg["range"],
                "ratio": _scale(yval, ycfg["range"]),
            },
            "input_mode": self.yield_mode,
        }

    # ------------------------------------------------------------------
    def _stage(self, stage_id: str) -> Dict[str, Any]:
        for s in self.stages:
            if s["id"] == stage_id:
                return s
        raise KeyError(stage_id)


def _scale(value: float, rng: List[float]) -> float:
    lo, hi = rng
    if hi == lo:
        return 0.5
    return round(min(max((value - lo) / (hi - lo), 0.0), 1.0), 4)
