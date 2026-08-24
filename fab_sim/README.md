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

출력 변수가 확정되지 않아 **프론트에서는 표시하지 않는다.**
다만 최종 수율 모델의 입력에는 필요하므로, `schema.json` 의
`implant` 스테이지가 `hidden: true` 로 남아 기본값(중앙값)을 계속 전달한다.

다시 노출하려면 `build_schema.py` 의 `STAGES` 에서 `"hidden": True` 를 지우고
`models` 에 항목을 추가한 뒤 스키마를 다시 생성하면 된다.

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

## 챔버 경로 추천

파라미터를 조절하면, **그 파라미터가 속한 공정부터 마지막 공정까지**의
챔버 조합을 전수 탐색해 수율이 가장 높은 경로를 추천한다.
앞선 공정의 챔버는 현재 선택값 그대로 고정한다.

| 조절한 공정 | 탐색 대상 | 조합 수 |
|---|---|---|
| 산화 | 산화 → 식각 (4개) | 3⁴ = 81 |
| Soft Bake | Soft Bake → 식각 (3개) | 27 |
| Lithography | Litho → 식각 (2개) | 9 |
| 식각 | 식각 (1개) | 3 |
| 이온 주입 | 식각 (연동) | 3 |

81개 조합도 **0.2초 이내**에 끝난다. 한 건씩 돌리지 않고
모델마다 전체 조합을 한 번에 예측(`Pipeline.run_frame`)하기 때문이다.

### 이온 챔버 연동

원본 데이터에서 `Ion_Chamber` 와 `Etching_Chamber` 의 값이 **100% 일치**한다.
두 챔버를 독립적으로 조합하면 학습 데이터에 없는 경로를 추천하게 되므로,
`build_schema.py` 의 `MIRROR` 설정으로 묶었다.

```python
MIRROR = {"Ion_Chamber": "Etching_Chamber"}
```

| 반영 위치 | 동작 |
|---|---|
| `Pipeline.merge` | 항상 `Ion_Chamber = Etching_Chamber` 로 덮어씀 |
| 챔버 경로 탐색 | 이온 챔버를 차원에서 제외 (243 → 81) |
| 프론트 | `LINK` 배지가 붙은 읽기 전용 버튼. 식각 챔버를 따라 자동 변경 |

다른 컬럼 쌍에서 같은 문제가 발견되면 `MIRROR` 에 추가하고
스키마를 다시 생성하면 된다. 생성 시 일치율이 로그로 출력된다.

`추천 경로 적용` 버튼을 누르면 챔버 버튼이 실제로 바뀌고 예측이 다시 돈다.

### API

```
POST /api/recommend
{ "params": {...}, "from_stage": "etch", "top_n": 5 }
```

`from_stage` 를 생략하면 첫 공정부터 전체를 탐색한다.

---

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/schema` | UI 설정 (숨김 공정 제외) |
| GET | `/api/defaults` | 기본값 + 초기 예측 |
| POST | `/api/predict` | `{"params": {...}}` → 전 공정 예측 |
| POST | `/api/reload` | 스키마·모델 재로딩 |
| GET | `/api/health` | 모델 연결 상태 |
