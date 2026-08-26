/* 생산 운영 모니터링 — 라인 상태 표시와 틱 진행 */

const API = "";
let tickMs = 800;

/* Wafer 색은 여러 Wafer 가 한 화면에 겹쳐 나올 때만 쓴다.
   (완료 경로 겹쳐보기, 동승 그룹 목록)
   라인에서는 한 Wafer 가 한 곳에만 있으므로 색을 구분할 이유가 없다. */
const WCOLORS = ["#0E8C7E", "#22C3B0", "#0C7C8C", "#5FD7C7",
                 "#14A08F", "#2FBFD4", "#3ED8C4", "#0A6B60"];
const wcolor = n => WCOLORS[(Number(n) - 1) % WCOLORS.length];

let state = null;
let timer = null;
let selected = null;
let overlay = false;          // 완료 경로 겹쳐보기
let busy = false;             // 요청 중복 방지
let lastDetail = null;
let precise = {};             // {wafer_id: 정밀 예측 결과}

// ------------------------------------------------------------------ 초기화
async function init() {
  const s = await get("/api/monitor/state");
  fillLots(s.lots, s.lot);
  render(s);

  document.getElementById("btn-start").onclick = start;
  document.getElementById("btn-play").onclick = togglePlay;
  document.getElementById("btn-step").onclick = () => tick(1);
  document.getElementById("speed-select").onchange = e => {
    tickMs = Number(e.target.value);
    if (timer) { stopPlay(); togglePlay(); }
  };
}

function fillLots(lots, cur) {
  const sel = document.getElementById("lot-select");
  sel.innerHTML = (lots || []).map(l =>
    `<option value="${l}" ${String(l) === String(cur) ? "selected" : ""}>${l}</option>`).join("");
}

