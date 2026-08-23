/* 반도체 공정 수율 시뮬레이터 - 프론트엔드
   스키마를 받아 UI를 자동 생성하므로, 공정/파라미터가 바뀌어도
   schema.json 만 고치면 이 파일은 수정할 필요가 없다.

   레이아웃: 게이지는 짧게(--gauge-w) 두고, 남은 공간은 공정별 예측
   열(.stage-pred)이 차지한다. min/max 는 게이지 아래 눈금으로 표시. */

const API = "";                 // 같은 서버에서 서빙
const DEBOUNCE_MS = 120;
// 더미: 실제 웨이퍼 다이 수가 아님. 결함 개수 표시용으로만 사용.
const WAFER_DIES = 533;

let schema = null;
let params = {};                // {key: value}
let defaults = {};
let baselineYield = null;
let baselineStage = {};         // {stage_id: value}
let baselineDefects = null;
let timer = null;
let inflight = null;

// ------------------------------------------------------------------ 초기화
async function init() {
  schema = await fetch(`${API}/api/schema`).then(r => r.json());
  const boot = await fetch(`${API}/api/defaults`).then(r => r.json());

  defaults = boot.params;
  params = { ...boot.params };

  renderStages();

  baselineYield = boot.prediction.yield.value;
  baselineStage = Object.fromEntries(
    Object.entries(boot.prediction.stages).map(([sid, r]) => [sid, r.value])
  );
  document.getElementById("yield-base").textContent =
    `기본값 ${fmt(baselineYield, 2)}%`;

  applyPrediction(boot.prediction);

  document.getElementById("reset-btn").onclick = reset;
}

function orderedStages() {
  return [...schema.stages].sort((a, b) => a.order - b.order);
}

// ------------------------------------------------------------------ UI 생성
function renderStages() {
  const root = document.getElementById("stages");
  root.innerHTML = "";

  orderedStages().forEach((stage, i) => {
    const el = document.createElement("section");
    el.className = "stage";
    el.dataset.stage = stage.id;

    el.innerHTML = `
      <i class="corner tl"></i><i class="corner tr"></i>
      <i class="corner bl"></i><i class="corner br"></i>
      <div class="stage-head">
        <span class="stage-idx">${String(i + 1).padStart(2, "0")}</span>
        <span class="stage-name">${stage.name}</span>
        <span class="stage-head-out">
          <b data-head="${stage.id}">--</b><em>${stage.output.unit || ""}</em>
        </span>
        <span class="chev">▾</span>
      </div>
      <div class="stage-body">
        <div class="params"></div>
        <div class="stage-pred">
          <span class="kicker">STAGE OUTPUT</span>
          <span class="pred-name">${stage.output.name}</span>
          <div class="pred-val">
            <span data-out="${stage.id}">--</span><em>${stage.output.unit || ""}</em>
          </div>
          <div class="pred-row">
            <span>기본값 대비</span>
            <span class="delta" data-delta="${stage.id}">—</span>
          </div>
        </div>
      </div>
    `;

    el.querySelector(".stage-head").onclick = () => el.classList.toggle("collapsed");

    const body = el.querySelector(".params");
    stage.params.forEach(p => body.appendChild(buildParam(p)));

    root.appendChild(el);
  });

  // 요약 리스트
  document.getElementById("summary-list").innerHTML = orderedStages().map((s, i) => `
    <li>
      <span class="s-idx">${String(i + 1).padStart(2, "0")}</span>
      <span class="s-name">${s.output.name}</span>
      <span class="s-out">
        <span class="s-val" data-sum="${s.id}">--</span>
        <span class="s-unit">${s.output.unit || ""}</span>
      </span>
    </li>`).join("");
}

