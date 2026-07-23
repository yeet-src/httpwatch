// httpwatch browser client.
//
// Hydrates from window.__BOOT__ (the snapshot the server inlined), then keeps
// itself live over SSE (/events). Rendering is plain DOM — a sortable endpoint
// table plus a detail panel (percentiles, status chips, SVG sparklines) that
// mirrors the TUI's detail screen. No framework, no build step.

// ── formatters (ported from agent/src/lib/format.js) ────────────────────────
const fmtCount = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e4 ? (n / 1e3).toFixed(0) + "k" :
  n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);

function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + u[i];
}

function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "now";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms >= 1000) return (ms / 1000).toFixed(2) + "s";
  if (ms >= 10) return Math.round(ms) + "ms";
  if (ms >= 1) return ms.toFixed(1) + "ms";
  return ms.toFixed(2) + "ms";
}

const statusClass = (code) => code >= 500 ? "s5" : code >= 400 ? "s4" : code >= 300 ? "s3" : code >= 200 ? "s2" : "";
const methodClass = (m) => ["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS","CONNECT","TRACE"].includes(m) ? "m-" + m : "m-other";

// ── state ────────────────────────────────────────────────────────────────
const boot = window.__BOOT__ || {};
let snapshot = boot.snapshot || null;
let selectedKey = null;
let sortKey = "count";
let sortDir = -1; // -1 desc, 1 asc

// Rolling log of individual completed requests (newest last), accumulated from
// each snapshot's `recent` delta. Each event gets a monotonic __seq so the
// detail stream can append only genuinely-new rows (preserving scroll).
let recent = [];
let seqCounter = 0;
const RECENT_MAX = 5000;
const REQ_STREAM_ROWS = 150; // most recent requests kept in the stream per route
function ingestRecent(arr) {
  for (const e of arr) { e.__seq = ++seqCounter; recent.push(e); }
  if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX);
}
if (Array.isArray(boot.snapshot?.recent)) ingestRecent(boot.snapshot.recent);

// Detail request-stream cursor: which route it's showing and the highest __seq
// already rendered, so each snapshot only prepends the new pairs.
const streamState = { key: null, lastSeq: 0 };

// Interface state, driven by the exporter's snapshot.ifaces.
let availIfaces = boot.snapshot?.ifaces?.available || [];
let watching = boot.snapshot?.ifaces?.watching || boot.config?.iface || null;

const el = {
  rows: document.getElementById("rows"),
  table: document.getElementById("table"),
  empty: document.getElementById("empty"),
  totals: document.getElementById("totals"),
  iface: document.getElementById("iface"),
  conn: document.getElementById("conn"),
  detail: document.getElementById("detail"),
  detailBody: document.getElementById("detail-body"),
  detailClose: document.getElementById("detail-close"),
  footLeft: document.getElementById("foot-left"),
  layout: document.querySelector(".layout"),
};

// ── sorting ──────────────────────────────────────────────────────────────
function sortedEndpoints() {
  const eps = (snapshot?.endpoints || []).slice();
  const k = sortKey;
  eps.sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === "method" || k === "host" || k === "path") {
      av = String(av); bv = String(bv);
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    }
    if (k === "last") { av = a.last; bv = b.last; } // most-recent = larger ts
    av = av ?? -Infinity; bv = bv ?? -Infinity;
    return (av - bv) * sortDir;
  });
  return eps;
}

document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = (k === "method" || k === "host" || k === "path") ? 1 : -1; }
    document.querySelectorAll("th.sortable").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
    th.classList.add(sortDir === -1 ? "sorted-desc" : "sorted-asc");
    renderTable();
  });
});