async function get(url) {
  return fetch(API + url).then(r => r.json());
}
async function post(url, body) {
  return fetch(API + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(r => r.json());
}

// ------------------------------------------------------------------ 제어
async function start() {
  stopPlay();
  busy = false;
  precise = {};
  const lot = Number(document.getElementById("lot-select").value);
  selected = null;
  render(await post("/api/monitor/start", { lot, limit: 27 }));
}

async function tick(n) {
  if (busy) return;                 // 앞 요청이 끝나기 전에는 보내지 않는다
  precise = {};                     // 라인이 움직이면 정밀 예측은 무효
  busy = true;
  try {
    render(await post("/api/monitor/tick", { n }));
    if (state && !state.running) stopPlay();
    if (selected) showDetail(selected);
  } finally { busy = false; }
}

function togglePlay() {
  if (timer) { stopPlay(); return; }
  document.getElementById("btn-play").textContent = "일시정지";
  timer = setInterval(() => tick(1), tickMs);
}
function stopPlay() {
  clearInterval(timer);
  timer = null;
  document.getElementById("btn-play").textContent = "시작";
}

// ------------------------------------------------------------------ 렌더
function render(s) {
  state = s;
  document.getElementById("tick-badge").textContent = `tick ${s.tick}`;
  document.getElementById("lot-name").textContent = s.lot == null ? "—" : `LOT ${s.lot}`;

  const m = s.summary;
  document.getElementById("prog-fill").style.width = `${m.progress}%`;
  document.getElementById("prog-text").textContent = `진행률 ${m.progress}%`;
  const ay = document.getElementById("avg-yield");
  ay.textContent = m.avg_yield == null ? "—" : `평균 ${m.avg_yield}%`;
  ay.className = "delta up";

  document.getElementById("mon-stats").innerHTML = [
    ["Total", m.total], ["Waiting", m.waiting],
    ["Running", m.running], ["Completed", m.completed],
  ].map(([k, v]) => `
    <div class="mstat"><span class="mstat-k">${k}</span><b class="mstat-v">${v}</b></div>`
  ).join("");

  const cmp = document.getElementById("gain-box");
  if (m.avg_gain == null) { cmp.classList.add("hidden"); }
  else {
    cmp.classList.remove("hidden");
    cmp.innerHTML = `
      <div class="gain-row"><span>추천 경로</span><b>${m.avg_yield}%</b></div>
      <div class="gain-row"><span>실제 기록 경로</span><b class="base">${m.avg_base_yield}%</b></div>
      <div class="gain-main ${m.avg_gain > 0 ? "up" : m.avg_gain < 0 ? "down" : ""}">
        <span>${m.avg_gain > 0 ? "+" : ""}${m.avg_gain}%p</span>
        <em>개선 ${m.win} · 악화 ${m.lose}</em>
      </div>`;
  }

  renderLine(s);
  renderHistory(s);
  markSelected();
}

function renderLine(s) {
  document.getElementById("line-stages").innerHTML = s.stages.map((st, i) => `
    <div class="lstage">
      <div class="lstage-head">
        <span class="lstage-idx">${String(i + 1).padStart(2, "0")}</span>
        <span class="lstage-name">${st.name}</span>
        ${st.recommend ? "" : `<span class="link-badge">${st.linked_to} 연동</span>`}
        <span class="lstage-meta">${st.ticks} tick${
          st.pending.length ? ` · 대기 ${st.pending.length}` : ""}</span>
      </div>
      <div class="chrow">
        ${st.chambers.map(c => chamberCell(c, st)).join("")}
      </div>
      ${st.pending.length ? `<div class="queue">${
        st.pending.map(w => `<span class="qchip ${w.id === selected ? "sel" : ""}"
          data-w="${w.id}">W${pad(w.num)}</span>`).join("")
      }</div>` : ""}
    </div>`).join("");

  document.querySelectorAll("[data-w]").forEach(el =>
    el.onclick = () => showDetail(el.dataset.w));

  document.querySelectorAll(".chpow[data-stage]").forEach(btn =>
    btn.onclick = async e => {
      e.stopPropagation();
      if (busy) return;
      busy = true;
      try {
        const r = await post("/api/monitor/chamber", {
          stage: btn.dataset.stage, chamber: btn.dataset.ch,
          enabled: btn.dataset.en === "1",
        });
        if (!r.ok) { alert(r.reason); return; }
        render(r.state);
        if (selected) showDetail(selected);
      } finally { busy = false; }
    });
}

function chamberCell(c, st) {
  const run = c.status === "RUNNING" || c.status === "CLOSING";
  const off = c.enabled === false;
  const sel = run && c.wafer === selected;
  const oow = false;                 // 공정 윈도우 미사용
  const toggle = st.recommend
    ? `<button class="chpow" data-stage="${st.id}" data-ch="${c.chamber}"
               data-en="${off ? 1 : 0}"
               title="${off ? "다시 사용" : "사용 중지"}">${off ? "▷" : "◼"}</button>`
    : `<span class="chpow lock" title="${st.linked_to} 연동">🔗</span>`;
  return `
    <div class="chcell ${run ? "run" : ""} ${sel ? "sel" : ""} ${oow ? "oow" : ""} ${off ? "off" : ""}"
         ${run ? `data-w="${c.wafer}"` : ""}>
      <div class="chcell-top">
        <span class="chno">${chLabel(c.chamber)}</span>
        <span class="chst">${c.status}</span>
        ${toggle}
      </div>
      <div class="chwafer">${run ? "W" + pad(c.wafer_num) : "—"}${
        oow ? `<em class="oow-dot" title="공정 윈도우 이탈 ${c.out_of_window}건">!</em>` : ""}</div>
      <div class="chbar"><div class="chfill" style="width:${c.progress}%"></div></div>
      <div class="chpct">${run ? c.progress.toFixed(0) + "%" : ""}</div>
    </div>`;
}

function renderHistory(s) {
  const el = document.getElementById("history");
  if (!s.history.length) { el.innerHTML = `<li class="hint">아직 완료된 Wafer 가 없습니다.</li>`; return; }
  el.innerHTML = `
    <li class="h-ctrl">
      <label><input type="checkbox" id="ov-toggle" ${overlay ? "checked" : ""}>
        완료 경로 겹쳐보기 (최근 5건)</label>
      <span class="h-legend">추천 경로 · 예상 수율 / 실제 기록 경로 대비 개선폭</span>
    </li>` + s.history.map(h => `
    <li data-w="${h.id}" class="${h.id === selected ? "sel" : ""}">
      <span class="h-w">W${pad(h.num)}</span>
      <span class="h-paths">
        <b>${h.path || "—"}</b>
        ${h.base_path ? `<em>실제 ${h.base_path}</em>` : ""}
      </span>
      <span class="h-ys">
        <b>${h.yield.toFixed(2)}%</b>
        ${h.gain == null ? "" :
          `<em class="${h.gain > 0.005 ? "up" : h.gain < -0.005 ? "down" : ""}">${
            h.gain > 0 ? "+" : ""}${h.gain.toFixed(2)}%p</em>`}
      </span>
    </li>`).join("");
  const ov = document.getElementById("ov-toggle");
  if (ov) ov.onchange = e => { overlay = e.target.checked; if (selected) showDetail(selected); };
  el.querySelectorAll("[data-w]").forEach(li =>
    li.onclick = () => showDetail(li.dataset.w));
}

// ------------------------------------------------------------------ 상세
async function showDetail(wid) {
  selected = wid;
  const d = await get(`/api/monitor/wafer/${wid}`);
  const box = document.getElementById("detail");
  document.getElementById("detail-hint").classList.add("hidden");

  if (!d.ok) { box.innerHTML = `<p class="hint">${d.reason}</p>`; return; }

  lastDetail = d;
  markSelected();
  drawTrace(d);

  box.innerHTML = `
    <div class="d-head">
      <b>W${pad(d.num)}</b>
      <span class="d-sub">${d.id}</span>
      <span class="d-tag">${d.status === "done" ? "완료"
        : d.status === "running" ? `${d.stage} ${chLabel(d.chamber)} ${d.progress}%`
        : `${d.stage} 대기`}</span>
    </div>

    ${d.yield != null ? `<div class="d-yield">예상 수율 <b>${d.yield.toFixed(2)}%</b>
      <span class="d-sub">결함 ${d.target.toFixed(0)}개</span></div>` : ""}

    ${d.base_yield != null ? `
      <p class="d-title">추천 경로 vs 실제 기록 경로</p>
      <table class="d-cmp">
        <tr><td>추천</td><td class="p">${d.path.map(p => p.chamber).join("→")}</td>
            <td class="y">${d.yield.toFixed(2)}%</td></tr>
        <tr><td>실제</td><td class="p">${d.base_path}</td>
            <td class="y base">${d.base_yield.toFixed(2)}%</td></tr>
        <tr class="g"><td colspan="2">개선폭</td>
            <td class="y ${d.gain > 0.005 ? "up" : d.gain < -0.005 ? "down" : ""}">${
              d.gain > 0 ? "+" : ""}${d.gain.toFixed(2)}%p</td></tr>
      </table>
      <p class="d-note">같은 공정조건에 챔버만 바꿔 같은 모델로 평가한 값이다.
        실측 수율과 직접 비교하면 모델 오차가 섞이므로 모델끼리 비교한다.</p>` : ""}

    ${(d.out_of_window || []).length ? `
      <p class="d-title warn">공정 윈도우 이탈 ${d.out_of_window.length}건</p>
      <ul class="d-oow">
        ${d.out_of_window.map(o => `
          <li><span>${o.name}</span>
              <b>${o.value}${o.unit}</b>
              <em>${o.side === "low" ? "하한" : "상한"} ${
                o.side === "low" ? o.min : o.max} ${o.side === "low" ? "미만" : "초과"}</em>
          </li>`).join("")}
      </ul>` : ""}

    ${fcBlock(d)}

    <p class="d-title">공정 이력</p>
    <ul class="d-path">
      ${d.path.map(p => `
        <li>
          <span class="p-stage">${short(p.stage)}</span>
          <span class="p-ch">${chLabel(p.chamber)}</span>
          <span class="p-out">${Object.entries(p.outputs)
            .map(([k, v]) => `${k} ${v}`).join(" · ")}</span>
        </li>`).join("") || `<li class="hint">진행 전</li>`}
    </ul>

    ${d.candidates.length ? `
      <p class="d-title">챔버 추천 근거</p>
      <ul class="d-cand">
        ${d.candidates.map(c => `
          <li>
            <span class="c-stage">${short(c.stage)}</span>
            <span class="c-scores">${
              Object.keys(c.scores).length
                ? Object.entries(c.scores).map(([ch, v]) =>
                    `<em class="${String(ch) === String(c.selected) ? "sel" : ""}">${chLabel(ch)} ${v}%</em>`).join("")
                : `<em class="sel">${chLabel(c.selected)}</em><em class="linked">${c.linked || "앞 공정"} 연동</em>`
            }</span>
          </li>`).join("")}
      </ul>` : ""}
  `;

  const pb = document.getElementById("fc-precise");
  if (pb) pb.onclick = () => runPrecise(pb.dataset.w);

  if (precise[d.id]) showPrecise(precise[d.id], d);
  else if (!timer && d.status !== "done") runPrecise(d.id, true);   // 멈춰 있으면 자동
}

/* 라인을 실제로 굴려 충돌·점유까지 반영한 예측 */
async function runPrecise(wid, auto = false) {
  const btn = document.getElementById("fc-precise");
  const box = document.getElementById("fc-result");
  if (btn) { btn.disabled = true; btn.textContent = "점유까지 계산 중…"; }
  if (box) box.innerHTML = `<div class="fc-load"><i></i><i></i><i></i></div>`;

  const wasPlaying = !!timer;
  if (!auto) stopPlay();          // 수동 실행이면 라인을 멈춰 결과를 고정
  try {
    const r = await get(`/api/monitor/forecast/${wid}`);
    if (!r.ok) { if (box) box.innerHTML = `<p class="hint">${r.reason}</p>`; return; }
    precise[wid] = r;
    if (lastDetail && lastDetail.id === wid) showPrecise(r, lastDetail);
  } catch (e) {
    if (box) box.innerHTML = `<p class="hint">계산에 실패했습니다.</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "다시 계산"; }
    if (!auto && wasPlaying) togglePlay();
  }
}

function showPrecise(r, d) {
  const box = document.getElementById("fc-result");
  if (!box) return;
  const simple = ((d && d.forecast && d.forecast.steps) || []).map(s => s.chamber).join("→");
  const exact = r.steps.map(s => s.chamber).join("→");
  const diff = simple !== exact;
  box.innerHTML = `
    <table class="d-cmp fc-cmp">
      <tr><td>빠른 예상</td><td class="p">${simple || "—"}</td>
          <td class="y">${d && d.forecast ? d.forecast.final_yield.toFixed(2) + "%" : "—"}</td></tr>
      <tr><td>정밀 예측</td><td class="p">${exact || "—"}</td>
          <td class="y">${r.final_yield != null ? r.final_yield.toFixed(2) + "%" : "—"}</td></tr>
    </table>
    <p class="d-note ${diff ? "warn" : ""}">${
      diff ? "다른 Wafer 와의 챔버 경합 때문에 경로가 달라진다."
           : "충돌이 없어 빠른 예상과 동일하다."} · ${r.ticks} tick 시뮬레이션</p>`;
}

/* 경로 트레이스
   라인 화면은 "지금 어느 챔버가 점유 중인가"를 보여주므로,
   한 Wafer 의 시간축 경로를 거기에 겹쳐 그리면 서로 다른 시점의 정보가 섞인다.
   그래서 경로는 별도 미니맵(공정 × 챔버 격자)에 그린다. */
function drawTrace(d) {
  const names = d.stage_names, opts = d.options;
  const cols = names.length, rows = Math.max(...opts.map(o => o.length));
  const W = 300, PAD_L = 34, PAD_T = 24, dy = 34;
  const dx = (W - PAD_L - 16) / (cols - 1);
  const H = PAD_T + (rows - 1) * dy + 26;
  const cx = i => PAD_L + i * dx, cy = j => PAD_T + j * dy;

  const head = names.map((n, i) =>
    `<text class="tr-head" x="${cx(i)}" y="9" text-anchor="middle">${short(n)}</text>`).join("");

  let nodes = "";
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < opts[i].length; j++)
      nodes += `<circle class="tr-node" cx="${cx(i)}" cy="${cy(j)}" r="10"/>
                <text class="tr-num" x="${cx(i)}" y="${cy(j)}" text-anchor="middle"
                      dominant-baseline="central">${opts[i][j]}</text>`;

  // 완료 경로 겹쳐보기 (얇고 흐리게)
  let ghosts = "";
  if (overlay && state) {
    state.history.slice(0, 5).forEach(h => {
      if (h.id === d.id || !h.chambers) return;
      const pts = h.chambers.map((c, i) => `${cx(i)},${cy(opts[i].indexOf(String(c)))}`).join(" ");
      ghosts += `<polyline class="tr-ghost" points="${pts}" stroke="${wcolor(h.num)}"/>`;
    });
  }

  const done = d.path.map((p, i) => [i, opts[i].indexOf(String(p.chamber))]);
  const col = "#0E8C7E";                 // 선택한 Wafer 는 항상 강조색
  let line = "";
  if (done.length > 1)
    line = `<polyline class="tr-line" points="${
      done.map(([i, j]) => `${cx(i)},${cy(j)}`).join(" ")}" stroke="${col}"/>`;

  let marks = done.map(([i, j]) =>
    `<circle class="tr-on" cx="${cx(i)}" cy="${cy(j)}" r="10" fill="${col}"/>
     <text class="tr-num on" x="${cx(i)}" y="${cy(j)}" text-anchor="middle"
           dominant-baseline="central">${opts[i][j]}</text>`).join("");

  // 진행 중인 공정은 굵은 점선, 아직 안 간 공정은 얇은 점선으로 이어 붙인다
  const chain = done.slice();
  if (d.status === "running" && d.chamber != null) {
    const i = d.path.length, j = opts[i] ? opts[i].indexOf(String(d.chamber)) : -1;
    if (j >= 0) {
      if (done.length)
        line += `<line class="tr-live" x1="${cx(i - 1)}" y1="${cy(done[done.length - 1][1])}"
                       x2="${cx(i)}" y2="${cy(j)}" stroke="${col}"/>`;
      marks += `<circle class="tr-live-node" cx="${cx(i)}" cy="${cy(j)}" r="11" stroke="${col}"/>
                <text class="tr-num" x="${cx(i)}" y="${cy(j)}" text-anchor="middle"
                      dominant-baseline="central">${opts[i][j]}</text>`;
      chain.push([i, j]);
    }
  }

  const fc = (d.forecast && d.forecast.steps) || [];
  if (fc.length) {
    let prev = chain.length ? chain[chain.length - 1] : null;
    fc.forEach(stp => {
      const i = names.indexOf(stp.stage);
      const j = i >= 0 ? opts[i].indexOf(String(stp.chamber)) : -1;
      if (i < 0 || j < 0) return;
      if (prev)
        line += `<line class="tr-fc" x1="${cx(prev[0])}" y1="${cy(prev[1])}"
                       x2="${cx(i)}" y2="${cy(j)}" stroke="${col}"/>`;
      marks += `<circle class="tr-fc-node" cx="${cx(i)}" cy="${cy(j)}" r="10" stroke="${col}"/>
                <text class="tr-num fc" x="${cx(i)}" y="${cy(j)}" text-anchor="middle"
                      dominant-baseline="central">${opts[i][j]}</text>`;
      prev = [i, j];
    });
  }

  document.getElementById("trace").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%">${ghosts}${head}${line}${nodes}${marks}</svg>`;
}

// ------------------------------------------------------------------ 유틸
function pad(n) {
  return n === null || n === undefined || Number.isNaN(Number(n))
    ? "--" : String(n).padStart(2, "0");
}
function chLabel(v) {
  return v === null || v === undefined || v === "" ? "—" : `Ch${v}`;
}
function fcBlock(d) {
  const f = d.forecast || {};
  const steps = f.steps || [];
  if (!steps.length) return "";
  return `
    <p class="d-title fc">앞으로 갈 예상 경로</p>
    <ul class="d-fc">
      ${steps.map(s => `
        <li>
          <span class="f-stage">${short(s.stage)}</span>
          <span class="f-ch">${chLabel(s.chamber)}</span>
          <span class="f-sc">${
            Object.keys(s.scores || {}).length
              ? Object.entries(s.scores).map(([c, v]) =>
                  `<em class="${String(c) === String(s.chamber) ? "sel" : ""}">${v}%</em>`).join("")
              : `<em class="linked">앞 공정 연동</em>`}</span>
        </li>`).join("")}
    </ul>
    <div class="d-fcsum">예상 최종 수율 <b>${f.final_yield.toFixed(2)}%</b>
      <span class="d-sub">결함 ${f.final_target.toFixed(0)}개</span></div>
    ${(f.cohort || []).length > 1 ? `
      <p class="d-sub co-title">함께 투입되는 Wafer (챔버 중복 없이 배정)</p>
      <ul class="d-co">
        ${f.cohort.map(c => `
          <li class="${c.self ? "me" : ""}">
            <span class="co-dot" style="background:${wcolor(c.num)}"></span>
            <span class="co-w">W${pad(c.num)}</span>
            <span class="co-p">${c.path}</span>
          </li>`).join("")}
      </ul>` : ""}
    <p class="d-note">동승 Wafer 와의 중복은 반영했지만, 챔버 점유 시점은 반영하지 않은 예상이다.</p>
    <button class="fc-btn" id="fc-precise" data-w="${d.id}">챔버 점유까지 반영해 계산</button>
    <div id="fc-result"></div>`;
}

/* 선택한 Wafer 를 라인·대기열·History 에서 즉시 강조한다 */
function markSelected() {
  document.querySelectorAll(".chcell, .qchip, .hist li[data-w]").forEach(el =>
    el.classList.toggle("sel", el.dataset.w === selected));
}

function short(name) {
  return name.replace("Photo ", "").replace(" 공정", "")
             .replace("Soft Bake", "베이크").replace("Lithography", "리소");
}

init();
