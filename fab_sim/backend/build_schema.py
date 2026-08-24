"""
merged_all_processes_derived.csv 에서 schema.json 을 생성한다.

    python build_schema.py --merged /경로/merged_all_processes_derived.csv \
                           --etching /경로/Etching.csv --out schema.json

슬라이더 범위 = 실제 데이터 min/max, 기본값 = 중앙값.
파라미터 key 는 학습된 모델의 feature 이름과 동일해야 한다.
"""
from __future__ import annotations

import argparse
import json

import pandas as pd

# ---------------------------------------------------------------------------
# 공정 정의
#   params  : 프론트에서 조절하는 값 (모델 피처명 그대로)
#   ui_only : 모델이 직접 쓰지 않고, 파생값 계산에만 쓰이는 파라미터
#   derived : ui_only 파라미터로부터 계산되는 모델 입력값
#   models  : 이 공정에서 순서대로 실행할 모델
#   hidden  : true 면 프론트에 표시하지 않음 (기본값만 모델에 전달)
# ---------------------------------------------------------------------------
STAGES = [
    {
        "id": "oxidation", "name": "산화 공정", "order": 1,
        "params": ["Ox_Temp", "Ox_ppm", "Ox_Pressure", "Ox_Time", "Ox_Type", "Ox_Chamber"],
        "models": [{"id": "oxidation", "pkl": "oxidation_model.pkl",
                    "output": ("Ox_Thickness", "산화막 두께", "Å")}],
    },
    {
        "id": "soft_bake", "name": "Photo Soft Bake", "order": 2,
        "params": ["temp_HMDS_bake", "time_HMDS_bake", "N2_HMDS", "pressure_HMDS", "temp_HMDS",
                   "spin1_rpm", "spin2_rpm", "spin3_rpm", "PR_amount",
                   "temp_softbake", "time_softbake", "photo_soft_Chamber"],
        "models": [{"id": "soft_bake", "pkl": "softbake_model.pkl",
                    "output": ("resist_uniformity", "레지스트 균일도", "")}],
    },
    {
        "id": "lithography", "name": "Photo Lithography", "order": 3,
        "params": ["Energy_Exposure", "Resolution", "UV_type", "litho_Chamber"],
        "models": [{"id": "lithography", "pkl": "lithography_model.pkl",
                    "output": ("CD", "회로 선폭 (CD)", "nm")}],
    },
    {
        "id": "etch", "name": "식각 공정", "order": 4,
        "params": ["Thin_F1", "Thin_F2", "Thin_F3", "Temp_Etching", "Source_Power", "Etching_Chamber"],
        "ui_only": ["Thin_F1", "Thin_F2", "Thin_F3"],
        "derived": [
            {"key": "Etch_Drop_10_20", "name": "구간 식각량 (F1→F2)", "unit": "Å",
             "op": "sub", "args": ["Thin_F1", "Thin_F2"], "after": "Thin_F2"},
            {"key": "Etch_Drop_20_30", "name": "구간 식각량 (F2→F3)", "unit": "Å",
             "op": "sub", "args": ["Thin_F2", "Thin_F3"], "after": "Thin_F3"},
        ],
        "models": [
            {"id": "etch_total", "pkl": "etch_total_drop_model.pkl",
             "output": ("Etch_Total_Drop", "전체 식각량", "Å")},
            {"id": "etch_selectivity", "pkl": "etch_selectivity_model.pkl",
             "output": ("Selectivity", "선택비", "")},
        ],
    },
    {
        "id": "implant", "name": "이온 주입 공정", "order": 5,
        "params": ["Ion_Energy", "Ion_Temp", "Furnace_Temp", "RTA_Temp", "Ion_Chamber"],
        # 데이터에 있을 때만 추가되는 파라미터 (예: 빔 전류)
        "optional": ["Current", "Beam_Current", "Ion_Current"],
        "models": [],
        "note": "예측 모델 없음. 조절값은 최종 수율 모델 입력에 직접 반영",
    },
]

