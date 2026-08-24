"""
공정 파이프라인.

흐름
  1. 프론트에서 온 파라미터 + 숨김 공정 기본값을 합친다
  2. 파생변수(Etch_Drop_10_20 등)를 계산한다
  3. 공정 순서대로 모델을 실행하고, 예측값을 그대로 컨텍스트에 넣는다
     (하류 모델이 같은 이름의 피처로 그 값을 사용)
  4. 최종 수율 모델을 실행하고 Target -> 수율(%) 로 환산한다
"""
from __future__ import annotations

from typing import Any, Dict, List

OPS = {
    "sub": lambda a, b: a - b,
    "add": lambda a, b: a + b,
}


class Pipeline:
    def __init__(self, schema: Dict[str, Any], registry: Dict[str, Any]):
        self.schema = schema
        self.registry = registry
        self.stages = sorted(schema["stages"], key=lambda s: s["order"])
        self.yield_cfg = schema["yield_model"]

        self._dtype = {}
        for st in self.stages:
            for p in st["params"]:
                self._dtype[p["key"]] = p.get("dtype", "float")

    # ------------------------------------------------------------------
    def defaults(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for st in self.stages:
            for p in st["params"]:
                out[p["key"]] = p["default"]
        return out

    def _cast(self, key: str, value: Any) -> Any:
        d = self._dtype.get(key, "float")
        try:
            if d == "int":
                return int(float(value))
            if d == "str":
                return str(value)
            return float(value)
        except (TypeError, ValueError):
            return value

    # ------------------------------------------------------------------
    def run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        ctx = self.defaults()
        ctx.update({k: v for k, v in params.items() if v is not None and k in ctx})
        ctx = {k: self._cast(k, v) for k, v in ctx.items()}

        # 파생변수
        derived_out: Dict[str, Any] = {}
        for st in self.stages:
            for d in st.get("derived", []):
                a, b = (ctx[x] for x in d["args"])
                val = OPS[d["op"]](a, b)
                ctx[d["key"]] = val
                derived_out[d["key"]] = {
                    "key": d["key"], "name": d["name"],
                    "unit": d.get("unit", ""), "value": round(float(val), 4),
                    "stage": st["id"], "after": d.get("after"),
                }

        # 공정별 모델
        stage_results: Dict[str, List[Dict[str, Any]]] = {}
        for st in self.stages:
            outs = []
            for m in st["models"]:
                val = float(self.registry[m["id"]].predict(ctx))
                okey = m["output"]["key"]
                ctx[okey] = val
                outs.append({
                    "model_id": m["id"], "key": okey,
                    "name": m["output"]["name"], "unit": m["output"]["unit"],
                    "value": round(val, 4), "range": m["output"]["range"],
                    "ratio": _scale(val, m["output"]["range"]),
                })
            if outs:
                stage_results[st["id"]] = outs

        # 최종 수율
        yc = self.yield_cfg
        target = float(self.registry[yc["id"]].predict(ctx))
        total = yc["target"]["total_dies"]
        yield_rate = (1 - target / total) * 100

        return {
            "stages": stage_results,
            "derived": derived_out,
            "target": {"key": yc["target"]["key"], "name": yc["target"]["name"],
                       "unit": yc["target"]["unit"],
                       "value": round(target, 2), "total_dies": total},
            "yield": {"key": "yield_rate", "name": yc["output"]["name"], "unit": "%",
                      "value": round(yield_rate, 3),
                      "range": yc["output"]["range"],
                      "ratio": _scale(yield_rate, yc["output"]["range"])},
        }


def _scale(value: float, rng: List[float]) -> float:
    lo, hi = rng
    if hi == lo:
        return 0.5
    return round(min(max((value - lo) / (hi - lo), 0.0), 1.0), 4)
