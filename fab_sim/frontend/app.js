/* 반도체 공정 수율 시뮬레이터 - 프론트엔드
   스키마를 받아 UI를 자동 생성한다.

   변경점
   - 공정당 출력이 여러 개일 수 있음 (식각: 전체 식각량 → 선택비)
   - 파생값(구간 식각량)은 슬라이더 아래 읽기 전용으로 표시
   - 숨김 공정(이온 주입)은 서버가 스키마에서 제외해 내려줌
   - 결함 Die 수는 모델이 예측한 Target 값을 그대로 사용 */

const API = "";
const DEBOUNCE_MS = 150;

let schema = null;
let params = {};
let defaults = {};
let baselineYield = null;
let baselineOut = {};           // {output_key: value}
let baselineDefect = null;
let timer = null;
let inflight = null;

let paramStage = {};            // {param_key: stage_id}
let chamberKeys = [];           // 챔버 파라미터 키 목록
let avail = {};                 // {chamber_key: [...]} 사용 가능 챔버
let previewLane = 0;            // 좌측 단건 예측이 어느 라인 기준인지
let lastStage = null;           // 마지막으로 조절한 공정
let routeTimer = null;
let routeInflight = null;
let lastRoute = null;

// ------------------------------------------------------------------ 초기화
async function init() {
  schema = await fetch(`${API}/api/schema`).then(r => r.json());
  const boot = await fetch(`${API}/api/defaults`).then(r => r.json());

  defaults = boot.params;
  params = { ...boot.params };

  renderStages();

  baselineYield = boot.prediction.yield.value;
  baselineDefect = boot.prediction.target.value;
  baselineOut = {};
  Object.values(boot.prediction.stages).forEach(outs =>
    outs.forEach(o => { baselineOut[o.key] = o.value; }));

  document.getElementById("yield-base").textContent =
    `기본값 ${fmt(baselineYield, 2)}%`;

  syncMirrors();
  updateChamberMarkers();
  applyPrediction(boot.prediction);
  document.getElementById("reset-btn").onclick = reset;
  document.getElementById("opt-max").onclick = () => optimize("max");
  document.getElementById("opt-min").onclick = () => optimize("min");
  scheduleRoute();
}

function orderedStages() {
  return [...schema.stages].sort((a, b) => a.order - b.order);
}

function allOutputs() {
  return orderedStages().flatMap(s => s.models.map(m => ({ ...m.output, stage: s.id })));
}

// ------------------------------------------------------------------ UI 생성
function renderStages() {
  const root = document.getElementById("stages");
  root.innerHTML = "";

  paramStage = {};
  chamberKeys = [];
  orderedStages().forEach(st => {
    st.params.forEach(p => { paramStage[p.key] = st.id; });
    st.params.filter(p => /hamber/.test(p.key)).forEach(p => {
      chamberKeys.push(p.key);
      if (!avail[p.key]) avail[p.key] = [...p.options];
    });
  });

  orderedStages().forEach((stage, i) => {
    const el = document.createElement("section");
    el.className = "stage";
    el.dataset.stage = stage.id;

    const headOut = stage.models[0];
    const hasPred = stage.models.length > 0;
    if (!hasPred) el.classList.add("no-pred");

    el.innerHTML = `
      <i class="corner tl"></i><i class="corner tr"></i>
      <i class="corner bl"></i><i class="corner br"></i>
      <div class="stage-head">
        <span class="stage-idx">${String(i + 1).padStart(2, "0")}</span>
        <span class="stage-name">${stage.name}</span>
        <span class="stage-head-out">
          ${headOut ? `<b data-head="${headOut.output.key}">--</b>
                       <em>${headOut.output.unit || ""}</em>` : ""}
        </span>
        <span class="chev">▾</span>
      </div>
      <div class="stage-body">
        <div class="params"></div>
        ${hasPred ? `
        <div class="stage-pred">
          <span class="kicker">STAGE OUTPUT</span>
          ${stage.models.map((m, k) => `
            <div class="pred-block${k ? " sub" : ""}">
              <span class="pred-name">${m.output.name}</span>
              <div class="pred-val">
                <span data-out="${m.output.key}">--</span><em>${m.output.unit || ""}</em>
              </div>
              <div class="pred-row">
                <span>기본값 대비</span>
                <span class="delta" data-delta="${m.output.key}">—</span>
              </div>
            </div>`).join("")}
        </div>` : `
        <div class="stage-pred passthru">
          <span class="kicker">STAGE OUTPUT</span>
          <p class="passthru-msg">예측 모델 없음<br>조절값은 최종 수율에 직접 반영</p>
        </div>`}
      </div>
    `;

    el.querySelector(".stage-head").onclick = () => el.classList.toggle("collapsed");

    const body = el.querySelector(".params");
    const derived = stage.derived || [];

    stage.params.forEach(p => {
      if (/hamber/.test(p.key)) {
        body.appendChild(buildChamberPick(p));
        body.appendChild(buildChamberAvail(p));
      } else {
        body.appendChild(buildParam(p));
      }
      derived.filter(d => d.after === p.key)
             .forEach(d => body.appendChild(buildDerived(d)));
    });

    root.appendChild(el);
  });

  // 요약 리스트 — 모든 출력 + 파생값
  document.getElementById("summary-list").innerHTML = allOutputs().map((o, i) => `
    <li>
      <span class="s-idx">${String(i + 1).padStart(2, "0")}</span>
      <span class="s-name">${o.name}</span>
      <span class="s-out">
        <span class="s-val" data-sum="${o.key}">--</span>
        <span class="s-unit">${o.unit || ""}</span>
      </span>
    </li>`).join("");
}

