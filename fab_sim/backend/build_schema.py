"""
CSV 원본에서 schema.json 을 생성한다.

데이터셋이 바뀌면 DATA_DIR 만 맞춰놓고 이 스크립트를 다시 돌리면 된다.
슬라이더 범위는 실제 데이터의 min / max, 기본값은 중앙값(median)을 쓴다.

    python build_schema.py --data ../../data --out schema.json
"""
from __future__ import annotations

import argparse
import json
import os

import pandas as pd

# ---------------------------------------------------------------------------
# 공정 정의 : 어떤 컬럼이 "조절 가능한 파라미터"이고 어떤 것이 "예측 대상"인가
#   params   : 슬라이더/선택 버튼으로 노출할 컬럼
#   output   : 해당 공정 모델이 예측할 컬럼
#   exclude  : 파일에는 있지만 UI 에 올리지 않는 컬럼 (계측 결과, 상수, 키 등)
# ---------------------------------------------------------------------------
STAGES = [
    {
        "id": "oxidation", "name": "산화 공정", "order": 1, "file": "Oxidation.csv",
        "output": {"col": "thickness", "name": "산화막 두께", "unit": "Å"},
        "params": ["Temp_OXid", "ppm", "Pressure", "Oxid_time", "type", "Ox_Chamber"],
        "upstream": [],
        "note": "Vapor 는 type 과 1:1 대응(dry=O2, wet=H2O)이라 제외",
    },
    {
        "id": "soft_bake", "name": "Photo Soft Bake", "order": 2, "file": "Photo_softbake.csv",
        "output": {"col": "resist_target", "name": "레지스트 균일도", "unit": ""},
        "params": ["temp_HMDS_bake", "time_HMDS_bake", "N2_HMDS", "pressure_HMDS", "temp_HMDS",
                   "spin1", "spin2", "spin3", "photoresist_bake",
                   "temp_softbake", "time_softbake", "photo_soft_Chamber"],
        "upstream": ["oxidation"],
    },
    {
        "id": "lithography", "name": "Photo Lithography", "order": 3, "file": "Photo_lithograpy.csv",
        "output": {"col": "Line_CD", "name": "회로 선폭 (Line CD)", "unit": "nm"},
        "params": ["Energy_Exposure", "Resolution", "UV_type", "lithography_Chamber"],
        "upstream": ["oxidation", "soft_bake"],
        "note": "Wavelength 는 UV_type 과 1:1 대응이라 제외",
    },
    {
        "id": "etch", "name": "식각 공정", "order": 4, "file": "Etching.csv",
        "output": {"col": "Thin F4", "name": "잔여 산화막 두께 (Thin F4)", "unit": "Å"},
        "params": ["Temp_Etching", "Source_Power", "Selectivity", "Etching_Chamber"],
        "upstream": ["oxidation", "soft_bake", "lithography"],
        "note": "Thin F1~F3 도 남은 박막 두께(계측 결과)이므로 파라미터에서 제외. F4 음수는 과식각",
    },
    {
        "id": "implant", "name": "이온 주입 공정", "order": 5, "file": "Ion_Implantation.csv",
        "output": {"col": "Flux160s", "name": "주입 이온량", "unit": "ions/cm²"},  # 임시 지정
        "params": ["input_Energy", "Temp_implantation", "Furance_Temp", "RTA_Temp", "Chamber_Num"],
        "upstream": ["oxidation", "soft_bake", "lithography", "etch"],
        "note": "출력 컬럼은 임시로 Flux160s 지정. 확정되면 output.col 만 교체",
    },
]

# 수율은 아직 정답 데이터가 확정되지 않아 표시 범위만 고정해 둔다.
# 학습 데이터가 정해지면 range 를 실제 분포로 바꾸면 된다.
YIELD = {
    "id": "yield",
    "name": "최종 수율",
    "unit": "%",
    "range": [0.0, 100.0],
}