// ── table render ───────────────────────────────────────────────────────────
function renderTable() {
  const eps = sortedEndpoints();
  el.empty.style.display = eps.length ? "none" : "flex";

  const frag = document.createDocumentFragment();
  const now = snapshot?.ts || Date.now();
  eps.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.key = r.key;
    if (r.key === selectedKey) tr.classList.add("selected");

    const rate = r.rate > 0
      ? `<span class="live">${r.rate}</span>`
      : `<span class="idle">·</span>`;

    tr.innerHTML =
      `<td class="col-rank">${i + 1}</td>` +
      `<td class="col-method"><span class="method ${methodClass(r.method)}">${esc(r.method)}</span></td>` +
      `<td class="col-host host" title="${esc(r.host)}">${esc(r.host)}</td>` +
      `<td class="col-path path" title="${esc(r.path)}">${esc(r.path)}</td>` +
      `<td class="col-num col-count"><b>${fmtCount(r.count)}</b></td>` +
      `<td class="col-num col-rate">${rate}</td>` +
      `<td class="col-num col-p95">${fmtMs(r.p95)}</td>` +
      `<td class="col-last">${fmtAgo(now - r.last)}</td>`;

    tr.addEventListener("click", () => selectEndpoint(r.key));
    frag.appendChild(tr);
  });
  el.rows.replaceChildren(frag);
}

function renderTotals() {
  const t = snapshot?.totals;
  if (!t) { el.totals.textContent = ""; el.footLeft.textContent = ""; return; }
  el.totals.innerHTML =
    `<span><b>${fmtCount(t.reqs)}</b> reqs</span>` +
    `<span><b>${t.endpoints}</b> endpoints</span>` +
    `<span><b>${fmtBytes(t.bytes)}</b> on the wire</span>`;
  el.footLeft.textContent = `uptime ${fmtUptime(t.uptimeMs)} · last update ${new Date(snapshot.ts).toLocaleTimeString()}`;
}

// ── interface picker ────────────────────────────────────────────────────────
// The "iface" pill is a button; clicking it opens a popover of every up
// interface. Picking a subset (or "all") POSTs /api/iface, which restarts the
// probe on those interfaces. An empty selection means all interfaces.
function renderIface() {
  const label = watching && /^all\b/i.test(watching) ? "all" : (watching || "all");
  el.iface.textContent = `iface: ${label} ▾`;
  el.iface.classList.add("clickable");
}

function selectedIfaceSet() {
  if (!watching || /^all\b/i.test(watching)) return new Set(); // empty = all
  return new Set(watching.split(",").map((s) => s.trim()).filter(Boolean));
}

let ifacePop = null;
function closeIfacePop() { if (ifacePop) { ifacePop.remove(); ifacePop = null; document.removeEventListener("click", onDocClickForPop, true); } }

function onDocClickForPop(e) {
  if (ifacePop && !ifacePop.contains(e.target) && e.target !== el.iface) closeIfacePop();
}

function openIfacePop() {
  if (ifacePop) { closeIfacePop(); return; }
  const chosen = selectedIfaceSet();
  ifacePop = document.createElement("div");
  ifacePop.className = "popover iface-pop";
  ifacePop.innerHTML =
    `<div class="pop-title">Watch interfaces</div>` +
    `<label class="pop-item"><input type="checkbox" value="__all__" ${chosen.size === 0 ? "checked" : ""}/> <span>All interfaces</span></label>` +
    `<div class="pop-sep"></div>` +
    (availIfaces.length
      ? availIfaces.map((n) => `<label class="pop-item"><input type="checkbox" value="${esc(n)}" ${chosen.has(n) ? "checked" : ""}/> <span>${esc(n)}</span></label>`).join("")
      : `<div class="pop-empty">no interfaces reported</div>`) +
    `<div class="pop-actions"><button class="pop-apply">Apply</button></div>`;

  // Position under the pill.
  const r = el.iface.getBoundingClientRect();
  ifacePop.style.top = `${r.bottom + 6}px`;
  ifacePop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  document.body.appendChild(ifacePop);

  const allCb = ifacePop.querySelector('input[value="__all__"]');
  const ifaceCbs = [...ifacePop.querySelectorAll('input:not([value="__all__"])')];
  // "All" and specific interfaces are mutually exclusive.
  allCb.addEventListener("change", () => { if (allCb.checked) ifaceCbs.forEach((c) => (c.checked = false)); });
  ifaceCbs.forEach((c) => c.addEventListener("change", () => { if (c.checked) allCb.checked = false; if (!ifaceCbs.some((x) => x.checked)) allCb.checked = true; }));

  ifacePop.querySelector(".pop-apply").addEventListener("click", () => {
    const picked = ifaceCbs.filter((c) => c.checked).map((c) => c.value);
    const iface = allCb.checked ? "" : picked.join(",");
    closeIfacePop();
    postIface(iface);
  });

  setTimeout(() => document.addEventListener("click", onDocClickForPop, true), 0);
}