/* 챔버 선택 : 좌측 단건 예측이 사용할 챔버 (단일 선택) */
function buildChamberPick(p) {
  const wrap = document.createElement("div");
  wrap.className = "param chamber pick";
  const linked = !!p.mirror;
  if (linked) wrap.classList.add("linked");

  wrap.innerHTML = `
    <div class="param-label">
      <span class="param-name">챔버 선택</span>
      <span class="${linked ? "auto" : "mod"}">${linked ? "LINK" : "MOD"}</span>
    </div>
    <div class="param-ctrl"><div class="seg" data-pick="${p.key}"></div></div>`;

  const seg = wrap.querySelector(".seg");
  p.options.forEach(opt => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt;
    b.className = String(opt) === String(params[p.key] ?? p.default) ? "on" : "";
    if (linked) b.disabled = true;
    else b.onclick = () => pickChamber(p, String(opt));
    seg.appendChild(b);
  });
  return wrap;
}

/* 사용 가능 챔버 : 경로 조합 탐색 대상 (다중 선택) */
function buildChamberAvail(p) {
  const wrap = document.createElement("div");
  wrap.className = "param chamber avail";
  const linked = !!p.mirror;
  if (linked) wrap.classList.add("linked");

  wrap.innerHTML = `
    <div class="param-label">
      <span class="param-name">사용 가능</span>
      <span class="${linked ? "auto" : "mod"}">${linked ? "LINK" : "SEL"}</span>
    </div>
    <div class="param-ctrl"><div class="seg multi" data-seg="${p.key}"></div></div>`;

  const seg = wrap.querySelector(".seg");
  p.options.forEach(opt => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt;
    b.className = avail[p.key].includes(String(opt)) ? "on" : "";
    if (linked) b.disabled = true;
    else b.onclick = () => toggleChamber(p, String(opt), wrap);
    seg.appendChild(b);
  });
  return wrap;
}

/* 파생값 — 사용자가 직접 못 바꾸고, 위쪽 슬라이더로만 변한다 */
function buildDerived(d) {
  const wrap = document.createElement("div");
  wrap.className = "param derived";
  wrap.innerHTML = `
    <div class="param-label">
      <span class="param-name">${d.name}</span>
      <span class="auto">AUTO</span>
    </div>
    <div class="param-ctrl">
      <div class="derived-val">
        <span data-derived="${d.key}">--</span><em>${d.unit || ""}</em>
      </div>
    </div>`;
  return wrap;
}

