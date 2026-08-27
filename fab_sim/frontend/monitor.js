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
let fcCache = null;             // {wid, stage_idx, chamber, forecast} 예상 경로 캐시
let lastDetailAt = 0;           // 상세 갱신 간격 제한용
let detailBusy = false;
let routeStage = null;          // 경로를 보고 있는 공정
let routeBusy = false;
let routeData = null;
const CH_COLORS = ["#0E8C7E", "#E8814A", "#3F7AC4"];   // Ch1 / Ch2 / Ch3

// ------------------------------------------------------------------ 초기화
async function init() {
  const s = await get("/api/monitor/state");
  fillDates(s.dates, s.date, s);
  render(s);

  document.getElementById("btn-start").onclick = start;
  document.getElementById("btn-play").onclick = togglePlay;
  document.getElementById("btn-step").onclick = () => tick(1);
  document.getElementById("speed-select").onchange = e => {
    tickMs = Number(e.target.value);
    if (timer) { stopPlay(); togglePlay(); }
  };
}

function fillDates(dates, cur) {
  const sel = document.getElementById("date-select");
  sel.innerHTML = (dates || []).map(d =>
    `<option value="${d}" ${d === cur ? "selected" : ""}>${d}</option>`).join("");
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
  const date = document.getElementById("date-select").value;
  const limit = Number(document.getElementById("limit-select").value);
  selected = null;
  fcCache = null;
  routeStage = null; routeData = null;
  document.getElementById("rp-stage").textContent = "—";
  document.getElementById("rp-hint").textContent = "왼쪽에서 공정 이름을 클릭하십시오.";
  document.getElementById("rp-hint").classList.remove("hidden");
  document.getElementById("rp-sum").classList.add("hidden");
  document.getElementById("rp-cards").innerHTML = "";
  render(await post("/api/monitor/start", { date, limit }));
}

async function tick(n) {
  if (busy) return;                 // 앞 요청이 끝나기 전에는 보내지 않는다
  busy = true;
  try {
    render(await post("/api/monitor/tick", { n }));
    if (state && !state.running) stopPlay();
    if (selected && !detailBusy && Date.now() - lastDetailAt > 500) {
      showDetail(selected, true);
    }
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
  document.getElementById("lot-name").textContent = s.date || "—";
  const info = s.day_info || {};
  document.getElementById("day-sub").textContent = s.date
    ? `Lot ${(s.day_lots || []).join(" · ")}  ·  투입 ${s.summary.total}장`
      + (s.day_total && s.day_total !== s.summary.total ? ` / 그날 전체 ${s.day_total}장` : "")
    : "날짜를 고르고 투입을 누르십시오";

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
  if (routeStage && !routeBusy && timer) refreshRoutes();
  markSelected();
}

function renderLine(s) {
  document.getElementById("line-stages").innerHTML = s.stages.map((st, i) => `
    <div class="lstage">
      <div class="lstage-head ${routeStage === st.id ? "picked" : ""}" data-stage="${st.id}">
        <span class="lstage-idx">${String(i + 1).padStart(2, "0")}</span>
        <span class="lstage-name">${st.name}</span>
        <span class="rbtn ${routeStage === st.id ? "on" : ""}">경로</span>
        ${st.recommend ? "" : `<span class="link-badge">${st.linked_to} 연동</span>`}
        <span class="lstage-meta">${st.ticks} tick${
          st.pending.length ? ` · 대기 ${st.pending.length}` : ""}</span>
      </div>
      <div class="chrow">
        ${st.chambers.map(c => chamberCell(c, st)).join("")}
      </div>
      ${st.pending.length ? `<div class="queue">${
        st.pending.map(w => `<span class="qchip ${w.id === selected ? "sel" : ""}"
          data-w="${w.id}">W${pad(w.num)}<em>L${w.lot}</em></span>`).join("")
      }</div>` : ""}
    </div>`).join("");

  document.querySelectorAll("[data-w]").forEach(el =>
    el.onclick = () => showDetail(el.dataset.w));

  document.querySelectorAll(".lstage-head[data-stage]").forEach(el =>
    el.onclick = e => {
      if (e.target.closest(".chpow")) return;
      showRoutes(el.dataset.stage);
    });

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
        if (selected && !detailBusy && Date.now() - lastDetailAt > 500) {
      showDetail(selected, true);
    }
      } finally { busy = false; }
    });
}

/* 공정을 누르면 그 공정의 Wafer 들이 앞으로 갈 최적 경로를 카드로 보여준다 */
async function showRoutes(stageId) {
  if (routeBusy) return;
  routeBusy = true;
  routeStage = stageId;
  renderLine(state);
  document.getElementById("rp-hint").textContent = "계산 중…";
  document.getElementById("rp-hint").classList.remove("hidden");
  document.getElementById("rp-sum").classList.add("hidden");
  document.getElementById("rp-cards").innerHTML = "";
  try {
    const r = await get(`/api/monitor/stage/${stageId}/routes`);
    renderRoutes(r);
  } finally { routeBusy = false; }
}