KOR = {
    "Temp_OXid": "산화 온도", "ppm": "가스 농도", "Pressure": "챔버 압력",
    "Oxid_time": "산화 시간", "type": "산화 방식", "Ox_Chamber": "챔버",
    "temp_HMDS_bake": "HMDS 베이크 온도", "time_HMDS_bake": "HMDS 베이크 시간",
    "N2_HMDS": "N₂ 유량", "pressure_HMDS": "HMDS 압력", "temp_HMDS": "HMDS 온도",
    "spin1": "스핀 1단", "spin2": "스핀 2단", "spin3": "스핀 3단",
    "photoresist_bake": "PR 베이크", "temp_softbake": "소프트베이크 온도",
    "time_softbake": "소프트베이크 시간", "photo_soft_Chamber": "챔버",
    "Energy_Exposure": "노광량", "Resolution": "해상도", "UV_type": "광원",
    "lithography_Chamber": "챔버",
    "Temp_Etching": "식각 온도", "Source_Power": "Source Power",
    "Selectivity": "선택비", "Etching_Chamber": "챔버",
    "input_Energy": "가속 에너지", "Temp_implantation": "주입 온도",
    "Furance_Temp": "노 온도", "RTA_Temp": "RTA 온도", "Chamber_Num": "챔버",
}

UNIT = {
    "Temp_OXid": "℃", "ppm": "ppm", "Pressure": "Torr", "Oxid_time": "min",
    "temp_HMDS_bake": "℃", "time_HMDS_bake": "sec", "N2_HMDS": "sccm",
    "pressure_HMDS": "Torr", "temp_HMDS": "℃",
    "spin1": "rpm", "spin2": "rpm", "spin3": "rpm",
    "temp_softbake": "℃", "time_softbake": "sec",
    "Energy_Exposure": "mJ/cm²", "Resolution": "nm",
    "Temp_Etching": "℃", "Source_Power": "W",
    "input_Energy": "eV", "Temp_implantation": "℃",
    "Furance_Temp": "℃", "RTA_Temp": "℃",
}

CATEGORICAL = {"type", "UV_type", "Ox_Chamber", "photo_soft_Chamber",
               "lithography_Chamber", "Etching_Chamber", "Chamber_Num"}


def nice_step(lo: float, hi: float) -> float:
    """범위에 맞는 적당한 슬라이더 간격."""
    span = hi - lo
    if span <= 0:
        return 1.0
    for s in (0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 1e4, 1e5, 1e6):
        if span / s <= 400:
            return s
    return span / 200


def build_param(df: pd.DataFrame, col: str) -> dict:
    s = df[col].dropna()
    base = {"key": col, "name": KOR.get(col, col), "unit": UNIT.get(col, "")}

    if col in CATEGORICAL or not pd.api.types.is_numeric_dtype(s):
        opts = sorted(str(v) for v in s.unique())
        base.update(type="category", options=opts,
                    default=str(s.mode().iloc[0]))
        return base

    lo, hi = float(s.min()), float(s.max())
    step = nice_step(lo, hi)
    base.update(type="number", min=round(lo, 6), max=round(hi, 6),
                default=round(float(s.median()), 6), step=step)
    return base


def main(data_dir: str, out_path: str) -> None:
    stages = []
    for cfg in STAGES:
        path = os.path.join(data_dir, cfg["file"])
        df = pd.read_csv(path)
        ocol = cfg["output"]["col"]
        o = df[ocol].dropna()

        stages.append({
            "id": cfg["id"], "name": cfg["name"], "order": cfg["order"],
            "source_file": cfg["file"],
            "note": cfg.get("note", ""),
            "output": {
                "key": ocol, "name": cfg["output"]["name"], "unit": cfg["output"]["unit"],
                "range": [round(float(o.min()), 6), round(float(o.max()), 6)],
                "median": round(float(o.median()), 6),
            },
            "upstream": cfg["upstream"],
            "params": [build_param(df, c) for c in cfg["params"]],
        })
        print(f"[{cfg['id']}] params={len(cfg['params'])} output={ocol} "
              f"range=({o.min():.4g}, {o.max():.4g})")

    ylo, yhi = YIELD["range"]
    print(f"[yield] 표시 범위 {ylo} ~ {yhi} (정답 데이터 미확정)")

    schema = {
        "meta": {
            "title": "반도체 공정 수율 시뮬레이터",
            "yield_input_mode": "hybrid",
            "_yield_input_mode_note": "chain=1~5 예측값만 / direct=원본 파라미터만 / hybrid=둘 다",
            "generated_from": data_dir,
        },
        "stages": stages,
        "yield_model": {
            "id": "yield",
            "name": YIELD["name"],
            "note": "정답 데이터 미확정. range 는 임시 표시 범위",
            "output": {
                "key": "yield_rate", "name": "예측 수율", "unit": "%",
                "range": [ylo, yhi],
            },
        },
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(schema, f, ensure_ascii=False, indent=2)
    print(f"\n→ {out_path} 생성 완료")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../data", help="CSV 폴더")
    ap.add_argument("--out", default="schema.json")
    main(*vars(ap.parse_args()).values())