function buildParam(p) {
  const wrap = document.createElement("div");
  wrap.className = "param";

  if (p.type === "category") {
    const linked = !!p.mirror;
    if (linked) wrap.classList.add("linked");

    wrap.innerHTML = `
      <div class="param-label">
        <span class="param-name">${p.name}</span>
        <span class="${linked ? "auto" : "mod"}">${linked ? "LINK" : "MOD"}</span>
      </div>
      <div class="param-ctrl"><div class="seg" data-seg="${p.key}"></div></div>`;

    const seg = wrap.querySelector(".seg");
    p.options.forEach(opt => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt;
      b.className = String(opt) === String(params[p.key] ?? p.default) ? "on" : "";
      if (linked) {
        b.disabled = true;
      } else {
        b.onclick = () => {
          seg.querySelectorAll("button").forEach(x => x.classList.remove("on"));
          b.classList.add("on");
          setParam(p, opt, wrap);
        };
      }
      seg.appendChild(b);
    });

    if (linked) {
      const src = mirrorSourceName(p.mirror);
      const note = document.createElement("p");
      note.className = "link-note";
      note.textContent = `${src} 챔버와 동일 (조절 불가)`;
      wrap.querySelector(".param-ctrl").appendChild(note);
    }
    return wrap;
  }

  const dec = decimals(p.step);
  // Process Window 를 쓰지 않으므로 배지는 뜨지 않는다.
  // schema 에 window 가 다시 생기면 자동으로 표시된다.
  const winBadge = p.window
    ? `<span class="win" title="공정 윈도우 ${fmt(p.window.min, dec)} ~ ${fmt(p.window.max, dec)}">PW</span>`
    : "";
  wrap.innerHTML = `
    <div class="param-label">
      <span class="param-name">${p.name}</span>
      ${winBadge}
      <span class="mod">MOD</span>
    </div>
    <div class="param-ctrl">
      <div class="gauge-wrap">
        <div class="gauge">
          <div class="rail"></div>
          <div class="fill"></div>
          <div class="ticks"></div>
          <input type="range" min="${p.min}" max="${p.max}" step="${p.step}"
                 value="${params[p.key] ?? p.default}" data-key="${p.key}" aria-label="${p.name}">
        </div>
        <div class="gauge-scale">
          <span>${fmt(p.min, dec)}</span><span>${fmt(p.max, dec)}</span>
        </div>
      </div>
      <div class="num-wrap">
        <input type="text" inputmode="decimal" class="param-val" data-val="${p.key}"
               value="${toInput(params[p.key] ?? p.default, dec)}" aria-label="${p.name} 값"
               autocomplete="off" spellcheck="false">
        <div class="num-spin">
          <button type="button" class="spin-up" tabindex="-1" aria-label="${p.name} 증가">
            <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M5 1.2 9 5.2H1z"/></svg>
          </button>
          <button type="button" class="spin-dn" tabindex="-1" aria-label="${p.name} 감소">
            <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M5 4.8 9 .8H1z"/></svg>
          </button>
        </div>
      </div>
    </div>`;

  const range = wrap.querySelector("input[type=range]");
  const num = wrap.querySelector("input.param-val");
  paintFill(wrap.querySelector(".fill"), p, params[p.key] ?? p.default);

  range.oninput = () => applyNumeric(p, wrap, parseFloat(range.value));
  num.addEventListener("focus", () => num.select());
  num.oninput = () => {
    const parsed = parseLoose(num.value);
    if (parsed === null || parsed < p.min || parsed > p.max) return;
    applyNumeric(p, wrap, parsed, false);
  };
  num.onblur = () => commitNumber(p, wrap);
  num.onkeydown = e => {
    if (e.key === "Enter") num.blur();
    if (e.key === "ArrowUp") { e.preventDefault(); nudge(p, wrap, 1); }
    if (e.key === "ArrowDown") { e.preventDefault(); nudge(p, wrap, -1); }
  };

  bindSpin(wrap.querySelector(".spin-up"), p, wrap, 1);
  bindSpin(wrap.querySelector(".spin-dn"), p, wrap, -1);
  return wrap;
}

function mirrorParams() {
  return orderedStages().flatMap(s => s.params.filter(p => p.mirror)
    .map(p => ({ key: p.key, source: p.mirror })));
}