async function postIface(iface) {
  setConn("conn-wait", "switching interface…");
  recent = []; // captured on the old interface set — drop it
  try {
    const res = await fetch("/api/iface", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ iface }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) setConn("conn-off", "interface change failed");
    else watching = j.iface || "all";
    renderIface();
  } catch {
    setConn("conn-off", "interface change failed");
  }
}

// ── detail panel ───────────────────────────────────────────────────────────
function selectEndpoint(key) {
  selectedKey = key;
  streamState.key = key;
  streamState.lastSeq = 0; // renderDetail fills the stream and sets the cursor
  el.detail.classList.add("open");
  renderTable();
  renderDetail();
}

function closeDetail() {
  selectedKey = null;
  streamState.key = null;
  el.detail.classList.remove("open");
  renderTable();
}
el.detailClose.addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

function currentEndpoint() {
  return (snapshot?.endpoints || []).find((r) => r.key === selectedKey) || null;
}

/* Aggregate block (everything above the stream). Re-rendered each snapshot. */
function aggHtml(r) {
  const now = snapshot.ts;
  const t = snapshot.totals;
  const share = t.reqs ? (r.count / t.reqs) * 100 : 0;
  const latLine = r.latN
    ? `p50 <b>${fmtMs(r.p50)}</b> · p95 <b>${fmtMs(r.p95)}</b> · max <b>${fmtMs(r.latMax)}</b> <span class="dim">· ${r.latN} samples</span>`
    : `<span class="dim">no responses paired yet</span>`;
  const chips = Object.entries(r.status).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const chipHtml = chips.length
    ? `<div class="chips">${chips.map(([code, n]) =>
        `<span class="chip ${statusClass(+code)}"><span class="code">${esc(code)}</span><span class="n"> ×${n}</span></span>`).join("")}</div>`
    : `<div class="spark-empty">— no responses paired yet</div>`;
  return `<div class="d-endpoint"><span class="method ${methodClass(r.method)}">${esc(r.method)}</span> ` +
      `<span class="host">${esc(r.host)}</span><span class="path">${esc(r.path)}</span></div>` +
    `<dl class="fields">` +
      `<dt>Requests</dt><dd><span class="big">${fmtCount(r.count)}</span> <span class="dim">(${r.count})</span></dd>` +
      `<dt>Share</dt><dd>${share.toFixed(1)}% of all requests</dd>` +
      `<dt>Req/s now</dt><dd>${r.rate > 0 ? r.rate : "0"} <span class="dim">· peak ${r.peak}/s</span></dd>` +
      `<dt>Latency</dt><dd>${latLine}</dd>` +
      `<dt>Bytes</dt><dd>${fmtBytes(r.bytes)} <span class="dim">on the wire</span></dd>` +
      `<dt>First seen</dt><dd>${fmtAgo(now - r.first)} ago</dd>` +
      `<dt>Last seen</dt><dd>${fmtAgo(now - r.last)} ago</dd>` +
    `</dl>` +
    `<div><dt style="font-family:var(--mono);color:var(--fg-faint);font-size:12px">Status codes</dt>${chipHtml}</div>` +
    `<div class="spark-block"><h3>Req/s, last minute</h3>${sparkSvg(r.hist, "var(--accent)", r.peak)}</div>`;
}