YIELD = {
    "pkl": "final_target_model.pkl",
    "target_key": "Target",
    "target_name": "예상 결함 Die",
    "total_dies": 533,          # 수율(%) = (1 - Target / total_dies) x 100
}

KOR = {
    "Ox_Temp": "산화 온도", "Ox_ppm": "가스 농도", "Ox_Pressure": "챔버 압력",
    "Ox_Time": "산화 시간", "Ox_Type": "산화 방식", "Ox_Chamber": "챔버",
    "temp_HMDS_bake": "HMDS 베이크 온도", "time_HMDS_bake": "HMDS 베이크 시간",
    "N2_HMDS": "N₂ 유량", "pressure_HMDS": "HMDS 압력", "temp_HMDS": "HMDS 온도",
    "spin1_rpm": "스핀 1단", "spin2_rpm": "스핀 2단", "spin3_rpm": "스핀 3단",
    "PR_amount": "PR 도포량", "temp_softbake": "소프트베이크 온도",
    "time_softbake": "소프트베이크 시간", "photo_soft_Chamber": "챔버",
    "Energy_Exposure": "노광량", "Resolution": "해상도", "UV_type": "광원",
    "litho_Chamber": "챔버",
    "Thin_F1": "박막 두께 F1", "Thin_F2": "박막 두께 F2", "Thin_F3": "박막 두께 F3",
    "Temp_Etching": "식각 온도", "Source_Power": "Source Power", "Etching_Chamber": "챔버",
    "Ion_Energy": "가속 에너지", "Ion_Temp": "주입 온도", "Furnace_Temp": "노 온도",
    "RTA_Temp": "RTA 온도", "Ion_Chamber": "챔버",
    "Current": "빔 전류", "Beam_Current": "빔 전류", "Ion_Current": "빔 전류",
}

UNIT = {
    "Ox_Temp": "℃", "Ox_ppm": "ppm", "Ox_Pressure": "Torr", "Ox_Time": "min",
    "temp_HMDS_bake": "℃", "time_HMDS_bake": "sec", "N2_HMDS": "sccm",
    "pressure_HMDS": "Torr", "temp_HMDS": "℃",
    "spin1_rpm": "rpm", "spin2_rpm": "rpm", "spin3_rpm": "rpm",
    "temp_softbake": "℃", "time_softbake": "sec",
    "Energy_Exposure": "mJ/cm²", "Resolution": "nm",
    "Thin_F1": "Å", "Thin_F2": "Å", "Thin_F3": "Å",
    "Temp_Etching": "℃", "Source_Power": "W",
    "Ion_Energy": "eV", "Ion_Temp": "℃", "Furnace_Temp": "℃", "RTA_Temp": "℃",
    "Current": "mA", "Beam_Current": "mA", "Ion_Current": "mA",
}

CATEGORICAL = {"Ox_Type", "UV_type", "Ox_Chamber", "photo_soft_Chamber",
               "litho_Chamber", "Etching_Chamber", "Ion_Chamber"}

# 프론트 파라미터명 -> 원본 CSV 컬럼명 (Thin F 는 Etching.csv 에만 존재)
SOURCE_COL = {"Thin_F1": "Thin F1", "Thin_F2": "Thin F2", "Thin_F3": "Thin F3"}


def nice_step(lo: float, hi: float) -> float:
    span = hi - lo
    if span <= 0:
        return 1.0
    for s in (0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 1e4, 1e5, 1e15, 1e16):
        if span / s <= 400:
            return s
    return span / 200