function mirrorSourceName(sourceKey) {
  for (const s of orderedStages()) {
    const p = s.params.find(x => x.key === sourceKey);
    if (p) return s.name;
  }
  return sourceKey;
}

/* 현재 선택된 챔버를 '챔버 선택' 줄에 반영 */
function updateChamberMarkers() {
  chamberKeys.forEach(key => {
    const pick = document.querySelector(`[data-pick="${key}"]`);
    if (pick) pick.querySelectorAll("button").forEach(b => {
      b.classList.toggle("on", b.textContent === String(params[key]));
      b.classList.toggle("off", !(avail[key] || []).includes(b.textContent));
    });
  });
}

/* 챔버 선택 (단건 예측 기준) */
function pickChamber(p, opt) {
  params[p.key] = opt;
  previewLane = -1;                       // 수동 선택 → 라인 연동 해제
  lastStage = paramStage[p.key] || lastStage;
  syncMirrors();
  updateChamberMarkers();
  markActiveLane();
  schedulePredict();
}

/* 사용 가능 챔버 토글 (최소 1개는 남긴다) */
function toggleChamber(p, opt, wrap) {
  const cur = avail[p.key] || [];
  const next = cur.includes(opt) ? cur.filter(v => v !== opt) : [...cur, opt];
  if (!next.length) return;

  avail[p.key] = p.options.filter(o => next.includes(String(o)));
  if (!avail[p.key].includes(String(params[p.key])))
    params[p.key] = avail[p.key][0];      // 선택했던 챔버가 꺼지면 첫 가용으로

  wrap.querySelectorAll(".seg button").forEach(b =>
    b.classList.toggle("on", avail[p.key].includes(b.textContent)));
  wrap.classList.toggle("changed", avail[p.key].length !== p.options.length);

  lastStage = paramStage[p.key] || lastStage;
  syncMirrors();
  updateChamberMarkers();
  schedulePredict();
  scheduleRoute();
}

/* 연동 파라미터를 원본 값·가용 목록에 맞춘다 */
function syncMirrors() {
  mirrorParams().forEach(({ key, source }) => {
    if (avail[source]) {
      avail[key] = [...avail[source]];
      const seg = document.querySelector(`[data-seg="${key}"]`);
      if (seg) seg.querySelectorAll("button").forEach(b =>
        b.classList.toggle("on", avail[key].includes(b.textContent)));
    }
    const v = params[source];
    if (v === undefined) return;
    params[key] = v;
    const seg = document.querySelector(`[data-seg="${key}"]`);
    if (seg && !avail[source]) seg.querySelectorAll("button").forEach(b =>
      b.classList.toggle("on", b.textContent === String(v)));
  });
}

function paintFill(fill, p, value) {
  const r = (value - p.min) / (p.max - p.min);
  fill.style.width = `calc((100% - 8px) * ${Math.max(0, Math.min(1, r)).toFixed(4)})`;
}

// ------------------------------------------------------------------ 상태 변경
function setParam(p, value, wrap) {
  params[p.key] = value;
  wrap.classList.toggle("changed", String(value) !== String(defaults[p.key]));
  lastStage = paramStage[p.key] || lastStage;
  syncMirrors();
  schedulePredict();
  scheduleRoute();
}

function applyNumeric(p, wrap, value, rewrite = true) {
  const v = clampRange(p, value);
  if (rewrite) wrap.querySelector("input.param-val").value = toInput(v, decimals(p.step));
  wrap.querySelector("input[type=range]").value = v;
  paintFill(wrap.querySelector(".fill"), p, v);
  setParam(p, v, wrap);
}

function nudge(p, wrap, dir) {
  const cur = parseLoose(wrap.querySelector("input.param-val").value);
  const base = cur === null ? params[p.key] : cur;
  applyNumeric(p, wrap, Number((base + dir * p.step).toFixed(decimals(p.step))));
}

