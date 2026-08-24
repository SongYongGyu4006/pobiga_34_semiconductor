# 반도체 공정 수율 시뮬레이터

파라미터를 조절하면 각 공정의 예측값과 최종 수율이 실시간으로 갱신된다.

---

## 실행

```bash
pip install -r requirements.txt

# 모델 6개를 backend/models/artifacts/ 에 넣은 뒤
cd backend
uvicorn app:app --port 8000
```

브라우저에서 `http://localhost:8000`

모델 총 용량이 약 2GB 이므로 첫 기동에 20~30초가 걸린다.
`--reload` 는 파일이 바뀔 때마다 모델을 다시 읽으므로 개발 중에도 끄는 편이 낫다.

---

## 모델 연결 구조

| # | 모델 | 입력 | 출력 |
|---|---|---|---|
| 1 | oxidation | 산화 파라미터 | `Ox_Thickness` |
| 2 | softbake | 산화 파라미터 + `Ox_Thickness` + 소프트베이크 파라미터 | `resist_uniformity` |
| 3 | lithography | 위 전부 + 리소 파라미터 | `CD` |
| 4 | etch_total | 위 전부 + 식각 파라미터(선택비 제외) | `Etch_Total_Drop` |
| 5 | etch_selectivity | 위 전부 + `Etch_Total_Drop` | `Selectivity` |
| 6 | final_target | 위 전부 + 이온 주입 파라미터 (`Selectivity` 제외) | `Target` |

상류 예측값은 **출력 컬럼 이름 그대로** 컨텍스트에 들어가므로,
하류 모델의 `feature_names_in_` 에 그 이름이 있으면 자동으로 연결된다.

수율(%) = `(1 - Target / 533) x 100`

---

## 식각 공정의 파생변수

프론트에서 사용자가 조절하는 값은 **박막 두께 F1 / F2 / F3** 이고,
모델이 쓰는 값은 구간 식각량이다. 파이프라인이 자동 계산한다.

| 파생값 | 계산식 |
|---|---|
| `Etch_Drop_10_20` | F1 − F2 |
| `Etch_Drop_20_30` | F2 − F3 |
| `Etch_Total_Drop` | 4번 모델의 예측값 |

파생값은 화면에 `AUTO` 표시와 함께 읽기 전용으로 나타나며,
F1~F3 슬라이더를 움직여야 변한다.

---

## 이온 주입 공정

**예측 모델이 없는 공정**이다. 조절한 값은 중간 예측 없이
최종 수율 모델의 입력으로 바로 들어간다.

| 항목 | 내용 |
|---|---|
| 조절 파라미터 | 가속 에너지 · 주입 온도 · 노 온도 · RTA 온도 · 챔버 |
| 예측 출력 | 없음 (카드 우측에 "예측 모델 없음" 표기) |
| Flux 계열 | UI 에서 제외 |

`build_schema.py` 의 `implant` 스테이지에 `optional` 목록이 있어,
`Current` / `Beam_Current` / `Ion_Current` 컬럼이 데이터에 생기면
스키마를 다시 생성할 때 자동으로 슬라이더가 추가된다.

---

## UI 에 없는 모델 피처의 처리

`schema.json` 의 `constants` 에 전체 컬럼의 중앙값(범주는 최빈값)이 저장된다.
모델이 요구하는 피처 중 화면에 없는 것은 이 값으로 채운다.

현재 `final_target_model.pkl` 은 Flux 5개를 학습 피처로 갖고 있어
서버 기동 시 다음 로그가 뜬다.

```
[models] yield: UI 밖 피처를 상수로 채움 → ['Flux60s', ..., 'Flux840s']
```

Flux 를 제외하고 재학습한 모델로 교체하면 이 로그는 사라지고,
코드는 수정할 필요가 없다.

---

## 데이터가 바뀌면

```bash
cd backend
python build_schema.py \
  --merged /경로/merged_all_processes_derived.csv \
  --etching /경로/Etching.csv \
  --out schema.json
```

슬라이더 범위는 데이터의 min/max, 기본값은 중앙값으로 다시 잡힌다.
프론트엔드 코드는 수정할 필요가 없다.

---

## 구조

```
backend/
  app.py             FastAPI 서버
  schema.json        공정·파라미터·모델 연결 정의 (자동 생성)
  build_schema.py    CSV -> schema.json
  pipeline.py        모델 실행 순서, 파생변수 계산, 수율 환산
  models/
    base.py          Predictor / SklearnPredictor / StubPredictor
    artifacts/       ★ pkl 6개
frontend/
  index.html
  app.js             스키마 기반 UI 자동 생성
  style.css
  posco.png
```

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/schema` | UI 설정 (숨김 공정 제외) |
| GET | `/api/defaults` | 기본값 + 초기 예측 |
| POST | `/api/predict` | `{"params": {...}}` → 전 공정 예측 |
| POST | `/api/reload` | 스키마·모델 재로딩 |
| GET | `/api/health` | 모델 연결 상태 |