/* One request row. `newRow` adds a brief highlight for freshly-arrived rows. */
function reqRowHtml(e, newRow) {
  const cls = statusClass(e.code) || "s0";
  const d = new Date(e.ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(e.ts % 1000).padStart(3, "0");
  return `<div class="req-row ${cls}${newRow ? " fresh" : ""}">` +
    `<span class="req-code">${e.code || "—"}</span>` +
    `<span class="req-lat">${fmtMs(e.ms)}</span>` +
    `<span class="req-time">${hh}:${mm}:${ss}.${ms}</span>` +
  `</div>`;
}

/* Full detail render — called when a route is selected. Builds the aggregate
 * block + an empty stream container, then fills the stream and sets the cursor
 * so later snapshots only prepend new rows. */
function renderDetail() {
  const r = currentEndpoint();
  const agg = r ? aggHtml(r) : `<div class="spark-empty">endpoint no longer tracked — pick another row</div>`;
  el.detailBody.innerHTML =
    `<div id="d-agg">${agg}</div>` +
    `<div class="spark-block req-block"><h3>Live requests · newest first</h3><div id="req-stream" class="req-stream"></div></div>`;

  const stream = document.getElementById("req-stream");
  const initial = [];
  for (let i = recent.length - 1; i >= 0 && initial.length < REQ_STREAM_ROWS; i--) {
    if (recent[i].key === selectedKey) initial.push(recent[i]);
  }
  streamState.lastSeq = seqCounter; // everything up to now is accounted for
  if (!initial.length) {
    stream.innerHTML = `<div class="spark-empty" style="padding:10px">no completed requests captured yet — waiting for responses…</div>`;
  } else {
    stream.innerHTML = initial.map((e) => reqRowHtml(e, false)).join(""); // already newest-first
  }
}

/* Snapshot-time refresh — update the aggregate numbers and prepend only the
 * request rows that arrived since the last render, preserving the user's scroll. */
function refreshDetail() {
  if (!selectedKey) return;
  const r = currentEndpoint();
  const aggEl = document.getElementById("d-agg");
  if (aggEl) aggEl.innerHTML = r ? aggHtml(r) : `<div class="spark-empty">endpoint no longer tracked — pick another row</div>`;

  const stream = document.getElementById("req-stream");
  if (!stream) return;

  // New events for this route, oldest→newest so inserting each at the top
  // leaves the newest on top.
  const fresh = [];
  for (const e of recent) {
    if (e.__seq > streamState.lastSeq && e.key === selectedKey) fresh.push(e);
  }
  if (!fresh.length) return;
  streamState.lastSeq = seqCounter;

  const placeholder = stream.querySelector(".spark-empty");
  if (placeholder) stream.innerHTML = "";

  const atTop = stream.scrollTop <= 3;
  const prevH = stream.scrollHeight;
  const html = fresh.map((e) => reqRowHtml(e, true)).join("");
  stream.insertAdjacentHTML("afterbegin", html);

  // Trim to the cap.
  while (stream.children.length > REQ_STREAM_ROWS) stream.removeChild(stream.lastElementChild);

  // Keep the viewport stable: stick to top if already there, else offset by the
  // height we just prepended so the user's row stays put.
  if (!atTop) stream.scrollTop += stream.scrollHeight - prevH;
}

// ── SVG sparkline ────────────────────────────────────────────────────────
function sparkSvg(values, color, forceMax) {
  if (!values || values.length === 0) return `<div class="spark-empty">no samples yet</div>`;
  const W = 100, H = 100; // viewBox units; CSS scales to the container
  const hi = Math.max(forceMax || 0, 1, ...values);
  const n = values.length;
  const bw = W / n;
  let bars = "";
  for (let i = 0; i < n; i++) {
    const h = Math.max(0, (values[i] / hi) * H);
    const x = i * bw;
    const y = H - h;
    bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.4, bw - 0.3).toFixed(2)}" height="${h.toFixed(2)}" fill="${color}" opacity="0.9"/>`;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}

// ── util ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setConn(state, text) {
  el.conn.className = "pill " + state;
  el.conn.textContent = text;
}

// ── live feed ──────────────────────────────────────────────────────────────
function applySnapshot(snap) {
  // Interface changed under us (runtime switch) → drop stale request history.
  const newWatching = snap.ifaces?.watching ?? snap.iface ?? watching;
  if (watching && newWatching && newWatching !== watching) recent = [];
  watching = newWatching;
  if (snap.ifaces?.available) availIfaces = snap.ifaces.available;

  // Accumulate the streamed request/response deltas (tags each with __seq).
  if (Array.isArray(snap.recent) && snap.recent.length) ingestRecent(snap.recent);

  snapshot = snap;
  renderTotals();
  renderIface();
  renderTable();
  refreshDetail();
}