function bindSpin(btn, p, wrap, dir) {
  let hold, repeat;
  const stop = () => { clearTimeout(hold); clearInterval(repeat); };
  btn.addEventListener("mousedown", e => e.preventDefault());
  btn.addEventListener("pointerdown", e => {
    e.preventDefault();
    nudge(p, wrap, dir);
    hold = setTimeout(() => { repeat = setInterval(() => nudge(p, wrap, dir), 60); }, 380);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach(ev =>
    btn.addEventListener(ev, stop));
}

function commitNumber(p, wrap) {
  const parsed = parseLoose(wrap.querySelector("input.param-val").value);
  applyNumeric(p, wrap, parsed === null ? params[p.key] : parsed);
}

function parseLoose(raw) {
  const n = parseFloat(String(raw).replace(/,/g, "").trim());
  return isFinite(n) ? n : null;
}
function clampRange(p, n) {
  if (!isFinite(n)) return p.default;
  return Math.min(p.max, Math.max(p.min, n));
}
function toInput(v, d) { return Number(v).toFixed(d); }

function schedulePredict() {
  clearTimeout(timer);
  timer = setTimeout(predict, DEBOUNCE_MS);
}

async function predict() {
  if (inflight) inflight.abort();
  inflight = new AbortController();
  toggleLoading(true);
  try {
    const res = await fetch(`${API}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params }),
      signal: inflight.signal,
    });
    applyPrediction(await res.json());
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  } finally {
    inflight = null;
    toggleLoading(false);
  }
}

// ------------------------------------------------------------------ 챔버 경로 조합
const LANE_COLORS = ["var(--a-800)", "var(--a-500)", "var(--n-700)", "var(--a-900)"];

function scheduleRoute() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(fetchRoute, 350);
}

async function fetchRoute() {
  if (routeInflight) routeInflight.abort();
  routeInflight = new AbortController();
  try {
    const res = await fetch(`${API}/api/routeset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        params,
        from_stage: lastStage,
        lanes: lastRoute && lastRoute.ok
          ? lastRoute.best.lanes.map(l => l.path) : null,
        available: avail,
        top_n: 3,
      }),
      signal: routeInflight.signal,
    });
    renderRoute(await res.json());
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  } finally {
    routeInflight = null;
  }
}

function renderRoute(r) {
  lastRoute = r;
  if (!r.ok) { set("#route-scope", r.reason || "조합을 만들 수 없습니다."); return; }

  const best = r.best;
  const fixed = r.mode === "fixed";
  document.querySelector(".panel-route").classList.toggle("is-fixed", fixed);

  set("#route-scope", fixed
    ? `${r.source}${r.note ? " · " + r.note : ""}`
    : `라인 ${r.lane_count}개 (병목: ${r.bottleneck.map(shortStage).join(" · ")}) · `
      + `${r.locked_stages.length ? r.locked_stages.map(shortStage).join(" · ") + " 고정 · " : ""}`
      + `${r.search_stages.map(shortStage).join(" · ")} 재탐색 · 조합 ${r.sets_evaluated}개`);

  set("#route-mode", fixed ? "확정 경로" : "모델 탐색");

  drawRouteMap(r, best);

  document.getElementById("lane-list").innerHTML = best.lanes.map((ln, i) => `
    <li data-lane="${i}">
      <span class="lane-dot" style="background:${LANE_COLORS[i]}"></span>
      <span class="lane-name">라인 ${ln.lane}</span>
      <span class="lane-path"><b class="locked">${ln.fixed.join("-")}</b>${
        ln.fixed.length && ln.searched.length ? "-" : ""}${ln.searched.join("-")}</span>
      <span class="lane-y">${fmt(ln.yield, 2)}%${
        fixed ? `<em class="lane-sub">모델 ${fmt(ln.model_yield, 1)}%</em>` : ""}</span>
    </li>`).join("");

  document.querySelectorAll("#lane-list li").forEach(li => {
    li.onclick = () => applyLane(Number(li.dataset.lane));
    li.title = "클릭하면 이 라인 기준으로 예측을 봅니다";
  });

  if (previewLane >= best.lanes.length) previewLane = -1;
  markActiveLane();
  updateChamberMarkers();

  set("#set-avg", `${fmt(best.avg_yield, 2)}%`);
  set("#set-min", fixed ? "데이터 실측" : `최저 ${fmt(best.min_yield, 2)}%`);
  set("#route-cur", fixed ? `${fmt(best.avg_model_yield, 2)}%` : r.current.path);
  set("#route-cur-y", fixed ? "현재 조건 모델 예측"
    : (r.current.yield == null ? "고정 구간 밖" : `${fmt(r.current.yield, 2)}%`));
  set("#route-cur-tag", fixed ? "모델" : "현재");
  set("#route-foot",
      `공정 순서: ${r.stages.map(s => s.name).join(" → ")}`
      + (r.mirrors.length ? " · 이온 챔버는 식각에 연동" : ""));
}

