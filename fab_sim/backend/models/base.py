"""
학습된 sklearn Pipeline 을 감싸는 어댑터와, 모델이 없을 때 쓰는 스텁.

모델은 ColumnTransformer(OneHotEncoder) + ExtraTreesRegressor 파이프라인이며
DataFrame 을 그대로 받는다. 필요한 컬럼 목록은 pipeline.feature_names_in_ 에서 읽는다.
"""
from __future__ import annotations

import math
import os
from typing import Any, Dict, List

import pandas as pd

ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")


class Predictor:
    feature_keys: List[str] = []

    def predict(self, ctx: Dict[str, Any]) -> float:
        raise NotImplementedError

    def predict_frame(self, df: "pd.DataFrame"):
        """여러 조합을 한 번에 예측 (챔버 경로 탐색용)."""
        raise NotImplementedError


class SklearnPredictor(Predictor):
    """
    DataFrame 한 행을 만들어 파이프라인에 넣는다.

    UI 에 없는 피처(예: 학습에서만 쓰인 Flux 계열)는 schema 의 constants
    에 저장된 기본값으로 채운다. 따라서 모델을 재학습해 피처가 줄어들어도
    코드 수정 없이 그대로 동작한다.
    """

    def __init__(self, name: str, pipeline, feature_keys: List[str],
                 constants: Dict[str, Any] | None = None):
        self.name = name
        self.pipeline = pipeline
        self.feature_keys = feature_keys
        self.constants = constants or {}
        self._warned = False

    def predict(self, ctx: Dict[str, Any]) -> float:
        row, filled = {}, []
        for k in self.feature_keys:
            if k in ctx:
                row[k] = [ctx[k]]
            elif k in self.constants:
                row[k] = [self.constants[k]]
                filled.append(k)
            else:
                raise KeyError(f"[{self.name}] 입력도 상수도 없는 피처: {k}")

        if filled and not self._warned:
            print(f"[models] {self.name}: UI 밖 피처를 상수로 채움 → {filled}")
            self._warned = True

        X = pd.DataFrame(row, columns=self.feature_keys)
        return float(self.pipeline.predict(X)[0])

    def predict_frame(self, df: pd.DataFrame):
        cols = {}
        for k in self.feature_keys:
            if k in df.columns:
                cols[k] = df[k].values
            elif k in self.constants:
                cols[k] = [self.constants[k]] * len(df)
            else:
                raise KeyError(f"[{self.name}] 입력도 상수도 없는 피처: {k}")
        X = pd.DataFrame(cols, columns=self.feature_keys, index=df.index)
        return self.pipeline.predict(X)


class StubPredictor(Predictor):
    """모델 파일이 없을 때 UI 동작 확인용. 실제 물리와 무관."""

    def __init__(self, output_range, feature_keys: List[str], spec: Dict[str, Any]):
        self.lo, self.hi = output_range
        self.feature_keys = feature_keys
        self.spec = spec
        self._w = {k: math.sin(sum(ord(c) for c in k) * 0.7 + i)
                   for i, k in enumerate(feature_keys)}

    def _norm(self, key: str, value: Any) -> float:
        meta = self.spec.get(key)
        if meta is None:
            return 0.5
        if meta.get("type") == "category":
            opts = meta["options"]
            v = str(value)
            return (opts.index(v) if v in opts else 0) / max(len(opts) - 1, 1)
        lo, hi = meta["min"], meta["max"]
        if hi == lo:
            return 0.5
        try:
            return min(max((float(value) - lo) / (hi - lo), 0.0), 1.0)
        except (TypeError, ValueError):
            return 0.5

    def predict(self, ctx: Dict[str, Any]) -> float:
        z = sum(self._w[k] * (self._norm(k, ctx.get(k)) - 0.5) for k in self.feature_keys)
        return self.lo + (1 / (1 + math.exp(-2.2 * z))) * (self.hi - self.lo)

    def predict_frame(self, df: pd.DataFrame):
        return [self.predict(r) for r in df.to_dict("records")]


def _feature_names(pipeline) -> List[str]:
    for obj in (pipeline, getattr(pipeline, "named_steps", {}).get("preprocessor")):
        names = getattr(obj, "feature_names_in_", None)
        if names is not None:
            return list(names)
    raise ValueError("feature_names_in_ 를 찾을 수 없습니다.")


def load_model(model_id: str, pkl_name: str, constants: Dict[str, Any]):
    """artifacts/{pkl_name} 로드. 없거나 실패하면 None."""
    path = os.path.join(ARTIFACT_DIR, pkl_name)
    if not os.path.exists(path):
        return None
    try:
        import joblib
        pipe = joblib.load(path)
        return SklearnPredictor(model_id, pipe, _feature_names(pipe), constants)
    except Exception as e:  # noqa: BLE001
        print(f"[models] {pkl_name} 로드 실패 → 스텁 사용 ({e})")
        return None


def build_registry(schema: Dict[str, Any]) -> Dict[str, Predictor]:
    """model_id -> Predictor"""
    spec: Dict[str, Any] = {}
    for st in schema["stages"]:
        for p in st["params"]:
            spec[p["key"]] = p

    constants = schema.get("constants", {})
    reg: Dict[str, Predictor] = {}

    entries = [(m, m["output"]["range"]) for st in schema["stages"] for m in st["models"]]
    ym = schema["yield_model"]
    entries.append(({"id": ym["id"], "pkl": ym["pkl"]}, ym["target"]["range"]))

    for m, rng in entries:
        loaded = load_model(m["id"], m["pkl"], constants)
        if loaded is not None:
            reg[m["id"]] = loaded
            print(f"[models] {m['id']:18s} 학습 모델 ({len(loaded.feature_keys)} features)")
        else:
            reg[m["id"]] = StubPredictor(rng, list(spec.keys()), spec)
            print(f"[models] {m['id']:18s} 스텁")

    return reg