function connect() {
  const es = new EventSource("/events");
  es.addEventListener("open", () => setConn("conn-on", "live"));
  es.addEventListener("snapshot", (e) => {
    try { applySnapshot(JSON.parse(e.data)); setConn("conn-on", "live"); } catch { /* ignore */ }
  });
  es.addEventListener("status", (e) => {
    try {
      const st = JSON.parse(e.data);
      if (st.state === "connected" || st.state === "hello") setConn("conn-wait", "waiting for traffic…");
      else if (st.state === "error") setConn("conn-off", "exporter error");
      else if (st.state === "isolate-gone") setConn("conn-wait", "restarting probe…");
      else if (st.state === "spawning" || st.state === "spawned") setConn("conn-wait", "starting probe…");
    } catch { /* ignore */ }
  });
  es.addEventListener("error", () => setConn("conn-off", "reconnecting…"));
}

// ── login gate ──────────────────────────────────────────────────────────────
const gate = {
  el: document.getElementById("gate"),
  btn: document.getElementById("gate-login"),
  link: document.getElementById("gate-link"),
  url: document.getElementById("gate-url"),
  err: document.getElementById("gate-error"),
};
let authPoll = null;

function showGate() {
  gate.el.hidden = false;
  gate.btn.disabled = false;
}
function hideGate() {
  gate.el.hidden = true;
  if (authPoll) { clearInterval(authPoll); authPoll = null; }
}

async function beginLogin() {
  gate.btn.disabled = true;
  gate.err.hidden = true;
  // Open the tab NOW, synchronously in the click handler, so the browser counts
  // it as user-initiated (not popup-blocked). We point it at the URL once the
  // server returns it; the on-page link stays as a fallback.
  const win = window.open("about:blank", "_blank");
  try {
    const r = await fetch("/api/login/start", { method: "POST" }).then((x) => x.json());
    if (r.loggedIn) { if (win) win.close(); return void startApp(); } // already logged in
    if (!r.ok || !r.url) throw new Error(r.error || "could not start login");
    if (win) { try { win.location.href = r.url; } catch { /* popup blocked — link fallback below */ } }
    gate.url.textContent = r.url;
    gate.url.href = r.url;
    gate.link.hidden = false;
    // Poll until yeet whoami resolves, then boot the dashboard.
    if (!authPoll) authPoll = setInterval(pollAuth, 2000);
  } catch (e) {
    if (win) win.close();
    gate.err.textContent = String(e.message || e);
    gate.err.hidden = false;
    gate.btn.disabled = false;
  }
}

async function pollAuth() {
  try {
    const a = await fetch("/api/auth", { cache: "no-store" }).then((x) => x.json());
    if (a.loggedIn) { hideGate(); startApp(); }
    else if (a.error) { gate.err.textContent = a.error; gate.err.hidden = false; }
  } catch { /* keep polling */ }
}

gate.btn.addEventListener("click", beginLogin);

// ── app start (only once authenticated) ─────────────────────────────────────
let appStarted = false;
function startApp() {
  if (appStarted) return;
  appStarted = true;
  hideGate();
  // Re-hydrate: if the page was served pre-login, boot.snapshot was withheld,
  // so pull a fresh page state by reloading (simplest, gets the inlined data).
  if (!snapshot) { location.reload(); return; }
  renderIface();
  renderTotals();
  renderTable();
  connect();
}

// ── boot ────────────────────────────────────────────────────────────────
el.iface.addEventListener("click", (e) => { e.stopPropagation(); openIfacePop(); });
if (boot.auth && boot.auth.loggedIn === false) {
  // Locked — show the gate; if a login was already mid-flight, resume polling.
  showGate();
  if (boot.auth.loginPending && boot.auth.loginUrl) {
    gate.url.textContent = boot.auth.loginUrl;
    gate.url.href = boot.auth.loginUrl;
    gate.link.hidden = false;
    gate.btn.disabled = true;
    authPoll = setInterval(pollAuth, 2000);
  }
} else {
  startApp();
}