/* 12개 챔버 노드 위에 세 경로를 선으로 잇는다 */
function drawRouteMap(r, best) {
  const W = 276, PAD_L = 30, PAD_T = 26;
  const cols = r.stages.length;
  const rows = Math.max(...r.stages.map(s => s.options.length));
  const dx = (W - PAD_L - 24) / (cols - 1);
  const dy = 42;
  const H = PAD_T + (rows - 1) * dy + 30;

  const cx = i => PAD_L + i * dx;
  const cy = j => PAD_T + j * dy;

  const head = r.stages.map((s, i) =>
    `<text class="rm-head" x="${cx(i)}" y="10" text-anchor="middle">${shortStage(s.name)}</text>`
  ).join("");

  const lock = r.locked_upto;
  let band = "";
  if (lock > 0) {
    const x0 = cx(0) - 17, x1 = cx(lock - 1) + 17;
    band = `<rect class="rm-lock" x="${x0}" y="4" width="${x1 - x0}" height="${H - 12}" rx="6"/>`;
  }

  let nodes = "";
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++)
      {
      const off = !r.stages[i].available.includes(r.stages[i].options[j]);
      nodes += `<circle class="rm-node${i < lock ? " locked" : ""}${off ? " off" : ""}" cx="${cx(i)}" cy="${cy(j)}" r="11"/>
                <text class="rm-num${off ? " off" : ""}" x="${cx(i)}" y="${cy(j)}" text-anchor="middle"
                      dominant-baseline="central">${r.stages[i].options[j]}</text>`;
      }

  const lines = best.lanes.map((ln, k) => {
    const idx = ln.path.split("-").map((v, i) => r.stages[i].options.indexOf(v));
    const off = (k - (best.lanes.length - 1) / 2) * 3.2;
    const pts = idx.map((j, i) => `${cx(i)},${cy(j) + off}`).join(" ");
    return `<polyline class="rm-line" points="${pts}" stroke="${LANE_COLORS[k]}"/>`;
  }).join("");

  document.getElementById("route-map").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%">${band}${head}${lines}${nodes}</svg>`;
}

function shortStage(name) {
  return name.replace("Photo ", "").replace(" 공정", "")
             .replace("Soft Bake", "베이크").replace("Lithography", "리소");
}

/* 라인을 클릭하면 좌측 단건 예측의 기준 라인만 바꾼다.
   사용 가능 챔버 설정(avail)은 건드리지 않는다. */
function applyLane(k) {
  if (!lastRoute || !lastRoute.ok) return;
  const lane = lastRoute.best.lanes[k];
  if (!lane) return;

  previewLane = k;
  Object.entries(lane.chambers).forEach(([key, val]) => { params[key] = val; });
  syncMirrors();
  updateChamberMarkers();
  markActiveLane();
  predict();
}

function markActiveLane() {
  document.querySelectorAll("#lane-list li").forEach((li, i) =>
    li.classList.toggle("active", i === previewLane));
  const lane = lastRoute && lastRoute.ok && previewLane >= 0
    ? lastRoute.best.lanes[previewLane] : null;
  set("#preview-lane", lane ? `라인 ${lane.lane} (${lane.path}) 기준` : "직접 선택한 챔버 기준");
}