def build_param(series: pd.Series, key: str) -> dict:
    s = series.dropna()
    base = {"key": key, "name": KOR.get(key, key), "unit": UNIT.get(key, "")}

    if key in CATEGORICAL:
        is_int = pd.api.types.is_integer_dtype(s)
        opts = sorted(s.unique().tolist(), key=lambda v: (str(type(v)), v))
        base.update(type="category", dtype="int" if is_int else "str",
                    options=[str(v) for v in opts],
                    default=str(s.mode().iloc[0]))
        return base

    lo, hi = float(s.min()), float(s.max())
    base.update(type="number",
                dtype="int" if pd.api.types.is_integer_dtype(s) else "float",
                min=round(lo, 6), max=round(hi, 6),
                default=round(float(s.median()), 6), step=nice_step(lo, hi))
    return base


def main(merged_path: str, etching_path: str, out_path: str) -> None:
    mg = pd.read_csv(merged_path)
    et = pd.read_csv(etching_path)

    def series(key: str) -> pd.Series:
        col = SOURCE_COL.get(key, key)
        if col in mg.columns:
            return mg[col]
        return et[col]

    stages = []
    for cfg in STAGES:
        keys = list(cfg["params"])
        for k in cfg.get("optional", []):
            if k in mg.columns or k in et.columns:
                keys.append(k)
                print(f"  · optional 파라미터 추가: {k}")
        params = [build_param(series(k), k) for k in keys]

        models = []
        for m in cfg["models"]:
            okey, oname, ounit = m["output"]
            o = mg[okey].dropna()
            models.append({
                "id": m["id"], "pkl": m["pkl"],
                "output": {"key": okey, "name": oname, "unit": ounit,
                           "range": [round(float(o.min()), 6), round(float(o.max()), 6)],
                           "median": round(float(o.median()), 6)},
            })

        stages.append({
            "id": cfg["id"], "name": cfg["name"], "order": cfg["order"],
            "hidden": bool(cfg.get("hidden", False)),
            "note": cfg.get("note", ""),
            "ui_only": cfg.get("ui_only", []),
            "derived": cfg.get("derived", []),
            "params": params,
            "models": models,
        })
        print(f"[{cfg['id']}] params={len(params)} models={[m['id'] for m in models]}"
              f"{' (hidden)' if cfg.get('hidden') else ''}")

    tgt = mg[YIELD["target_key"]].dropna()
    total = YIELD["total_dies"]
    y = (1 - tgt / total) * 100
    print(f"[yield] Target {tgt.min():.0f}~{tgt.max():.0f} → 수율 {y.min():.2f}~{y.max():.2f}%")

    # UI 에 없는 모델 피처를 채우기 위한 상수 (수치=중앙값, 범주=최빈값)
    constants = {}
    for col in mg.columns:
        s_col = mg[col].dropna()
        if s_col.empty:
            continue
        if pd.api.types.is_numeric_dtype(s_col):
            v = float(s_col.median())
            constants[col] = int(v) if pd.api.types.is_integer_dtype(s_col) else v
        else:
            constants[col] = str(s_col.mode().iloc[0])
    print(f"[constants] {len(constants)}개 컬럼 기본값 저장")

    schema = {
        "meta": {
            "title": "반도체 공정 수율 시뮬레이터",
            "generated_from": merged_path,
        },
        "constants": constants,
        "stages": stages,
        "yield_model": {
            "id": "yield", "pkl": YIELD["pkl"],
            "name": "최종 수율",
            "target": {"key": YIELD["target_key"], "name": YIELD["target_name"],
                       "unit": "개", "total_dies": total,
                       "range": [float(tgt.min()), float(tgt.max())]},
            "output": {"key": "yield_rate", "name": "예측 수율", "unit": "%",
                       "range": [round(float(y.min()), 3), 100.0]},
        },
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(schema, f, ensure_ascii=False, indent=2)
    print(f"\n→ {out_path} 생성 완료")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--merged", default="../data/merged_all_processes_derived.csv")
    ap.add_argument("--etching", default="../data/Etching.csv")
    ap.add_argument("--out", default="schema.json")
    a = ap.parse_args()
    main(a.merged, a.etching, a.out)
