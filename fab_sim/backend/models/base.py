"""
예측기(Predictor) 인터페이스.

실제 모델을 붙일 때는 SklearnPredictor 를 쓰거나,
Predictor 를 상속한 클래스를 새로 만들어 registry 에 등록하면 된다.
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
from typing import Any, Dict, List


class Predictor(ABC):
    """모든 예측기가 지켜야 하는 최소 규약."""

    #: 이 예측기가 필요로 하는 피처 키 목록 (순서 고정)
    feature_keys: List[str] = []

    @abstractmethod
    def predict(self, features: Dict[str, Any]) -> float:
        """피처 딕셔너리를 받아 스칼라 예측값을 반환."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# 스텁 (모델이 아직 없을 때 UI 동작 확인용)
# ---------------------------------------------------------------------------
class StubPredictor(Predictor):
    """
    학습된 모델이 없을 때 쓰는 임시 예측기.

    모든 피처를 0~1 로 정규화한 뒤 가중합 → 로지스틱 변환 → 출력 범위로 매핑한다.
    실제 물리와는 무관하지만 슬라이더를 움직이면 값이 부드럽게 변하므로
    프론트엔드 동작을 검증할 수 있다.
    """

    def __init__(self, output_range, spec: Dict[str, Any], upstream_keys: List[str] = None):
        self.lo, self.hi = output_range
        self.spec = spec                      # {key: {"min":..,"max":..} or {"options":[..]}}
        self.upstream_keys = upstream_keys or []
        self.feature_keys = list(spec.keys()) + self.upstream_keys

        # 키 이름 해시로 결정적 가중치 생성 (실행할 때마다 동일)
        self._w = {}
        for i, k in enumerate(self.feature_keys):
            h = sum(ord(ch) for ch in k)
            self._w[k] = math.sin(h * 0.7 + i) * (1.0 if k not in self.upstream_keys else 0.6)

    # -- 내부 유틸 ----------------------------------------------------------
    def _norm(self, key: str, value: Any) -> float:
        meta = self.spec.get(key)
        if meta is None:                       # upstream 값: 이미 0~1 로 넘어온다
            return float(value)
        if "options" in meta:
            opts = meta["options"]
            idx = opts.index(str(value)) if str(value) in opts else 0
            return idx / max(len(opts) - 1, 1)
        lo, hi = meta["min"], meta["max"]
        if hi == lo:
            return 0.5
        return min(max((float(value) - lo) / (hi - lo), 0.0), 1.0)

    # -- 규약 ---------------------------------------------------------------
    def predict(self, features: Dict[str, Any]) -> float:
        z = 0.0
        for k in self.feature_keys:
            if k not in features:
                continue
            z += self._w[k] * (self._norm(k, features[k]) - 0.5)
        score = 1.0 / (1.0 + math.exp(-2.2 * z))          # 0~1
        return self.lo + score * (self.hi - self.lo)


# ---------------------------------------------------------------------------
# 실제 모델용 어댑터
# ---------------------------------------------------------------------------
class SklearnPredictor(Predictor):
    """
    joblib 로 저장한 sklearn / xgboost / lightgbm 모델을 감싼다.

        import joblib
        joblib.dump({"model": model, "feature_keys": [...]}, "artifacts/oxidation.pkl")

    dict 대신 모델 객체만 저장했다면 feature_keys 를 인자로 넘기면 된다.
    """

    def __init__(self, model, feature_keys: List[str], preprocessor=None):
        self.model = model
        self.feature_keys = feature_keys
        self.preprocessor = preprocessor

    def predict(self, features: Dict[str, Any]) -> float:
        row = [features.get(k) for k in self.feature_keys]
        X = [row]
        if self.preprocessor is not None:
            X = self.preprocessor.transform(X)
        return float(self.model.predict(X)[0])
