# 반도체 공정 수율 시뮬레이터 (프로토타입)

파라미터를 조절하면 각 공정의 출력과 최종 수율이 실시간으로 갱신되는 웹 시뮬레이터.
**모델은 아직 없으며, 스텁 예측기가 대신 동작한다.**

---

## 실행

```bash
pip install -r requirements.txt

cd backend
uvicorn app:app --reload --port 8000
```

브라우저에서 `http://localhost:8000`

---

## 구조

```
fab_sim/
├─ backend/
│  ├─ app.py              FastAPI 서버 (API + 정적 파일 서빙)
│  ├─ schema.json         ★ 공정·파라미터·범위 정의. UI가 여기서 자동 생성됨
│  ├─ pipeline.py         공정 순서대로 모델 실행, 상류 예측값 전달
│  └─ models/
│     ├─ base.py          Predictor 인터페이스 / StubPredictor / SklearnPredictor
│     ├─ registry.py      artifacts 로딩, 없으면 스텁으로 대체
│     └─ artifacts/       ★ 여기에 pkl 을 넣으면 자동 인식
└─ frontend/
   ├─ index.html
   ├─ style.css           흰색 / 검은색 / 민트만 사용
   └─ app.js              스키마 기반 UI 자동 생성
```

`schema.json` 과 `models/artifacts/` 두 곳만 건드리면 된다.

---

## 모델 연결 방법

학습이 끝나면 다음 형식으로 저장한다.

```python
import joblib

joblib.dump({
    "model": trained_model,              # .predict(X) 가 있는 객체
    "feature_keys": ["ox_temp", "ox_time", "ox_o2_flow", "ox_pressure", "ox_chamber"],
    "preprocessor": encoder_or_scaler,   # 선택
}, "backend/models/artifacts/oxidation.pkl")
```

| 파일명 | 대상 모델 |
|---|---|
| `oxidation.pkl` | 1. 산화막 두께 |
| `soft_bake.pkl` | 2. 레지스트 균일도 |
| `lithography.pkl` | 3. Line CD |
| `etch.pkl` | 4. Thin F4 |
| `implant.pkl` | 5. 주입 이온량 |
| `yield.pkl` | 6. 최종 수율 |

넣은 뒤 `POST /api/reload` 를 호출하면 서버 재시작 없이 반영된다.
파일이 없거나 로드에 실패하면 자동으로 스텁으로 되돌아간다.

### 상류 예측값의 전달 규칙

`schema.json` 의 `upstream` 에 적힌 공정의 출력이
**해당 공정의 output key 이름으로, 0~1 정규화되어** 피처에 추가된다.

예: `lithography` 모델의 `feature_keys`

```python
["Energy_Exposure", "Resolution", "UV_type", "lithography_Chamber",
 "oxide_thickness", "resist_target"]   # ← 상류 2개, 0~1 스케일
```

---

## 수율 모델 입력 방식 전환

`schema.json` → `meta.yield_input_mode` 한 줄로 바꾼다.

| 값 | 수율 모델 입력 | 용도 |
|---|---|---|
| `chain` | 1~5번 예측값만 | 오차 전파 영향 확인 |
| `direct` | 원본 파라미터 전체 | 베이스라인 |
| `hybrid` | 둘 다 (기본값) | 권장 |

세 가지를 모두 학습해 성능을 비교한 뒤 최종안을 고정하면 된다.

---

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/schema` | UI 생성용 설정 |
| GET | `/api/defaults` | 기본값 + 초기 예측 |
| POST | `/api/predict` | `{"params": {...}}` → 전 공정 예측 + 수율 |
| POST | `/api/reload` | 스키마·모델 재로딩 |
| GET | `/api/health` | 상태 확인 |

---

## 데이터셋이 바뀌면

`build_schema.py` 를 다시 돌리면 된다. 슬라이더 범위는 실제 데이터의
min / max, 기본값은 중앙값(median)으로 자동 설정된다.

```bash
cd backend
python build_schema.py --data /경로/데이터폴더 --out schema.json
```

컬럼 구성이 바뀌었다면 `build_schema.py` 상단의 `STAGES` 딕셔너리에서
`params` / `output` 목록만 수정한다. 프론트엔드는 손댈 필요가 없다.

### 현재 매핑

| 공정 | 파일 | 출력(예측 대상) | 파라미터 수 |
|---|---|---|---|
| 산화 | Oxidation.csv | `thickness` | 6 |
| Soft Bake | Photo_softbake.csv | `resist_target` | 12 |
| Lithography | Photo_lithograpy.csv | `Line_CD` | 4 |
| 식각 | Etching.csv | `Thin F4` | 4 |
| 이온 주입 | Ion_Implantation.csv | `Flux160s` (임시) | 5 |
| 수율 | — | 정답 데이터 미확정 (표시 범위 0~100%) | — |

### UI 에서 제외한 컬럼

| 컬럼 | 이유 |
|---|---|
| `Vapor` | `type` 과 1:1 대응 (dry=O2, wet=H2O) |
| `Wavelength` | `UV_type` 과 1:1 대응 (G=436, H=405, I=365) |
| `Thin F1~F3` | 남은 박막 두께(계측 결과). F4 만 예측 대상 |
| `Flux60s/90s/480s/840s` | 계측 결과. 840s 는 상수 |
| `process`, `process 2`, `Process 2-1`, `Process 3`, `process4` | 단일값 (분산 0) |
