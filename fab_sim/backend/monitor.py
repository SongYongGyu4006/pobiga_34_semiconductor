"""
생산 운영 모니터링 엔진.

원본 CSV 에서 Lot 을 하나 꺼내 Wafer 대기열을 만들고,
각 Wafer 가 공정을 순차 통과하는 과정을 틱 단위로 진행한다.

핵심 규칙
  · 과거 데이터의 챔버는 쓰지 않는다. 공정조건만 가져오고 챔버는 새로 추천한다.
  · 챔버 추천은 공정 진입 시점마다 다시 한다.
    그때까지 누적된 조건과 앞 공정 예측 Output 을 반영한다.
  · 같은 공정에 동시 진입하는 Wafer 들은 함께 고려해 챔버가 겹치지 않게 배정한다.
  · 배정은 개별 최선이 아니라 **동시 투입 Wafer 전체의 예상 수율 합**이 최대가 되도록 한다.
"""
from __future__ import annotations

import itertools
import threading
from typing import Any, Dict, List, Optional

import pandas as pd

# 공정별 처리 시간(틱). 흐름이 눈에 보이도록 넉넉히 잡는다.
STAGE_TICKS = {"oxidation": 20, "soft_bake": 14, "lithography": 17,
               "etch": 22, "implant": 12}
DEFAULT_TICKS = 15

REF_CHAMBER = "1"          # 아직 정해지지 않은 뒤쪽 공정에 쓰는 기준 챔버

# 선택비는 최종 수율 모델의 입력이 아니므로 후보 평가에서 건너뛴다
SKIP_FOR_SCORING = {"etch_selectivity"}


class Wafer:
    def __init__(self, wid: str, lot: int, num: int, cond: Dict[str, Any]):
        self.id = wid
        self.lot = lot
        self.num = num
        self.cond = cond                     # 공정조건 (챔버 제외)
        self.ctx: Dict[str, Any] = dict(cond)
        self.stage_idx = 0                   # 다음에 들어갈 공정
        self.chamber: Optional[str] = None
        self.progress = 0.0
        self.status = "waiting"              # waiting | running | done
        self.path: List[Dict[str, Any]] = [] # 거친 공정·챔버·Output
        self.candidates: Dict[str, Any] = {} # 공정별 챔버 후보 예상값
        self.target: Optional[float] = None
        self.yield_rate: Optional[float] = None
        self.out_of_window: List[Dict[str, Any]] = []
        self.oow_by_stage: Dict[str, List[Dict[str, Any]]] = {}
        self.orig_chambers: Dict[str, Any] = {}   # 원본 CSV 에 기록된 챔버
        self.base_yield: Optional[float] = None   # 그 경로로 갔을 때의 모델 예측
        self.base_target: Optional[float] = None

    def brief(self) -> Dict[str, Any]:
        return {"id": self.id, "num": self.num, "lot": self.lot, "status": self.status,
                "stage_idx": self.stage_idx, "chamber": self.chamber,
                "progress": round(self.progress, 1),
                "out_of_window": len(self.out_of_window),
                "path": "→".join(str(p["chamber"]) for p in self.path)}


