"""
공정 파이프라인.

단건 실행(run)과 배치 실행(run_frame)을 모두 지원한다.
배치 실행은 챔버 경로 탐색에 쓰인다. 조합이 최대 3^5 = 243 개이므로,
한 건씩 돌리지 않고 모델마다 한 번에 예측한다.
"""
from __future__ import annotations

import itertools
from typing import Any, Dict, List, Optional

import pandas as pd

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
        self._mirror = {}          # {따라가는 키: 원본 키}
        for st in self.stages:
            for p in st["params"]:
                self._dtype[p["key"]] = p.get("dtype", "float")
                if p.get("mirror"):
                    self._mirror[p["key"]] = p["mirror"]

    # ------------------------------------------------------------------ 공통
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

    def merge(self, params: Dict[str, Any]) -> Dict[str, Any]:
        ctx = self.defaults()
        ctx.update({k: v for k, v in params.items() if v is not None and k in ctx})
        # 연동 파라미터는 항상 원본 값을 따라간다 (예: 이온 챔버 = 식각 챔버)
        for dst, src in self._mirror.items():
            if src in ctx:
                ctx[dst] = ctx[src]
        return {k: self._cast(k, v) for k, v in ctx.items()}

    def _derive(self, ctx: Dict[str, Any]) -> Dict[str, Any]:
        info = {}
        for st in self.stages:
            for d in st.get("derived", []):
                if any(x not in ctx for x in d["args"]):
                    continue          # 원본에 파생 재료가 없으면 기존 값을 그대로 둔다
                a, b = (ctx[x] for x in d["args"])
                ctx[d["key"]] = OPS[d["op"]](a, b)
                info[d["key"]] = {
                    "key": d["key"], "name": d["name"], "unit": d.get("unit", ""),
                    "value": round(float(ctx[d["key"]]), 4),
                    "stage": st["id"], "after": d.get("after"),
                }
        return info

    # ------------------------------------------------------------------ 단건
    def run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        ctx = self.merge(params)
        derived_out = self._derive(ctx)

        stage_results: Dict[str, List[Dict[str, Any]]] = {}
        for st in self.stages:
            outs = []
            for m in st["models"]:
                val = float(self.registry[m["id"]].predict(ctx))
                ctx[m["output"]["key"]] = val
                outs.append({
                    "model_id": m["id"], "key": m["output"]["key"],
                    "name": m["output"]["name"], "unit": m["output"]["unit"],
                    "value": round(val, 4), "range": m["output"]["range"],
                    "ratio": _scale(val, m["output"]["range"]),
                })
            if outs:
                stage_results[st["id"]] = outs

        yc = self.yield_cfg
        total = yc["target"]["total_dies"]
        target = float(self.registry[yc["id"]].predict(ctx))
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

    # ------------------------------------------------------------------ 배치
    def run_frame(self, rows: List[Dict[str, Any]],
                  skip: Optional[set] = None) -> pd.DataFrame:
        """
        여러 파라미터 조합을 모델마다 한 번씩만 호출해 계산한다.
        skip 에 넣은 모델은 건너뛴다 (예: 최종 수율에 쓰이지 않는 선택비).
        예측 비용은 행 수보다 호출 횟수에 좌우되므로, 가능한 한 크게 묶어 부른다.
        """
        skip = skip or set()
        ctxs = []
        for r in rows:
            c = self.merge(r)
            self._derive(c)
            ctxs.append(c)
        df = pd.DataFrame(ctxs)

        for st in self.stages:
            for m in st["models"]:
                if m["id"] in skip:
                    continue
                df[m["output"]["key"]] = self.registry[m["id"]].predict_frame(df)

        yc = self.yield_cfg
        df["Target"] = self.registry[yc["id"]].predict_frame(df)
        df["yield_rate"] = (1 - df["Target"] / yc["target"]["total_dies"]) * 100
        return df

    # ------------------------------------------------- 챔버 경로 추천
    def chamber_stages(self) -> List[Dict[str, Any]]:
        out = []
        for st in self.stages:
            key = st.get("chamber_key")
            if not key:
                continue
            opts = next(p["options"] for p in st["params"] if p["key"] == key)
            out.append({"stage": st["id"], "name": st["name"], "key": key, "options": opts})
        return out

    def recommend(self, params: Dict[str, Any],
                  from_stage: Optional[str] = None, top_n: int = 5) -> Dict[str, Any]:
        """
        from_stage 이후 공정의 챔버 조합을 전수 탐색해 수율 순으로 반환.
        앞선 공정의 챔버는 현재 선택값으로 고정한다.
        """
        base = self.merge(params)
        chambers = self.chamber_stages()

        ids = [c["stage"] for c in chambers]
        if from_stage in ids:
            start = ids.index(from_stage)
        elif from_stage:
            # 독립 챔버가 없는 공정(이온 주입)에서 호출된 경우,
            # 그 공정에 연동된 마지막 챔버 공정을 기준으로 삼는다.
            order = {st["id"]: st["order"] for st in self.stages}
            cand = [i for i, c in enumerate(chambers)
                    if order[c["stage"]] <= order.get(from_stage, 0)]
            start = cand[-1] if cand else 0
        else:
            start = 0
        target_ch, fixed_ch = chambers[start:], chambers[:start]

        combos = list(itertools.product(*[c["options"] for c in target_ch]))
        rows = []
        for combo in combos:
            r = dict(base)
            for c, v in zip(target_ch, combo):
                r[c["key"]] = v
            rows.append(r)

        df = self.run_frame(rows).reset_index(drop=True)
        df["_path"] = ["-".join(map(str, c)) for c in combos]

        cur_path = "-".join(str(base[c["key"]]) for c in target_ch)
        ranked = df.sort_values("yield_rate", ascending=False).reset_index(drop=True)

        cur_hit = ranked.index[ranked["_path"] == cur_path]
        cur_yield = float(ranked.loc[cur_hit[0], "yield_rate"]) if len(cur_hit) else None
        cur_rank = int(cur_hit[0]) + 1 if len(cur_hit) else None

        def pack(row, rank):
            path = row["_path"]
            return {
                "rank": rank,
                "path": path,
                "chambers": {c["key"]: v for c, v in zip(target_ch, path.split("-"))},
                "yield": round(float(row["yield_rate"]), 3),
                "target": round(float(row["Target"]), 2),
                "gain": None if cur_yield is None
                else round(float(row["yield_rate"]) - cur_yield, 3),
            }

        top = [pack(r, i + 1) for i, r in ranked.head(top_n).iterrows()]

        mirrors = [{"key": d, "source": s} for d, s in self._mirror.items()]

        return {
            "mirrors": mirrors,
            "from_stage": target_ch[0]["stage"] if target_ch else None,
            "from_stage_name": target_ch[0]["name"] if target_ch else None,
            "fixed": [{"stage": c["stage"], "name": c["name"],
                       "value": str(base[c["key"]])} for c in fixed_ch],
            "fixed_path": "-".join(str(base[c["key"]]) for c in fixed_ch),
            "searched": len(combos),
            "stages": [{"stage": c["stage"], "name": c["name"], "key": c["key"]}
                       for c in target_ch],
            "current": {"path": cur_path,
                        "yield": None if cur_yield is None else round(cur_yield, 3),
                        "rank": cur_rank},
            "best": top[0] if top else None,
            "top": top,
        }


    # ------------------------------------------- 동시 운용 경로 조합
    # -------------------------------------------------- 확정 경로 (문서 결과)
    def fixed_route_set(self, params: Dict[str, Any],
                        available: Optional[Dict[str, List[str]]] = None
                        ) -> Optional[Dict[str, Any]]:
        """
        분석으로 확정된 경로 조합을 그대로 돌려준다.
        사용 불가 챔버 때문에 성립하지 않으면 None (호출부가 탐색으로 대체).
        """
        cfg = self.schema.get("route_set")
        if not cfg:
            return None

        chambers = self.chamber_stages()
        available = available or {}
        avail = []
        for c in chambers:
            sel = [str(v) for v in available.get(c["key"], []) if str(v) in c["options"]]
            avail.append(sel or list(c["options"]))

        paths = [tuple(str(l["path"]).split("-")) for l in cfg["lanes"]]
        if any(len(p) != len(chambers) for p in paths):
            return None
        for p in paths:
            if any(p[i] not in avail[i] for i in range(len(chambers))):
                return None

        base = self.merge(params)
        rows = []
        for p in paths:
            r = dict(base)
            for c, v in zip(chambers, p):
                r[c["key"]] = v
            rows.append(r)
        df = self.run_frame(rows).reset_index(drop=True)

        lanes_out = []
        for i, (cfg_lane, p) in enumerate(zip(cfg["lanes"], paths)):
            lanes_out.append({
                "lane": cfg_lane["lane"],
                "path": "-".join(p),
                "fixed": list(p),
                "searched": [],
                "chambers": {c["key"]: v for c, v in zip(chambers, p)},
                "yield": round(float(cfg_lane["yield"]), 3),
                "sd": cfg_lane.get("sd"),
                "wafers": cfg_lane.get("wafers"),
                "model_yield": round(float(df.loc[i, "yield_rate"]), 3),
                "target": round(float(df.loc[i, "Target"]), 2),
            })

        cur_path = tuple(str(base[c["key"]]) for c in chambers)
        best = {
            "rank": 1,
            "avg_yield": round(float(cfg["avg_yield"]), 3),
            "min_yield": round(min(l["yield"] for l in lanes_out), 3),
            "avg_model_yield": round(float(df["yield_rate"].mean()), 3),
            "lanes": lanes_out,
        }

        return {
            "ok": True,
            "mode": "fixed",
            "source": cfg.get("source", ""),
            "note": cfg.get("note", ""),
            "stages": [{"stage": c["stage"], "name": c["name"], "key": c["key"],
                        "options": c["options"], "available": avail[i]}
                       for i, c in enumerate(chambers)],
            "mirrors": [{"key": d, "source": s} for d, s in self._mirror.items()],
            "lane_count": len(lanes_out),
            "bottleneck": [],
            "locked_upto": len(chambers),
            "locked_stages": [c["name"] for c in chambers],
            "search_stages": [],
            "paths_evaluated": len(paths),
            "sets_evaluated": 1,
            "current": {"path": "-".join(cur_path), "yield": None},
            "best": best,
            "top": [best],
        }

    def recommend_set(self, params: Dict[str, Any],
                      from_stage: Optional[str] = None,
                      lanes: Optional[List[str]] = None,
                      available: Optional[Dict[str, List[str]]] = None,
                      top_n: int = 3,
                      mode: str = "auto") -> Dict[str, Any]:
        """
        여러 챔버를 동시에 운용한다는 전제로, 서로 챔버가 겹치지 않는
        경로 조합을 찾는다.

        from_stage : 이 공정부터 재탐색. 앞 공정 배정은 lanes 를 그대로 유지
        lanes      : 현재 라인들의 전체 경로 (예: ["1-2-1-2", ...])
        available  : 공정별 사용 가능 챔버 {chamber_key: ["1","3"], ...}

        라인 수 = 각 공정의 사용 가능 챔버 개수 중 최솟값
        제약     = 각 공정에서 라인끼리 챔버가 겹치지 않음
        목적     = 라인 예측 수율의 평균 최대화
        """
        if mode in ("auto", "fixed"):
            fixed = self.fixed_route_set(params, available)
            if fixed is not None:
                return fixed
            if mode == "fixed":
                return {"ok": False,
                        "reason": "확정 경로에 사용 불가 챔버가 포함되어 있습니다."}

        base = self.merge(params)
        chambers = self.chamber_stages()
        available = available or {}

        # ---- 공정별 사용 가능 챔버 ----
        avail = []
        for c in chambers:
            sel = [str(v) for v in available.get(c["key"], []) if str(v) in c["options"]]
            avail.append(sel or list(c["options"]))

        n = min(len(a) for a in avail)
        if n < 1:
            return {"ok": False, "reason": "사용 가능한 챔버가 없습니다."}

        # ---- 재탐색 시작 지점 ----
        ids = [c["stage"] for c in chambers]
        if from_stage in ids:
            k = ids.index(from_stage)
        elif from_stage:
            order = {st["id"]: st["order"] for st in self.stages}
            cand = [i for i, c in enumerate(chambers)
                    if order[c["stage"]] <= order.get(from_stage, 0)]
            k = cand[-1] if cand else 0
        else:
            k = 0

        # ---- 앞 공정 고정 구간 ----
        prefix = None
        if k > 0 and lanes:
            cand = []
            for path in lanes:
                p = str(path).split("-")
                if len(p) == len(chambers) and all(p[i] in avail[i] for i in range(k)):
                    cand.append(p[:k])
            # 고정 구간끼리도 겹치면 안 된다
            ok = all(len(set(col)) == len(col) for col in zip(*cand)) if cand else False
            if ok and len(cand) >= n:
                prefix = cand[:n]
        if prefix is None:
            k = 0                       # 물려받을 조합이 없으면 처음부터 탐색

        # ---- 필요한 경로의 수율을 배치로 계산 ----
        if k == 0:
            need = list(itertools.product(*avail))
        else:
            need = sorted({tuple(pf) + tail
                           for pf in prefix
                           for tail in itertools.product(*avail[k:])})

        rows = []
        for path in need:
            r = dict(base)
            for c, v in zip(chambers, path):
                r[c["key"]] = v
            rows.append(r)

        df = self.run_frame(rows).reset_index(drop=True)
        ymap = {p: float(df.loc[i, "yield_rate"]) for i, p in enumerate(need)}
        tmap = {p: float(df.loc[i, "Target"]) for i, p in enumerate(need)}

        # ---- 겹치지 않는 배정 전수 탐색 ----
        #   첫 공정은 조합(라인 라벨 중복 제거), 이후 공정은 순열(단사 배정)
        if k == 0:
            head_space = list(itertools.combinations(avail[0], n))
            tail_space = [list(itertools.permutations(a, n)) for a in avail[1:]]
        else:
            head_space = [tuple(range(n))]        # 프리픽스 고정
            tail_space = [list(itertools.permutations(a, n)) for a in avail[k:]]

        results = []
        for head in head_space:
            for tails in itertools.product(*tail_space):
                lane_paths, total = [], 0.0
                for l in range(n):
                    if k == 0:
                        path = (head[l],) + tuple(t[l] for t in tails)
                    else:
                        path = tuple(prefix[l]) + tuple(t[l] for t in tails)
                    total += ymap[path]
                    lane_paths.append(path)
                results.append((total / n, lane_paths))

        results.sort(key=lambda x: x[0], reverse=True)
        lock = k if k > 0 else 1        # 첫 공정은 라인 식별자이므로 고정으로 표기

        def pack(avg, lane_paths, rank):
            return {
                "rank": rank,
                "avg_yield": round(avg, 3),
                "min_yield": round(min(ymap[p] for p in lane_paths), 3),
                "lanes": [{
                    "lane": lp[0],
                    "path": "-".join(lp),
                    "fixed": list(lp[:lock]),
                    "searched": list(lp[lock:]),
                    "chambers": {c["key"]: v for c, v in zip(chambers, lp)},
                    "yield": round(ymap[lp], 3),
                    "target": round(tmap[lp], 2),
                } for lp in lane_paths],
            }

        top = [pack(a, lp, i + 1) for i, (a, lp) in enumerate(results[:top_n])]
        cur_path = tuple(str(base[c["key"]]) for c in chambers)

        return {
            "ok": True,
            "mode": "search",
            "source": "모델 예측 기반 탐색",
            "note": "",
            "stages": [{"stage": c["stage"], "name": c["name"], "key": c["key"],
                        "options": c["options"], "available": avail[i]}
                       for i, c in enumerate(chambers)],
            "mirrors": [{"key": d, "source": s} for d, s in self._mirror.items()],
            "lane_count": n,
            "bottleneck": [chambers[i]["name"] for i, a in enumerate(avail) if len(a) == n],
            "locked_upto": lock,
            "locked_stages": [c["name"] for c in chambers[:lock]],
            "search_stages": [c["name"] for c in chambers[lock:]],
            "paths_evaluated": len(need),
            "sets_evaluated": len(results),
            "current": {"path": "-".join(cur_path),
                        "yield": round(ymap[cur_path], 3) if cur_path in ymap else None},
            "best": top[0] if top else None,
            "top": top,
        }



def _scale(value: float, rng: List[float]) -> float:
    lo, hi = rng
    if hi == lo:
        return 0.5
    return round(min(max((value - lo) / (hi - lo), 0.0), 1.0), 4)