function buildParam(p) {
  const wrap = document.createElement("div");
  wrap.className = "param";

  if (p.type === "category") {
    wrap.innerHTML = `
      <div class="param-label">
        <span class="param-name">${p.name}</span>
        <span class="mod">MOD</span>
      </div>
      <div class="param-ctrl"><div class="seg" data-seg="${p.key}"></div></div>`;

    const seg = wrap.querySelector(".seg");
    p.options.forEach(opt => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt;
      b.className = String(opt) === String(p.default) ? "on" : "";
      b.onclick = () => {
        seg.querySelectorAll("button").forEach(x => x.classList.remove("on"));
        b.classList.add("on");
        setParam(p, opt, wrap);
      };
      seg.appendChild(b);
    });
    return wrap;
  }

  const dec = decimals(p.step);
  wrap.innerHTML = `
    <div class="param-label">
      <span class="param-name">${p.name}</span>
      <span class="mod">MOD</span>
    </div>
    <div class="param-ctrl">
      <div class="gauge-wrap">
        <div class="gauge">
          <div class="rail"></div>
          <div class="fill"></div>
          <div class="ticks"></div>
          <input type="range" min="${p.min}" max="${p.max}" step="${p.step}"
                 value="${p.default}" data-key="${p.key}" aria-label="${p.name}">
        </div>
        <div class="gauge-scale">
          <span>${fmt(p.min, dec)}</span><span>${fmt(p.max, dec)}</span>
        </div>
      </div>
      <div class="num-wrap">
        <input type="text" inputmode="decimal" class="param-val" data-val="${p.key}"
               value="${toInput(p.default, dec)}" aria-label="${p.name} 값" autocomplete="off" spellcheck="false">
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
  const fill = wrap.querySelector(".fill");
  paintFill(fill, p, p.default);

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

/* 게이지가 짧아졌어도 변동 범위는 그대로 — 채움은 폭 대비 비율로 계산 */
function paintFill(fill, p, value) {
  const r = (value - p.min) / (p.max - p.min);
  fill.style.width = `calc((100% - 8px) * ${Math.max(0, Math.min(1, r)).toFixed(4)})`;
}

// ------------------------------------------------------------------ 상태 변경
function setParam(p, value, wrap) {
  params[p.key] = value;
  wrap.classList.toggle("changed", String(value) !== String(defaults[p.key]));
  schedulePredict();
}

function applyNumeric(p, wrap, value, rewrite = true) {
  const v = clampRange(p, value);
  const num = wrap.querySelector("input.param-val");
  const range = wrap.querySelector("input[type=range]");
  const fill = wrap.querySelector(".fill");
  if (rewrite) num.value = toInput(v, decimals(p.step));
  range.value = v;
  paintFill(fill, p, v);
  setParam(p, v, wrap);
}

function nudge(p, wrap, dir) {
  const num = wrap.querySelector("input.param-val");
  const cur = parseLoose(num.value);
  const base = cur === null ? params[p.key] : cur;
  const next = Number((base + dir * p.step).toFixed(decimals(p.step)));
  applyNumeric(p, wrap, next);
}

function bindSpin(btn, p, wrap, dir) {
  let hold, repeat;
  const stop = () => { clearTimeout(hold); clearInterval(repeat); };
  btn.addEventListener("mousedown", e => e.preventDefault());
  btn.addEventListener("pointerdown", e => {
    e.preventDefault();
    nudge(p, wrap, dir);
    hold = setTimeout(() => { repeat = setInterval(() => nudge(p, wrap, dir), 50); }, 380);
  });
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
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

function toInput(v, d) {
  return Number(v).toFixed(d);
}

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

// ------------------------------------------------------------------ 결과 반영
function applyPrediction(data) {
  Object.entries(data.stages).forEach(([sid, r]) => {
    const v = fmt(r.value, 2);
    set(`[data-out="${sid}"]`, v);
    set(`[data-head="${sid}"]`, v);
    set(`[data-sum="${sid}"]`, v);

    const b = baselineStage[sid];
    if (typeof b === "number") {
      const d = r.value - b;
      const el = document.querySelector(`[data-delta="${sid}"]`);
      if (el) {
        const flat = Math.abs(d) < Math.abs(b || 1) * 1e-6;
        el.className = "delta " + (flat ? "" : d > 0 ? "up" : "down");
        el.textContent = flat ? "동일" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d), 2)}`;
      }
    }
  });

  const y = data.yield;
  set("#yield-num", fmt(y.value, 2));
  document.getElementById("yield-fill").style.width = `${y.ratio * 100}%`;
  updateDelta(y.value);
  updateYieldExtras(y.value);
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
  el.textContent = Math.abs(d) < 0.005
    ? "동일"
    : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}%p`;
  if (panel) panel.classList.toggle("is-down", down);
}

function diesFromYield(y) {
  // 더미: 수율로 불량 다이를 역산. 실측 결함 데이터가 아님.
  const rate = Math.max(0, Math.min(100, y)) / 100;
  const good = Math.round(WAFER_DIES * rate);
  return { defect: WAFER_DIES - good, total: WAFER_DIES };
}

function processSigma() {
  // 더미: 파라미터 기본값 대비 이탈을 σ처럼 보이게 스케일한 값.
  if (!schema) return 0;
  let acc = 0, n = 0;
  schema.stages.forEach(s => {
    s.params.forEach(p => {
      if (p.type !== "number") return;
      const span = p.max - p.min || 1;
      const cur = params[p.key] ?? p.default;
      acc += Math.abs((cur - defaults[p.key]) / span);
      n++;
    });
  });
  return n ? acc / n * 2.5 : 0;
}

function updateYieldExtras(yieldValue) {
  // 더미: 기준 결함 개수(예: 217)는 초기 스텁 수율에서 계산됨.
  const { defect } = diesFromYield(yieldValue);
  if (baselineDefects === null) baselineDefects = defect;
  set("#defect-num", String(defect));
  set("#defect-base", `기준 ${baselineDefects}개`);
  set("#sigma-num", processSigma().toFixed(2));
}

function reset() {
  params = { ...defaults };
  renderStages();
  document.getElementById("yield-base").textContent =
    `기본값 ${fmt(baselineYield, 2)}%`;
  predict();
}

// ------------------------------------------------------------------ 유틸
function decimals(step) {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}
function fmt(v, d) {
  if (typeof v !== "number" || !isFinite(v)) return v;
  const a = Math.abs(v);
  if (a >= 1e6 || (a > 0 && a < 1e-3)) {
    return v.toExponential(2).replace("e+", "e").replace("e-", "e-");
  }
  return v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function toggleLoading(on) {
  document.getElementById("loading").classList.toggle("hidden", !on);
}

init();