class MonitorEngine:
    def __init__(self, pipeline, schema: Dict[str, Any], csv_path: str):
        self.pl = pipeline
        self.schema = schema
        self.df = pd.read_csv(csv_path)

        # 라인에 표시할 공정 = 챔버 추천 대상 4개 + 이온(식각 챔버 연동)
        self.chambers = pipeline.chamber_stages()
        self.line = [{"id": c["stage"], "name": c["name"], "key": c["key"],
                      "options": c["options"], "recommend": True, "mirror_from": None}
                     for c in self.chambers]

        for st in pipeline.stages:
            mirrored = next((p for p in st["params"] if p.get("mirror")), None)
            if mirrored and not any(l["id"] == st["id"] for l in self.line):
                src = mirrored["mirror"]
                idx = next((i for i, l in enumerate(self.line) if l["key"] == src), None)
                if idx is not None:
                    self.line.append({
                        "id": st["id"], "name": st["name"], "key": mirrored["key"],
                        "options": mirrored["options"], "recommend": False,
                        "mirror_from": idx, "mirror_name": self.line[idx]["name"],
                    })

        self.stage_ids = [l["id"] for l in self.line]
        self.stage_names = [l["name"] for l in self.line]
        self.options = [l["options"] for l in self.line]
        self.keys = [l["key"] for l in self.line]
        self.n_rec = sum(1 for l in self.line if l["recommend"])

        # Process Window (공정조건이 권장 구간을 벗어났는지 판정)
        # Process Window 를 쓰지 않으므로 비어 있다.
        # schema 에 window 가 다시 생기면 자동으로 판정이 살아난다.
        self.windows = {p["key"]: {"name": p["name"], "unit": p.get("unit", ""),
                                   "min": p["window"]["min"], "max": p["window"]["max"],
                                   "stage": st["id"], "stage_name": st["name"]}
                        for st in schema["stages"] for p in st["params"]
                        if p.get("window")}

        # 챔버가 아닌 조절 파라미터 + 파생 입력을 공정조건으로 사용
        self.cond_keys = [p["key"] for st in schema["stages"] for p in st["params"]
                          if "hamber" not in p["key"]]
        self.cond_keys += [d["key"] for st in schema["stages"]
                           for d in st.get("derived", [])]
        self.base_ctx = pipeline.defaults()

        # 투입 단위는 '날짜'. 하루에 Lot 이 1~2개 흐르므로 Lot 단위로는
        # 서로 다른 Lot 이 챔버를 두고 경쟁하는 상황을 재현할 수 없다.
        self.date_col = "Date" if "Date" in self.df.columns else "Datetime"
        self.df[self.date_col] = pd.to_datetime(self.df[self.date_col])
        self.dates = [d.strftime("%Y-%m-%d")
                      for d in sorted(self.df[self.date_col].unique())]
        self.day_info = {
            d.strftime("%Y-%m-%d"): {"wafers": int(len(g)),
                                     "lots": sorted(int(x) for x in g["Lot_Num"].unique())}
            for d, g in self.df.groupby(self.date_col)
        }
        self.lots = sorted(self.df["Lot_Num"].unique().tolist())
        # 틱 진행과 챔버 조작이 동시에 들어오면 같은 Wafer 가 두 슬롯에
        # 배정되어 한 공정을 두 번 끝내는 문제가 생긴다. 상태 변경을 직렬화한다.
        self._lock = threading.RLock()
        self.reset()

    # ------------------------------------------------------------------ 시작
    def reset(self, keep_disabled: bool = True) -> None:
        if not keep_disabled or not hasattr(self, "disabled"):
            self.disabled: Dict[str, set] = {l["id"]: set() for l in self.line}
        self.lot: Optional[int] = None
        self.date: Optional[str] = None
        self.day_lots: List[int] = []
        self.tick_no = 0
        self.queue: List[Wafer] = []
        self.pending: List[List[Wafer]] = [[] for _ in self.line]       # 공정 진입 대기
        self.slots: List[List[Optional[Wafer]]] = [
            [None] * len(o) for o in self.options]                      # 챔버 점유
        self.history: List[Dict[str, Any]] = []
        self.wafers: Dict[str, Wafer] = {}
        self.running = False

    def set_chamber(self, stage: str, chamber: str, enabled: bool) -> Dict[str, Any]:
        with self._lock:
            """챔버를 사용 불가(정비 등)로 돌리거나 되돌린다.
            연동 공정(이온)은 원본 공정의 설정을 그대로 따른다."""
            li = next((i for i, l in enumerate(self.line) if l["id"] == stage), None)
            if li is None:
                return {"ok": False, "reason": "알 수 없는 공정입니다."}
            if not self.line[li]["recommend"]:
                return {"ok": False, "reason": "연동 공정은 직접 설정할 수 없습니다."}

            ch = str(chamber)
            tgt = [self.line[li]["id"]] + [l["id"] for l in self.line
                                           if l.get("mirror_from") == li]
            for sid in tgt:
                if enabled:
                    self.disabled[sid].discard(ch)
                else:
                    self.disabled[sid].add(ch)

            # 한 공정의 모든 챔버를 끄면 진행이 멈추므로 최소 1개는 남긴다
            if len(self.disabled[self.line[li]["id"]]) >= len(self.options[li]):
                for sid in tgt:
                    self.disabled[sid].discard(ch)
                return {"ok": False, "reason": "공정마다 최소 1개 챔버는 열려 있어야 합니다."}

            self._assign_all()
            return {"ok": True, "state": self.state()}

    def start(self, date: Optional[str] = None, limit: int = 30) -> Dict[str, Any]:
        """
        하루치 생산분을 투입한다.
        limit 이 0 이거나 그날 매수보다 크면 전량 투입한다.
        """
        with self._lock:
            self.reset()
            self.date = str(date) if date else self.dates[0]
            if self.date not in self.day_info:
                self.date = self.dates[0]

            sub = self.df[self.df[self.date_col] == pd.Timestamp(self.date)]
            self.day_total = int(len(sub))

            # 그날 Lot 이 여럿이면 번갈아 뽑아 실제처럼 섞어 투입한다.
            # (Lot 순으로 자르면 앞 Lot 만 들어가 경쟁 상황이 사라진다)
            sub = sub.sort_values(["Wafer_Num", "Lot_Num"])
            if limit and limit > 0:
                sub = sub.head(limit)
            self.day_lots = sorted(int(x) for x in sub["Lot_Num"].unique())
            self.lot = self.day_lots[0] if len(self.day_lots) == 1 else None

            for _, row in sub.iterrows():
                # 스키마 기본값 위에 원본 CSV 의 실제 공정조건을 덮어쓴다
                cond = dict(self.base_ctx)
                cond.update({k: row[k] for k in self.cond_keys
                             if k in row.index and pd.notna(row[k])})
                w = Wafer(str(row.get("Wafer_ID", f"W{int(row['Wafer_Num']):02d}")),
                          int(row["Lot_Num"]), int(row["Wafer_Num"]), cond)
                w.orig_chambers = {k: str(int(row[k])) for k in self.keys
                                   if k in row.index and pd.notna(row[k])}
                w.out_of_window = [
                    {"key": k, "name": v["name"], "unit": v["unit"],
                     "stage": v["stage"], "stage_name": v["stage_name"],
                     "value": round(float(cond[k]), 3),
                     "min": v["min"], "max": v["max"],
                     "side": "low" if float(cond[k]) < v["min"] else "high"}
                    for k, v in self.windows.items()
                    if k in cond and not (v["min"] <= float(cond[k]) <= v["max"])]
                # 해당 공정에 도착했을 때만 표시하기 위해 공정별로 묶어둔다
                w.oow_by_stage = {}
                for o in w.out_of_window:
                    w.oow_by_stage.setdefault(o["stage"], []).append(o)
                self.queue.append(w)
                self.wafers[w.id] = w

            # 첫 공정 대기열로 이동
            self.pending[0] = list(self.queue)
            self.queue = []
            self.running = True
            self._assign_all()
            return self.state()

        # ------------------------------------------- 챔버 후보 평가 및 배정

    def _score(self, wafers: List[Wafer], si: int,
               chambers: List[str]) -> List[List[float]]:
        """
        wafers[i] 를 chambers[j] 에 넣었을 때의 예상 최종 수율 표를 만든다.
        뒤쪽 공정 챔버는 기준값으로 고정해 후보 간 비교만 공정하게 한다.
        """
        rows = []
        for w in wafers:
            for ch in chambers:
                r = dict(w.ctx)
                r[self.keys[si]] = ch
                for j in range(si + 1, len(self.keys)):
                    r[self.keys[j]] = REF_CHAMBER
                rows.append(r)

        y = self.pl.run_frame(rows, skip=SKIP_FOR_SCORING)["yield_rate"].tolist()
        n = len(chambers)
        return [y[i * n:(i + 1) * n] for i in range(len(wafers))]

    def _assign(self, si: int) -> None:
        """공정 si 의 빈 챔버에 대기 Wafer 를 겹치지 않게 배정한다."""
        off = self.disabled.get(self.stage_ids[si], set())
        free = [j for j, s in enumerate(self.slots[si])
                if s is None and self.options[si][j] not in off]
        if not free or not self.pending[si]:
            return

        # 연동 공정(이온)은 추천하지 않고 앞 공정에서 쓴 챔버를 그대로 따라간다.
        if not self.line[si]["recommend"]:
            src_key = self.keys[self.line[si]["mirror_from"]]
            for w in list(self.pending[si]):
                if w.status != "waiting":          # 이미 다른 슬롯에 들어간 Wafer
                    self.pending[si].remove(w)
                    continue
                ch = str(w.ctx.get(src_key))
                if ch not in self.options[si]:
                    continue
                j = self.options[si].index(ch)
                if self.slots[si][j] is not None or ch in off:
                    continue          # 같은 번호 챔버가 사용 중이거나 닫혀 있으면 대기
                w.candidates[self.stage_ids[si]] = {
                    "stage": self.stage_names[si], "scores": {},
                    "selected": ch, "linked": self.line[si].get("mirror_name", ""),
                }
                w.chamber = ch
                w.ctx[self.keys[si]] = ch
                w.status = "running"
                w.progress = 0.0
                self.slots[si][j] = w
                self.pending[si].remove(w)
            return

        self.pending[si] = [w for w in self.pending[si] if w.status == "waiting"]
        if not self.pending[si]:
            return
        take = self.pending[si][:len(free)]
        cand_ch = [self.options[si][j] for j in free]
        table = self._score(take, si, cand_ch)

        # 조합 전수 비교 (최대 3x3) → 예상 수율 합이 최대인 배정
        best, best_sum = None, None
        for perm in itertools.permutations(range(len(cand_ch)), len(take)):
            tot = sum(table[i][perm[i]] for i in range(len(take)))
            if best_sum is None or tot > best_sum:
                best, best_sum = perm, tot

        for i, w in enumerate(take):
            j = free[best[i]]
            ch = self.options[si][j]
            w.candidates[self.stage_ids[si]] = {
                "stage": self.stage_names[si],
                "scores": {cand_ch[c]: round(table[i][c], 3)
                           for c in range(len(cand_ch))},
                "selected": ch,
            }
            w.chamber = ch
            w.ctx[self.keys[si]] = ch
            w.status = "running"
            w.progress = 0.0
            self.slots[si][j] = w
            self.pending[si].remove(w)

    def _assign_all(self) -> None:
        for si in range(len(self.line)):
            self._assign(si)

    # ------------------------------------------------------------------ 진행
    def _finish(self, si: int, j: int) -> None:
        w = self.slots[si][j]
        if w is None:
            return
        if w.status != "running" or w.stage_idx != si:
            self.slots[si][j] = None               # 이미 처리된 Wafer 는 슬롯만 비운다
            return
        stage = next(s for s in self.pl.stages if s["id"] == self.stage_ids[si])

        # 이 공정의 Output 예측 (이온은 모델이 없어 건너뛴다)
        outs = {}
        self.pl._derive(w.ctx)
        for m in stage["models"]:
            v = float(self.pl.registry[m["id"]].predict(w.ctx))
            w.ctx[m["output"]["key"]] = v
            outs[m["output"]["name"]] = round(v, 3)

        w.path.append({"stage": self.stage_names[si], "chamber": w.chamber,
                       "outputs": outs})
        self.slots[si][j] = None
        w.chamber = None
        w.progress = 0.0

        if si + 1 < len(self.line):
            w.stage_idx = si + 1
            w.status = "waiting"
            if w not in self.pending[si + 1]:
                self.pending[si + 1].append(w)
        else:
            self._complete(w)

    def _complete(self, w: Wafer) -> None:
        res = self.pl.run(w.ctx)
        w.target = res["target"]["value"]
        w.yield_rate = res["yield"]["value"]

        # 같은 공정조건에서 "원본 CSV 에 기록된 챔버로 갔다면" 을 같은 모델로 평가.
        # 실측 수율과 비교하면 모델 오차가 섞이므로, 모델끼리 비교해야 개선폭이 정당하다.
        if w.orig_chambers:
            base = dict(w.ctx)
            base.update(w.orig_chambers)
            b = self.pl.run(base)
            w.base_target = b["target"]["value"]
            w.base_yield = b["yield"]["value"]

        w.status = "done"
        w.stage_idx = len(self.line)
        self.history.insert(0, {
            "id": w.id, "num": w.num, "lot": w.lot,
            "chambers": [str(p["chamber"]) for p in w.path],
            "out_of_window": len(w.out_of_window),
            "path": "→".join(str(p["chamber"]) for p in w.path),
            "outputs": {k: v for p in w.path for k, v in p["outputs"].items()},
            "target": w.target, "yield": w.yield_rate,
            "base_path": "→".join(str(w.orig_chambers.get(k, "?")) for k in self.keys)
                         if w.orig_chambers else None,
            "base_yield": w.base_yield,
            "gain": (round(w.yield_rate - w.base_yield, 3)
                     if w.base_yield is not None else None),
        })

    def tick(self, n: int = 1) -> Dict[str, Any]:
        with self._lock:
            for _ in range(max(1, n)):
                if not self.running:
                    break
                self.tick_no += 1

                # 진행률 증가 후 완료 처리 (뒤 공정부터 비워야 앞이 밀려들어간다)
                for si in reversed(range(len(self.line))):
                    ticks = STAGE_TICKS.get(self.stage_ids[si], DEFAULT_TICKS)
                    for j, w in enumerate(self.slots[si]):
                        if w is None:
                            continue
                        w.progress = min(100.0, w.progress + 100.0 / ticks)
                        if w.progress >= 100.0 - 1e-9:
                            self._finish(si, j)

                self._assign_all()

                if not any(self.pending) and not any(
                        s for row in self.slots for s in row):
                    self.running = False
            return self.state()

        # ------------------------------------------------- 남은 공정 예상 경로
    def _forecast(self, w: "Wafer") -> Dict[str, Any]:
        """
        아직 지나지 않은 공정에서 어떤 챔버로 갈지 예측한다.

        같은 타이밍에 함께 들어가는 Wafer 들은 실제로 챔버가 겹치지 않게 배정되므로,
        예측도 그 '동승 그룹' 을 함께 놓고 겹치지 않는 조합 중 합이 최대인 배정을 고른다.
        (혼자만 놓고 최선을 고르면 여러 Wafer 의 예상 경로가 똑같이 겹쳐 보인다)
        """
        if w.status == "done":
            return {"steps": [], "final_yield": w.yield_rate,
                    "final_target": w.target, "cohort": []}

        n_ch = len(self.options[0])

        def next_stage(x: "Wafer") -> int:
            return x.stage_idx + 1 if x.status == "running" else x.stage_idx

        # ---- 동승 그룹 : 다음 공정이 같은 Wafer 들 ----
        ns = next_stage(w)
        peers = [x for x in self.wafers.values()
                 if x.status != "done" and next_stage(x) == ns]
        peers.sort(key=lambda x: (-x.progress, x.num))     # 먼저 끝나는 순
        idx = peers.index(w)
        group = peers[(idx // n_ch) * n_ch:][:n_ch]        # w 가 속한 묶음

        # ---- 각 Wafer 의 현재 컨텍스트 (진행 중이면 그 공정 Output 반영) ----
        ctxs = {}
        for g in group:
            c = dict(g.ctx)
            if g.status == "running":
                st = next(s for s in self.pl.stages if s["id"] == self.stage_ids[g.stage_idx])
                self.pl._derive(c)
                for m in st["models"]:
                    c[m["output"]["key"]] = float(self.pl.registry[m["id"]].predict(c))
            ctxs[g.id] = c

        steps, cohort_paths = [], {g.id: [] for g in group}

        for si in range(ns, len(self.line)):
            key = self.keys[si]
            off = self.disabled.get(self.stage_ids[si], set())

            if not self.line[si]["recommend"]:
                # 연동 공정은 앞 공정 챔버를 그대로 따라간다
                chosen = {g.id: str(ctxs[g.id].get(self.keys[self.line[si]["mirror_from"]]))
                          for g in group}
                scores_for_w = {}
            else:
                cand = [c for c in self.options[si] if c not in off] or list(self.options[si])
                rows = []
                for g in group:
                    for c in cand:
                        r = dict(ctxs[g.id])
                        r[key] = c
                        for j in range(si + 1, len(self.keys)):
                            r[self.keys[j]] = REF_CHAMBER
                        rows.append(r)
                y = self.pl.run_frame(rows)["yield_rate"].tolist()
                table = [y[i * len(cand):(i + 1) * len(cand)] for i in range(len(group))]

                # 겹치지 않는 배정 중 합이 최대인 조합
                best, best_sum = None, None
                k = min(len(group), len(cand))
                for perm in itertools.permutations(range(len(cand)), k):
                    tot = sum(table[i][perm[i]] for i in range(k))
                    if best_sum is None or tot > best_sum:
                        best, best_sum = perm, tot

                chosen = {}
                for i, g in enumerate(group):
                    chosen[g.id] = cand[best[i]] if i < k else cand[0]
                wi = group.index(w)
                scores_for_w = {cand[c]: round(table[wi][c], 3) for c in range(len(cand))}

            # 선택 반영 후 각자의 Output 예측
            stage = next(s for s in self.pl.stages if s["id"] == self.stage_ids[si])
            for g in group:
                ctxs[g.id][key] = chosen[g.id]
                self.pl._derive(ctxs[g.id])
                for m in stage["models"]:
                    ctxs[g.id][m["output"]["key"]] = float(
                        self.pl.registry[m["id"]].predict(ctxs[g.id]))
                cohort_paths[g.id].append(str(chosen[g.id]))

            steps.append({"stage": self.stage_names[si], "stage_id": self.stage_ids[si],
                          "chamber": chosen[w.id], "scores": scores_for_w})

        final = self.pl.run(ctxs[w.id])
        return {
            "steps": steps,
            "final_yield": final["yield"]["value"],
            "final_target": final["target"]["value"],
            "cohort": [{"id": g.id, "num": g.num, "self": g.id == w.id,
                        "path": "→".join(cohort_paths[g.id])}
                       for g in group],
        }

    # ------------------------------------------- 공정 단위 최적 경로 조합
    def stage_routes(self, stage_id: str) -> Dict[str, Any]:
        """
        지금 그 공정의 챔버에 들어가 있는 Wafer 들을 한 묶음으로 보고,
        남은 공정에서 서로 챔버가 겹치지 않는 최적 배정을 계산한다.
        """
        with self._lock:
            if stage_id not in self.stage_ids:
                return {"ok": False, "reason": "알 수 없는 공정입니다."}
            si = self.stage_ids.index(stage_id)

            group = [w for w in self.slots[si] if w is not None]
            if not group:
                return {"ok": False, "reason": "이 공정에서 진행 중인 Wafer 가 없습니다."}

            n_lane = len(group)
            ctxs = {}
            for g in group:
                c = dict(g.ctx)
                st = next(x for x in self.pl.stages if x["id"] == self.stage_ids[si])
                self.pl._derive(c)
                for m in st["models"]:
                    c[m["output"]["key"]] = float(self.pl.registry[m["id"]].predict(c))
                ctxs[g.id] = c

            future = {g.id: [] for g in group}
            scores = {g.id: {} for g in group}

            for sj in range(si + 1, len(self.line)):
                key = self.keys[sj]
                off = self.disabled.get(self.stage_ids[sj], set())

                if not self.line[sj]["recommend"]:
                    chosen = {g.id: str(ctxs[g.id].get(self.keys[self.line[sj]["mirror_from"]]))
                              for g in group}
                    tbl, cand = None, []
                else:
                    cand = [c for c in self.options[sj] if c not in off] or list(self.options[sj])
                    rows = []
                    for g in group:
                        for c in cand:
                            r = dict(ctxs[g.id])
                            r[key] = c
                            for k in range(sj + 1, len(self.keys)):
                                r[self.keys[k]] = REF_CHAMBER
                            rows.append(r)
                    y = self.pl.run_frame(rows, skip=SKIP_FOR_SCORING)["yield_rate"].tolist()
                    tbl = [y[i * len(cand):(i + 1) * len(cand)] for i in range(len(group))]

                    best, best_sum = None, None
                    k = min(n_lane, len(cand))
                    for perm in itertools.permutations(range(len(cand)), k):
                        tot = sum(tbl[i][perm[i]] for i in range(k))
                        if best_sum is None or tot > best_sum:
                            best, best_sum = perm, tot
                    chosen = {group[i].id: (cand[best[i]] if i < k else cand[0])
                              for i in range(n_lane)}

                stage = next(x for x in self.pl.stages if x["id"] == self.stage_ids[sj])
                for i, g in enumerate(group):
                    ch = chosen[g.id]
                    ctxs[g.id][key] = ch
                    self.pl._derive(ctxs[g.id])
                    for m in stage["models"]:
                        ctxs[g.id][m["output"]["key"]] = float(
                            self.pl.registry[m["id"]].predict(ctxs[g.id]))
                    future[g.id].append(str(ch))
                    if tbl:
                        scores[g.id][self.stage_ids[sj]] = {
                            c: round(tbl[i][j], 3) for j, c in enumerate(cand)}

            lanes = []
            for g in group:
                past = [str(p["chamber"]) for p in g.path]
                res = self.pl.run(ctxs[g.id])
                lanes.append({
                    "id": g.id, "num": g.num, "lot": g.lot,
                    "chamber": str(g.chamber),
                    "progress": round(g.progress, 1),
                    "chambers": past + [str(g.chamber)] + future[g.id],
                    "future": future[g.id],
                    "scores": scores[g.id],
                    "yield": res["yield"]["value"],
                })
            lanes.sort(key=lambda x: self.options[si].index(x["chamber"]))

            return {
                "ok": True,
                "stage": stage_id,
                "stage_index": si,
                "stage_name": self.stage_names[si],
                "stage_names": self.stage_names,
                "options": self.options,
                "avg_yield": round(sum(l["yield"] for l in lanes) / len(lanes), 3),
                "lanes": lanes,
            }

    # ------------------------------------------------------------------ 상태

    def state(self) -> Dict[str, Any]:
        with self._lock:
            total = len(self.wafers)
            done = sum(1 for w in self.wafers.values() if w.status == "done")
            run = sum(1 for row in self.slots for s in row if s is not None)
            wait = total - done - run
            ys = [w.yield_rate for w in self.wafers.values() if w.yield_rate is not None]
            bs = [w.base_yield for w in self.wafers.values() if w.base_yield is not None]
            gains = [w.yield_rate - w.base_yield for w in self.wafers.values()
                     if w.base_yield is not None and w.yield_rate is not None]

            stages = []
            for si, c in enumerate(self.line):
                chs = []
                off = self.disabled.get(c["id"], set())
                for j, opt in enumerate(self.options[si]):
                    w = self.slots[si][j]
                    is_off = opt in off
                    chs.append({
                        "chamber": opt,
                        "enabled": not is_off,
                        "status": ("CLOSING" if (w and is_off) else
                                   "RUNNING" if w else
                                   "DISABLED" if is_off else "AVAILABLE"),
                        "wafer": w.id if w else None,
                        "wafer_num": w.num if w else None,
                        "lot": w.lot if w else None,
                        "progress": round(w.progress, 1) if w else 0,
                        "out_of_window": len(w.oow_by_stage.get(c["id"], [])) if w else 0,
                    })
                stages.append({
                    "id": c["id"], "name": c["name"], "chambers": chs,
                    "recommend": c["recommend"],
                    "linked_to": c.get("mirror_name", ""),
                    "disabled": sorted(off),
                    # 대기 중에는 아직 그 공정에 들어간 것이 아니므로 이탈 표시를 하지
                    # 않는다. 챔버에 실제로 진입했을 때만 빨간색으로 뜬다.
                    "pending": [{"id": x.id, "num": x.num, "lot": x.lot,
                                 "out_of_window": 0}
                                for x in self.pending[si]],
                    "ticks": STAGE_TICKS.get(c["id"], DEFAULT_TICKS),
                })

            return {
                "running": self.running,
                "date": self.date,
                "dates": self.dates,
                "day_info": self.day_info.get(self.date or "", {}),
                "day_total": getattr(self, "day_total", 0),
                "day_lots": self.day_lots,
                "lot": self.lot,
                "lots": self.lots,
                "tick": self.tick_no,
                "summary": {
                    "total": total, "waiting": wait, "running": run, "completed": done,
                    "progress": round(done / total * 100, 1) if total else 0,
                    "avg_yield": round(sum(ys) / len(ys), 2) if ys else None,
                    "avg_base_yield": round(sum(bs) / len(bs), 2) if bs else None,
                    "avg_gain": round(sum(gains) / len(gains), 2) if gains else None,
                    "win": sum(1 for g in gains if g > 0),
                    "lose": sum(1 for g in gains if g < 0),
                },
                "stages": stages,
                "line_meta": {"stage_ids": self.stage_ids,
                              "stage_names": self.stage_names,
                              "options": self.options,
                              "n_recommend": self.n_rec},
                "history": self.history[:30],
                "wafers": [w.brief() for w in self.wafers.values()],
            }

    def wafer_detail(self, wid: str, forecast: bool = True) -> Dict[str, Any]:
        with self._lock:
            w = self.wafers.get(wid)
            if not w:
                return {"ok": False, "reason": "해당 Wafer 를 찾을 수 없습니다."}
            return {
                "ok": True,
                "id": w.id, "num": w.num, "lot": w.lot, "status": w.status,
                "stage_idx": w.stage_idx,
                "out_of_window": w.out_of_window,
                "stage_ids": self.stage_ids,
                "stage_names": self.stage_names,
                "options": self.options,
                "stage": (self.stage_names[w.stage_idx]
                          if w.stage_idx < len(self.stage_names) else "완료"),
                "chamber": w.chamber,
                "progress": round(w.progress, 1),
                "path": w.path,
                "candidates": [w.candidates[s] for s in self.stage_ids
                               if s in w.candidates],
                "target": w.target, "yield": w.yield_rate,
                "base_path": ("→".join(str(w.orig_chambers.get(k, "?"))
                                       for k in self.keys)
                              if w.orig_chambers else None),
                "base_yield": w.base_yield,
                "base_target": w.base_target,
                "gain": (round(w.yield_rate - w.base_yield, 3)
                         if w.base_yield is not None and w.yield_rate is not None
                         else None),
                # 예상 경로 계산은 0.4초쯤 걸린다. 진행률만 갱신할 때는 생략한다.
                "forecast": self._forecast(w) if forecast else None,
            }