// ------------------------------------------------------------------ 결과 반영
function applyPrediction(data) {
  Object.values(data.stages).forEach(outs => outs.forEach(o => {
    const v = fmt(o.value, 2);
    set(`[data-out="${o.key}"]`, v);
    set(`[data-head="${o.key}"]`, v);
    set(`[data-sum="${o.key}"]`, v);

    const b = baselineOut[o.key];
    const el = document.querySelector(`[data-delta="${o.key}"]`);
    if (el && typeof b === "number") {
      const d = o.value - b;
      const flat = Math.abs(d) < Math.max(Math.abs(b), 1) * 1e-6;
      el.className = "delta " + (flat ? "" : d > 0 ? "up" : "down");
      el.textContent = flat ? "동일" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d), 2)}`;
    }
  }));

  Object.values(data.derived || {}).forEach(d =>
    set(`[data-derived="${d.key}"]`, fmt(d.value, 1)));

  const y = data.yield;
  set("#yield-num", fmt(y.value, 2));
  document.getElementById("yield-fill").style.width = `${y.ratio * 100}%`;
  updateDelta(y.value);

  const t = data.target;
  set("#defect-num", fmt(t.value, 0));
  set("#defect-base", `기본값 ${fmt(baselineDefect, 0)}개 / 전체 ${t.total_dies}`);
  set("#sigma-num", processSigma().toFixed(2));
}

function set(sel, text) {
  const el = document.querySelector(sel);
  if (el) el.textContent = text;
}

function updateDelta(value) {
  const el = document.getElementById("yield-delta");
  const panel = document.querySelector(".panel-yield");
  if (baselineYield === null) { el.textContent = "—"; return; }
  const d = value - baselineYield;
  const down = d < -0.005;
  el.className = "delta " + (d > 0.005 ? "up" : down ? "down" : "");
  el.textContent = Math.abs(d) < 0.005 ? "동일"
    : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}%p`;
  if (panel) panel.classList.toggle("is-down", down);
}

/* 파라미터가 기본값에서 얼마나 벗어났는지 (범위 대비 평균 이탈) */
function processSigma() {
  if (!schema) return 0;
  let acc = 0, n = 0;
  schema.stages.forEach(s => s.params.forEach(p => {
    if (p.type !== "number") return;
    const span = p.max - p.min || 1;
    acc += Math.abs(((params[p.key] ?? p.default) - defaults[p.key]) / span);
    n++;
  }));
  return n ? acc / n * 2.5 : 0;
}

/* 수율 최대 / 최저 파라미터 탐색 */
async function optimize(direction) {
  const btns = [document.getElementById("opt-max"), document.getElementById("opt-min")];
  btns.forEach(b => b.disabled = true);
  toggleLoading(true);
  try {
    const res = await fetch(`${API}/api/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params, direction, available: avail }),
    });
    const r = await res.json();
    Object.entries(r.params).forEach(([k, v]) => {
      if (k in params) params[k] = v;
    });
    renderStages();
    syncMirrors();
    updateChamberMarkers();
    applyPrediction(r.prediction);
    const msg = document.getElementById("opt-msg");
    msg.classList.remove("hidden");
    msg.className = "opt-msg " + (direction === "max" ? "up" : "down");
    msg.textContent =
      `${direction === "max" ? "최대" : "최저"} 평균 수율 탐색 · `
      + `${fmt(r.start_yield, 2)}% → ${fmt(r.final_yield, 2)}% `
      + `(${r.rounds}라운드${r.converged ? " 수렴" : " 미수렴"})`;
    scheduleRoute();
  } catch (e) {
    console.error(e);
  } finally {
    btns.forEach(b => b.disabled = false);
    toggleLoading(false);
  }
}

function reset() {
  document.getElementById("opt-msg").classList.add("hidden");
  params = { ...defaults };
  avail = {};
  previewLane = 0;
  renderStages();
  document.getElementById("yield-base").textContent =
    `기본값 ${fmt(baselineYield, 2)}%`;
  lastStage = null;
  lastRoute = null;
  predict();
  scheduleRoute();
}

// ------------------------------------------------------------------ 유틸
function decimals(step) {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}
function fmt(v, d) {
  if (typeof v !== "number" || !isFinite(v)) return v;
  const a = Math.abs(v);
  if (a >= 1e6 || (a > 0 && a < 1e-3)) return v.toExponential(2).replace("e+", "e");
  return v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function toggleLoading(on) {
  document.getElementById("loading").classList.toggle("hidden", !on);
}

init();
