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

  applyPrediction(boot.prediction);
  document.getElementById("reset-btn").onclick = reset;
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
      body.appendChild(buildParam(p));
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
               value="${toInput(p.default, dec)}" aria-label="${p.name} 값"
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
  paintFill(wrap.querySelector(".fill"), p, p.default);

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
  if (a >= 1e6 || (a > 0 && a < 1e-3)) return v.toExponential(2).replace("e+", "e");
  return v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function toggleLoading(on) {
  document.getElementById("loading").classList.toggle("hidden", !on);
}

init();