function renderRoutes(r) {
  const hint = document.getElementById("rp-hint");
  const sum = document.getElementById("rp-sum");
  const box = document.getElementById("rp-cards");

  if (!r.ok) {
    document.getElementById("rp-stage").textContent = "";
    hint.textContent = r.reason;
    hint.classList.remove("hidden");
    sum.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  routeData = r;
  document.getElementById("rp-stage").textContent = r.stage_name;
  hint.classList.add("hidden");
  sum.classList.remove("hidden");

  const k = r.stage_index;
  const names = r.stage_names.slice(k);

  sum.innerHTML = `
    <span class="rs-label">조합 평균 예상 수율</span>
    <b class="rs-val">${r.avg_yield.toFixed(2)}<em>%</em></b>
    <span class="rs-note">세 Wafer 를 함께 놓고 챔버가 겹치지 않는 조합 중
      합이 가장 큰 배정</span>`;

  box.innerHTML = r.lanes.map((ln, i) => {
    const col = CH_COLORS[i % CH_COLORS.length];
    const steps = ln.chambers.slice(k);
    return `
    <div class="rcard" style="--rc:${col}" data-w="${ln.id}">
      <div class="rcard-top">
        <span class="rc-ch">Ch${ln.chamber}</span>
        <span class="rc-w">W${pad(ln.num)}<em>L${ln.lot}</em></span>
        <span class="rc-y">${ln.yield.toFixed(2)}<em>%</em></span>
      </div>
      <div class="rc-steps">
        ${steps.map((ch, j) => `
          ${j ? '<span class="rc-arrow">→</span>' : ""}
          <span class="rc-step ${j === 0 ? "now" : ""}">
            <em>${short(names[j])}</em><b>${ch}</b>
          </span>`).join("")}
      </div>
      ${renderScores(ln, r, k)}
    </div>`;
  }).join("");

  box.querySelectorAll(".rcard").forEach(el =>
    el.onclick = () => showDetail(el.dataset.w));
}

/* 다음 공정의 챔버 후보 점수 (선택된 것 강조) */
function renderScores(ln, r, k) {
  const nextId = r.stage_names.length > k + 1
    ? Object.keys(ln.scores)[0] : null;
  const sc = nextId ? ln.scores[nextId] : null;
  if (!sc) return "";
  const pick = ln.future[0];
  return `
    <div class="rc-scores">
      <span class="rc-sl">다음 공정 후보</span>
      ${Object.entries(sc).map(([ch, v]) =>
        `<span class="rc-sc ${String(ch) === String(pick) ? "on" : ""}">Ch${ch} ${v}%</span>`
      ).join("")}
    </div>`;
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
        run && c.lot != null ? `<em class="wlot">L${c.lot}</em>` : ""}${
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
      <span class="h-w">W${pad(h.num)}<em class="wlot">L${h.lot}</em></span>
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
async function showDetail(wid, light = false) {
  selected = wid;
  if (detailBusy) return;
  detailBusy = true;
  try {
    await renderDetail(wid, light);
  } finally {
    detailBusy = false;
    lastDetailAt = Date.now();
  }
}

async function renderDetail(wid, light) {

  // 진행률만 갱신할 때는 예상 경로 계산을 건너뛴다 (0.5초 → 즉시)
  let d = await get(`/api/monitor/wafer/${wid}?forecast=${light ? 0 : 1}`);

  if (!d.ok) { /* 아래에서 처리 */ }
  else if (light) {
    const same = fcCache && fcCache.wid === wid
      && fcCache.stage_idx === d.stage_idx && fcCache.chamber === d.chamber;
    if (same) {
      d.forecast = fcCache.forecast;          // 캐시 재사용
    } else {
      d = await get(`/api/monitor/wafer/${wid}`);   // 공정이 바뀌었으면 다시 계산
      fcCache = { wid, stage_idx: d.stage_idx, chamber: d.chamber, forecast: d.forecast };
    }
  } else {
    fcCache = { wid, stage_idx: d.stage_idx, chamber: d.chamber, forecast: d.forecast };
  }
  const box = document.getElementById("detail");
  document.getElementById("detail-hint").classList.add("hidden");

  if (!d.ok) { box.innerHTML = `<p class="hint">${d.reason}</p>`; return; }

  lastDetail = d;
  markSelected();
  drawTrace(d);

  box.innerHTML = `
    <div class="d-head">
      <b>W${pad(d.num)}</b>
      <span class="d-lot">Lot ${d.lot}</span>
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

}

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
    <p class="d-note">진입 시점에 다시 계산되므로 실제 배정과 달라질 수 있다.</p>`;
}

/* 선택한 Wafer 를 라인·대기열·History 에서 즉시 강조한다 */
let lastRouteAt = 0;
async function refreshRoutes() {
  if (Date.now() - lastRouteAt < 1200) return;
  lastRouteAt = Date.now();
  routeBusy = true;
  try { renderRoutes(await get(`/api/monitor/stage/${routeStage}/routes`)); }
  finally { routeBusy = false; }
}

function markSelected() {
  document.querySelectorAll(".chcell, .qchip, .hist li[data-w]").forEach(el =>
    el.classList.toggle("sel", el.dataset.w === selected));
}

function short(name) {
  return name.replace("Photo ", "").replace(" 공정", "")
             .replace("Soft Bake", "베이크").replace("Lithography", "리소");
}

init();
