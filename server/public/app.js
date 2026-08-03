// httpwatch browser client.
//
// Hydrates from window.__BOOT__ (the snapshot the server inlined), then keeps
// itself live over SSE (/events). Rendering is plain DOM — a sortable endpoint
// table plus a detail panel (percentiles, status chips, SVG sparklines) that
// mirrors the TUI's detail screen. No framework, no build step.
//
// The detail panel's request stream is clickable: each row expands into the
// response the kernel captured — status line, headers, body — un-chunked,
// un-gzipped and pretty-printed here in the browser so a 500 is readable.

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

/** The marker in the endpoint table for a route that has alert rules on it.
 *  An SVG rather than 🔔 so it takes the accent color and stays the same shape
 *  on every platform — emoji fonts render that one at wildly different weights. */
const bellHtml = (n) =>
  `<span class="al-dot" title="${n} alert rule${n === 1 ? "" : "s"} set">` +
  `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M8 2a4 4 0 0 0-4 4c0 2.6-.7 4-1.3 4.7a.6.6 0 0 0 .45 1h9.7a.6.6 0 0 0 .45-1C12.7 10 12 8.6 12 6a4 4 0 0 0-4-4Z"/>` +
  `<path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0"/>` +
  `</svg></span>`;

/** req/s, always to one decimal so the column doesn't jump a character wider as
 *  the rate crosses 10. Note the agent samples this as a whole-request delta
 *  once a second, so today the fraction is only ever `.0`. */
const fmtRate = (n) => (Number(n) || 0).toFixed(1);

const statusClass = (code) => code >= 500 ? "s5" : code >= 400 ? "s4" : code >= 300 ? "s3" : code >= 200 ? "s2" : "";
const methodClass = (m) => ["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS","CONNECT","TRACE"].includes(m) ? "m-" + m : "m-other";

// ── analytics ────────────────────────────────────────────────────────────
// analytics.js defines these (no-ops when the server didn't hand the page a
// PostHog key); guarded anyway so app.js works if it failed to load.
//
// The rule for what goes in an event: the interaction, never the traffic. An
// endpoint key is a host and a path out of someone's network — the method alone
// says as much about how the dashboard is used, without shipping their routes.
const track = (event, props) => { try { window.hwTrack?.(event, props); } catch { /* never break the UI */ } };
/** METHOD out of a "METHOD host path" endpoint key. */
const methodOf = (key) => String(key || "").split(" ")[0] || "unknown";

// ── state ────────────────────────────────────────────────────────────────
const boot = window.__BOOT__ || {};
let snapshot = boot.snapshot || null;
let selectedKey = null;
let sortKey = "count";
let sortDir = -1; // -1 desc, 1 asc

// Rolling log of individual completed requests (newest last), accumulated from
// each snapshot's `recent` delta. Each event gets a monotonic __seq so the
// detail stream can append only genuinely-new rows (preserving scroll).
//
// A row is now just timing and status — the heads and bodies live in the
// server's store and are fetched by `id` when a row is opened. That's what lets
// a body be as big as the capture allows instead of as big as a snapshot had
// room for, and it's why nothing here ages out its own preview any more: the
// server does that, and says so when you ask for something it dropped.
let recent = [];
let seqCounter = 0;
const RECENT_MAX = 5000;
const REQ_STREAM_ROWS = 150; // most recent requests kept in the stream per route
function ingestRecent(arr) {
  for (const e of arr) { e.__seq = ++seqCounter; recent.push(e); }
  if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX);
}
const eventBySeq = (seq) => recent.find((e) => e.__seq === seq) || null;

// Rows the exporter couldn't fit in its frames. Reported rather than silently
// missing, so a gap in the stream is explained.
let droppedRows = 0;

// Slack alert rules, as the server reports them. Evaluated server-side against
// each snapshot's status tallies, so setting one takes effect on the next tick
// with nothing restarting.
let alertRules = boot.alerts || [];
const slackChannel = boot.config?.slackChannel || "#alerts";
// Rules that apply to an endpoint: its own, plus any catchall ("*") rule, which
// covers it too — shown on every panel so you don't add a duplicate.
const alertsFor = (key) => alertRules.filter((a) => a.key === key || a.global);
/** Rules written against this exact endpoint. The bell in the table uses this
 *  rather than alertsFor(): a catchall matches every row, so counting it would
 *  put a bell on the whole table and stop the marker meaning anything. */
const ownAlertsFor = (key) => alertRules.filter((a) => a.key === key && !a.global);

// Which alert destinations the host can reach, from `yeet.caps()` via the
// exporter. `slack: true` connected · `false` definitely not · `null` unknown
// (not logged in, or the call failed) — three states, three different messages.
let caps = boot.caps || { slack: null };
const SETTINGS_URL = "https://yeet.cx/settings";
if (Array.isArray(boot.snapshot?.recent)) ingestRecent(boot.snapshot.recent);

// Detail request-stream cursor: which route it's showing and the highest __seq
// already rendered, so each snapshot only prepends the new pairs.
const streamState = { key: null, lastSeq: 0 };

// Interface state, driven by the exporter's snapshot.ifaces.
let availIfaces = boot.snapshot?.ifaces?.available || [];
let watching = boot.snapshot?.ifaces?.watching || boot.config?.iface || null;

// Which message bodies the probe is capturing: none | response | both. Reported
// by the exporter each snapshot, so this always reflects the running probe
// rather than the last thing clicked.
let bodyMode = boot.snapshot?.bodies || boot.config?.bodies || "response";
const BODY_LABEL = { none: "off", response: "responses", both: "req + resp" };

const el = {
  rows: document.getElementById("rows"),
  table: document.getElementById("table"),
  empty: document.getElementById("empty"),
  totals: document.getElementById("totals"),
  iface: document.getElementById("iface"),
  bodies: document.getElementById("bodies"),
  alertsPill: document.getElementById("alerts-pill"),
  alertsModal: document.getElementById("alerts-modal"),
  alertsModalBody: document.getElementById("alerts-modal-body"),
  alertsModalClose: document.getElementById("alerts-modal-close"),
  conn: document.getElementById("conn"),
  detail: document.getElementById("detail"),
  detailBody: document.getElementById("detail-body"),
  detailClose: document.getElementById("detail-close"),
  detailExpand: document.getElementById("detail-expand"),
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
      ? `<span class="live">${fmtRate(r.rate)}</span>`
      : `<span class="idle">·</span>`;

    tr.innerHTML =
      `<td class="col-rank">${i + 1}</td>` +
      `<td class="col-method"><span class="method ${methodClass(r.method)}">${esc(r.method)}</span></td>` +
      `<td class="col-host host" title="${esc(r.host)}">${esc(r.host)}</td>` +
      `<td class="col-path path" title="${esc(r.path)}">${esc(r.path)}` +
        (ownAlertsFor(r.key).length ? bellHtml(ownAlertsFor(r.key).length) : "") +
      `</td>` +
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

// One popover at a time, shared by the iface and bodies pills.
let pop = null;
let popAnchor = null;
function closePop() {
  if (!pop) return;
  pop.remove();
  pop = null;
  popAnchor = null;
  document.removeEventListener("click", onDocClickForPop, true);
  document.removeEventListener("scroll", onScrollForPop, true);
  window.removeEventListener("resize", repositionPop);
}

function onDocClickForPop(e) {
  if (pop && !pop.contains(e.target) && e.target !== popAnchor) closePop();
}

/**
 * Where to put a popover of `size` anchored to `rect`, inside `view`.
 *
 * Below the anchor is preferred, but a popover opened from low on the page (the
 * "Set alert" button sits at the bottom of the detail panel) would run off the
 * viewport — and since these are `position: fixed`, you can't scroll to reach the
 * cut-off part. So: flip above when it fits there, fall back to the full viewport
 * height when neither side has room, and clamp to the viewport throughout. Pure
 * maths, kept separate from the DOM so it's testable.
 *
 * @returns {{top: number, right: number, maxHeight: number}} all in px
 */
function placePop(rect, size, view, gap = 6, margin = 8) {
  const roomBelow = view.height - rect.bottom - gap - margin;
  const roomAbove = rect.top - gap - margin;

  let top;
  let maxHeight;
  if (size.height <= roomBelow) {
    // Below: the default, whenever it fits.
    top = rect.bottom + gap;
    maxHeight = Math.max(120, roomBelow);
  } else if (size.height <= roomAbove) {
    // Above: doesn't fit below, but fits here.
    maxHeight = Math.max(120, roomAbove);
    top = Math.max(margin, rect.top - gap - size.height);
  } else {
    // Neither side fits — the alert form opened from a button near the bottom of
    // the detail panel is the usual case. Staying on the anchor's side would cap
    // the popover at that side's room and scroll the rest away, hiding the very
    // button you opened it to press. Ignore the anchor's side and give it the
    // whole viewport instead: it still scrolls if it has to, but only when the
    // window itself is genuinely too short.
    maxHeight = Math.max(120, view.height - 2 * margin);
    // Keep it as close to the anchor as the taller layout allows.
    top = Math.max(margin, Math.min(rect.bottom + gap, view.height - margin - Math.min(size.height, maxHeight)));
  }
  // Never start off the bottom edge.
  top = Math.min(top, Math.max(margin, view.height - margin - Math.min(size.height, maxHeight)));

  // Right-aligned to the anchor, but not pushed off the left edge on a narrow
  // window or by a wide popover.
  let right = Math.max(margin, view.width - rect.right);
  if (right + size.width > view.width - margin) right = Math.max(margin, view.width - margin - size.width);

  return { top: Math.round(top), right: Math.round(right), maxHeight: Math.round(maxHeight) };
}

/** Mount `html` in a popover anchored to `anchor`. Returns the element (or
 *  null when this was a second click on the same pill, i.e. a toggle-closed). */
function openPop(anchor, cls, html) {
  const reopening = popAnchor === anchor;
  closePop();
  if (reopening) return null;

  pop = document.createElement("div");
  pop.className = `popover ${cls}`;
  pop.innerHTML = html;
  popAnchor = anchor;

  // Append first so it can be measured, then place it — its height depends on
  // the content, which is exactly what decides above-vs-below.
  pop.style.visibility = "hidden";
  document.body.appendChild(pop);
  const at = placePop(
    anchor.getBoundingClientRect(),
    { width: pop.offsetWidth, height: pop.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  pop.style.top = `${at.top}px`;
  pop.style.right = `${at.right}px`;
  pop.style.maxHeight = `${at.maxHeight}px`;
  pop.style.visibility = "";

  setTimeout(() => document.addEventListener("click", onDocClickForPop, true), 0);
  // A fixed popover doesn't move with its anchor, so follow the anchor when
  // anything scrolls (capture, to catch the detail panel's own scroller) or the
  // window resizes. Repositioning rather than closing keeps a half-filled form.
  document.addEventListener("scroll", onScrollForPop, true);
  window.addEventListener("resize", repositionPop);
  return pop;
}

/** Re-place an open popover against its anchor's current position. */
function repositionPop() {
  if (!pop || !popAnchor) return;
  const rect = popAnchor.getBoundingClientRect();
  // Anchor scrolled out of sight — there's nothing to point at any more.
  if (rect.bottom < 0 || rect.top > window.innerHeight) return void closePop();
  const at = placePop(rect, { width: pop.offsetWidth, height: pop.scrollHeight },
    { width: window.innerWidth, height: window.innerHeight });
  pop.style.top = `${at.top}px`;
  pop.style.right = `${at.right}px`;
  pop.style.maxHeight = `${at.maxHeight}px`;
}

function onScrollForPop(e) {
  // Ignore the popover scrolling its own content.
  if (pop && e.target instanceof Node && (e.target === pop || pop.contains(e.target))) return;
  repositionPop();
}

function openIfacePop() {
  const chosen = selectedIfaceSet();
  const ifacePop = openPop(el.iface, "iface-pop",
    `<div class="pop-title">Watch interfaces</div>` +
    `<label class="pop-item"><input type="checkbox" value="__all__" ${chosen.size === 0 ? "checked" : ""}/> <span>All interfaces</span></label>` +
    `<div class="pop-sep"></div>` +
    (availIfaces.length
      ? availIfaces.map((n) => `<label class="pop-item"><input type="checkbox" value="${esc(n)}" ${chosen.has(n) ? "checked" : ""}/> <span>${esc(n)}</span></label>`).join("")
      : `<div class="pop-empty">no interfaces reported</div>`) +
    `<div class="pop-actions"><button class="pop-apply">Apply</button></div>`);
  if (!ifacePop) return;

  const allCb = ifacePop.querySelector('input[value="__all__"]');
  const ifaceCbs = [...ifacePop.querySelectorAll('input:not([value="__all__"])')];
  // "All" and specific interfaces are mutually exclusive.
  allCb.addEventListener("change", () => { if (allCb.checked) ifaceCbs.forEach((c) => (c.checked = false)); });
  ifaceCbs.forEach((c) => c.addEventListener("change", () => { if (c.checked) allCb.checked = false; if (!ifaceCbs.some((x) => x.checked)) allCb.checked = true; }));

  ifacePop.querySelector(".pop-apply").addEventListener("click", () => {
    const picked = ifaceCbs.filter((c) => c.checked).map((c) => c.value);
    const iface = allCb.checked ? "" : picked.join(",");
    closePop();
    postIface(iface);
  });
}

// ── body-capture picker ─────────────────────────────────────────────────────
// What the probe captures is a spawn-time setting (no control channel into a
// running isolate), so switching restarts it and the counts reset — the same
// deal as changing interfaces, and the popover says so.
function renderBodies() {
  el.bodies.textContent = `bodies: ${BODY_LABEL[bodyMode] || bodyMode} ▾`;
  el.bodies.classList.add("clickable");
  el.bodies.classList.toggle("warn", bodyMode === "both");
}

const BODY_CHOICES = [
  { v: "none", label: "No bodies", hint: "status codes and latency only" },
  { v: "response", label: "Response bodies", hint: "read what the server returned" },
  { v: "both", label: "Request + response bodies", hint: "includes what was sent" },
];

function openBodiesPop() {
  const bodiesPop = openPop(el.bodies, "bodies-pop",
    `<div class="pop-title">Capture bodies</div>` +
    BODY_CHOICES.map((c) =>
      `<label class="pop-item"><input type="radio" name="bodies" value="${c.v}" ${c.v === bodyMode ? "checked" : ""}/> ` +
      `<span>${esc(c.label)}<span class="pop-hint">${esc(c.hint)}</span></span></label>`).join("") +
    `<div class="pop-sep"></div>` +
    `<div class="pop-warn">Request bodies can carry passwords, tokens and personal data — anyone who can reach this dashboard will be able to read them.</div>` +
    `<div class="pop-note">Changing this restarts the probe, so counts reset.</div>` +
    `<div class="pop-actions"><button class="pop-apply">Apply</button></div>`);
  if (!bodiesPop) return;

  bodiesPop.querySelector(".pop-apply").addEventListener("click", () => {
    const picked = bodiesPop.querySelector('input[name="bodies"]:checked')?.value;
    closePop();
    if (picked && picked !== bodyMode) postBodies(picked);
  });
}

async function postBodies(mode) {
  setConn("conn-wait", "restarting probe…");
  recent = []; // captured under the old setting — drop it
  try {
    const res = await fetch("/api/bodies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bodies: mode }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) setConn("conn-off", j.error || "body capture change failed");
    else { bodyMode = j.bodies || mode; track("bodies_changed", { body_mode: bodyMode }); }
    renderBodies();
  } catch {
    setConn("conn-off", "body capture change failed");
  }
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
    else {
      watching = j.iface || "all";
      // How many they picked, not which — an interface name can be as
      // identifying as a hostname on a real fleet.
      track("iface_changed", { ifaces: watching === "all" ? "all" : watching.split(",").filter(Boolean).length });
    }
    renderIface();
  } catch {
    setConn("conn-off", "interface change failed");
  }
}

// ── detail panel ───────────────────────────────────────────────────────────
// The open endpoint lives in the URL (`?endpoint=GET host /path`), so a panel can
// be linked to — that's what the links in Slack alerts point at — and so copying
// the address bar shares what you're looking at.
const ENDPOINT_PARAM = "endpoint";
// The same panel, full-bleed, lives at its own path — `/detail?endpoint=…`. It's
// a path rather than another param so it reads as a page you can send someone,
// and the server maps it back to this one page.
const FOCUS_PATH = "/detail";

/** True when the panel was opened from a link and that endpoint hasn't appeared
 *  in a snapshot yet: worth saying "waiting" rather than "no longer tracked". */
let awaitingLinkedEndpoint = false;

/** Full-screen mode. Only ever true with an endpoint selected — /detail with no
 *  `?endpoint=` has nothing to show, so it degrades to the list. */
let focused = false;

function syncUrl(push) {
  try {
    const url = new URL(window.location.href);
    url.pathname = focused && selectedKey ? FOCUS_PATH : "/";
    if (selectedKey) url.searchParams.set(ENDPOINT_PARAM, selectedKey);
    else url.searchParams.delete(ENDPOINT_PARAM);
    history[push ? "pushState" : "replaceState"](null, "", url);
  } catch { /* history is a nicety; never break the panel over it */ }
}

/** Reflect `focused` in the DOM: the class the stylesheet keys off, plus the
 *  button's meaning (it becomes "exit" once expanded). */
function applyFocus() {
  const on = focused && !!selectedKey;
  document.body.classList.toggle("detail-focus", on);
  el.detailExpand.title = on ? "Exit full screen (Esc)" : "Full screen (f)";
  el.detailExpand.setAttribute("aria-label", el.detailExpand.title);
  el.detailExpand.classList.toggle("is-on", on);
}

/** Expand/collapse is a navigation, so it pushes history — back returns to the
 *  list with the panel still open, like any other link. */
function setFocused(on) {
  if (!selectedKey) on = false;
  if (on === focused) return;
  focused = on;
  applyFocus();
  syncUrl(true);
}

function selectEndpoint(key, opts = {}) {
  selectedKey = key;
  streamState.key = key;
  streamState.lastSeq = 0; // renderDetail fills the stream and sets the cursor
  awaitingLinkedEndpoint = !(snapshot?.endpoints || []).some((e) => e.key === key);
  if (opts.focused !== undefined) focused = !!opts.focused;
  el.detail.classList.add("open");
  applyFocus();
  syncUrl();
  renderTable();
  renderDetail();
  track("endpoint_opened", { method: methodOf(key), focused, has_alerts: ownAlertsFor(key).length > 0 });
}

function closeDetail() {
  selectedKey = null;
  streamState.key = null;
  openSeq = null;
  awaitingLinkedEndpoint = false;
  focused = false;
  applyFocus();
  el.detail.classList.remove("open");
  syncUrl();
  renderTable();
}
el.detailClose.addEventListener("click", closeDetail);
el.detailExpand.addEventListener("click", () => setFocused(!focused));
// Escape backs out one level: the rules dialog, then an open response viewer,
// then full screen, then the detail panel.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (alertsModalOpen()) return void closeAlertsModal();
  if (openSeq !== null) {
    const item = document.querySelector(`.req-item[data-seq="${openSeq}"]`);
    if (item) return void toggleViewer(item);
    openSeq = null;
  }
  if (focused) return void setFocused(false);
  closeDetail();
});
// `f` toggles full screen — but not while a rule is being typed into.
document.addEventListener("keydown", (e) => {
  if (e.key !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!selectedKey || alertsModalOpen()) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
  e.preventDefault();
  setFocused(!focused);
});

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
      `<dt>Req/s now</dt><dd>${fmtRate(r.rate)} <span class="dim">· peak ${fmtRate(r.peak)}/s</span></dd>` +
      `<dt>Latency</dt><dd>${latLine}</dd>` +
      `<dt>Bytes</dt><dd>${fmtBytes(r.bytes)} <span class="dim">on the wire</span></dd>` +
      `<dt>First seen</dt><dd>${fmtAgo(now - r.first)} ago</dd>` +
      `<dt>Last seen</dt><dd>${fmtAgo(now - r.last)} ago</dd>` +
    `</dl>` +
    `<div><dt style="font-family:var(--mono);color:var(--fg-faint);font-size:12px">Status codes</dt>${chipHtml}</div>` +
    `<div class="spark-block"><h3>Req/s, last minute</h3>${sparkSvg(r.hist, "var(--accent)", r.peak)}</div>`;
}

/* One request row, wrapped in the item that also holds its expanded response
 * viewer. `newRow` adds a brief highlight for freshly-arrived rows. Each item is
 * one child of the stream, so the row cap counts requests, not viewers. */
function reqItemHtml(e, newRow) {
  const cls = statusClass(e.code) || "s0";
  const d = new Date(e.ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(e.ts % 1000).padStart(3, "0");
  return `<div class="req-item" data-seq="${e.__seq}">` +
    `<button type="button" class="req-row ${cls}${newRow ? " fresh" : ""}" aria-expanded="false">` +
      // An SVG chevron, not "▸": the glyph's side bearings are uneven, so it sat
      // off-center in its column and drifted again when rotated open. This one is
      // symmetric about the middle of its box, which is also the rotation origin.
      `<span class="req-caret">` +
        `<svg viewBox="0 0 8 8" width="8" height="8" fill="none" stroke="currentColor" ` +
        `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `<path d="M2.6 1.2 5.4 4 2.6 6.8"/></svg>` +
      `</span>` +
      `<span class="req-code">${e.code || "—"}</span>` +
      `<span class="req-lat">${fmtMs(e.ms)}</span>` +
      `<span class="req-time">${hh}:${mm}:${ss}.${ms}</span>` +
    `</button>` +
  `</div>`;
}

// ── response viewer ────────────────────────────────────────────────────────
// Clicking a row expands the response the agent captured: its status line,
// headers, and as much body as crossed the ring buffer. The body is fetched from
// the server's store, in whichever encoding the agent found cheaper for it —
// `raw` for text (a byte-exact latin1 string), `b64` for anything compressed —
// then recovered to bytes and un-chunked, un-gzipped and decoded as needed.
// That's what makes a real 500 readable instead of a wall of compressed noise.
let openSeq = null;

const toBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function b64ToBytes(s) {
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** One stored direction, with its body recovered to the bytes that were on the
 *  wire — whichever way it travelled. */
const decodePart = (m) => ({ ...m, bytes: m.enc === "b64" ? b64ToBytes(m.d) : toBytes(m.d || "") });

// Fetched bodies, keyed by exchange id. Bounded because the values are whole
// message bodies and a long session opens a lot of them; `null` is cached too,
// so a miss isn't re-fetched every time the row is clicked.
const bodyCache = new Map();
const BODY_CACHE_MAX = 200;

async function fetchBody(id) {
  if (bodyCache.has(id)) return bodyCache.get(id);
  const res = await fetch(`/api/body/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`server said ${res.status}`);
  const j = await res.json();
  const val = j.found ? j : null;
  bodyCache.set(id, val);
  if (bodyCache.size > BODY_CACHE_MAX) bodyCache.delete(bodyCache.keys().next().value);
  return val;
}

// ── selection guards ───────────────────────────────────────────────────────
// A response is there to be read, so a click that finishes highlighting text
// must not be taken as a click on the control underneath it.
const selectionCollapsed = () => {
  const s = window.getSelection();
  return !s || s.isCollapsed || !String(s).length;
};
function selectionWithin(node) {
  const s = window.getSelection();
  if (!s || !s.rangeCount) return false;
  const r = s.getRangeAt(0);
  return node.contains(r.commonAncestorContainer) || node.contains(r.startContainer);
}

// ── copying a message ──────────────────────────────────────────────────────
// What each copy button puts on the clipboard, keyed by the id stamped into it.
// Only one viewer is open at a time, so the map is rebuilt per render and never
// grows — the values are whole message bodies.
const copyBuf = new Map();
let copyId = 0;

/**
 * Put `text` on the clipboard. The async Clipboard API only exists in a secure
 * context, and this dashboard is normally reached over plain http:// at a host
 * IP — so the execCommand path isn't legacy cruft here, it's the one that runs.
 */
async function copyText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through — a denied permission is still worth retrying below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off-screen but focusable, and fixed so selecting it can't scroll the page.
    ta.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari needs the explicit range
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy, then say so on the button itself — no toast to chase or dismiss. */
async function onCopyClick(btn) {
  const entry = copyBuf.get(Number(btn.dataset.copy));
  const text = entry?.[btn.dataset.what];
  if (!text) return;
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  const ok = await copyText(text);
  btn.textContent = ok ? `copied · ${fmtCount(text.length)} chars` : "couldn't copy — select it instead";
  btn.classList.toggle("rv-copy-ok", ok);
  btn.classList.toggle("rv-copy-bad", !ok);
  clearTimeout(btn.__revert);
  btn.__revert = setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove("rv-copy-ok", "rv-copy-bad");
  }, ok ? 1400 : 3000);
}

// ── message parsing ────────────────────────────────────────────────────────
// The agent ships the head byte-exact, which is the record of what was on the
// wire — duplicate Set-Cookies, unusual casing and obs-folded values included.
// Structure is derived here, at display time, so nothing is lost on the way and
// the parse costs nothing per frame (it runs when a row is expanded).

const REQ_LINE = /^([A-Z]+) +(\S+) +(HTTP\/\d\.\d)$/;
const STATUS_LINE = /^(HTTP\/\d\.\d) +(\d{3})(?: +(.*))?$/;

/**
 * Split a head block into its start line and an ordered list of headers.
 * Order and duplicates are preserved — `Set-Cookie` legitimately repeats, and
 * the sequence is itself evidence — so this is a list, never an object.
 * Returns { startLine, request, status, headers: [{name, value, folded}] }.
 */
function parseMessage(head) {
  const lines = String(head ?? "").split("\r\n");
  const startLine = lines[0] || "";
  const rq = REQ_LINE.exec(startLine);
  const st = STATUS_LINE.exec(startLine);

  const headers = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // obs-fold: a leading space/tab continues the previous header's value.
    if (/^[ \t]/.test(line)) {
      if (headers.length) {
        const prev = headers[headers.length - 1];
        prev.value += " " + line.trim();
        prev.folded = true;
      }
      continue;
    }
    const c = line.indexOf(":");
    if (c > 0) headers.push({ name: line.slice(0, c).trim(), value: line.slice(c + 1).trim() });
    // A line with no colon isn't a header. Keep it visible rather than dropping
    // it — it usually means the capture cut mid-line.
    else headers.push({ name: null, value: line });
  }

  return {
    startLine,
    request: rq ? { method: rq[1], target: rq[2], version: rq[3] } : null,
    status: st ? { version: st[1], code: Number(st[2]), reason: st[3] || "" } : null,
    headers,
  };
}

/** First value for a header name (case-insensitive), or null. */
function headerOf(head, name) {
  const want = name.toLowerCase();
  for (const h of parseMessage(head).headers) {
    if (h.name && h.name.toLowerCase() === want) return h.value;
  }
  return null;
}

/** Strip HTTP chunked framing. Lenient: stops at the first malformed or
 *  truncated chunk and returns what it got, which is the normal case here. */
function dechunk(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let nl = -1;
    for (let j = i; j < bytes.length - 1; j++) if (bytes[j] === 13 && bytes[j + 1] === 10) { nl = j; break; }
    if (nl < 0) break;
    let line = "";
    for (let j = i; j < nl; j++) line += String.fromCharCode(bytes[j]);
    const size = parseInt(line.split(";")[0], 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) return { bytes: concat(out), complete: true };
    const start = nl + 2;
    const end = Math.min(bytes.length, start + size);
    out.push(bytes.subarray(start, end));
    if (end - start < size) return { bytes: concat(out), complete: false }; // truncated mid-chunk
    i = end + 2; // skip the chunk's trailing CRLF
  }
  return { bytes: concat(out), complete: false };
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Inflate with the platform's DecompressionStream; null if it can't (a
 *  truncated stream is expected whenever the capture cut the body short). */
async function inflate(bytes, format) {
  if (typeof DecompressionStream !== "function") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Bytes that aren't plausibly text — control characters outside CR/LF/TAB. */
function looksBinary(bytes) {
  const n = Math.min(bytes.length, 512);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b === 127) odd++;
  }
  return n > 0 && odd / n > 0.05;
}

function hexdump(bytes, max = 512) {
  const n = Math.min(bytes.length, max);
  let out = "";
  for (let i = 0; i < n; i += 16) {
    let hex = "", ascii = "";
    for (let j = i; j < Math.min(n, i + 16); j++) {
      hex += bytes[j].toString(16).padStart(2, "0") + (j % 2 ? " " : "");
      const b = bytes[j];
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
    }
    out += i.toString(16).padStart(6, "0") + "  " + hex.padEnd(41) + " " + ascii + "\n";
  }
  return out;
}

// Strings (with an optional trailing colon, which makes them keys), then the
// bare literals and numbers. Everything the scan doesn't claim — braces,
// brackets, commas, whitespace — falls through as plain escaped text.
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Escape + wrap JSON tokens in spans. Lenient by construction: a body cut off
 *  mid-string simply leaves that tail unhighlighted rather than breaking. */
function highlightJson(text) {
  let out = "", last = 0, m;
  JSON_TOKEN.lastIndex = 0;
  while ((m = JSON_TOKEN.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += m[2] !== undefined
        ? `<span class="j-key">${esc(m[1])}</span>${esc(m[2])}` // "name":
        : `<span class="j-str">${esc(m[1])}</span>`;
    } else if (m[3] !== undefined) {
      out += `<span class="j-lit">${esc(m[3])}</span>`;
    } else {
      out += `<span class="j-num">${esc(m[4])}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** Decode a captured body into displayable text plus the notes explaining what
 *  had to be done to it (or why it isn't fully there). */
async function decodeBody(e) {
  const notes = [];
  let bytes = e.bytes;
  if (!bytes.length) return { text: "", notes };

  if (/chunked/i.test(headerOf(e.head, "transfer-encoding") || "")) {
    const r = dechunk(bytes);
    bytes = r.bytes;
    // A chunked message is only whole once its terminating zero-length chunk has
    // arrived, and that is the *only* completeness signal it has — chunked
    // responses send no Content-Length, so the exporter's seal() can't tell a
    // still-streaming response from a finished one and marks it complete. Which
    // means a body cut here looks like corruption unless the note says otherwise.
    // A long-lived response (an SSE stream, a slow download) ends mid-value like
    // this every time the capture window closes before the response does.
    notes.push(
      r.complete ? "un-chunked"
      : e.more || e.gap ? "un-chunked (partial)"   // the notes below say why
      : "un-chunked — no terminating chunk, so the response was still in flight " +
        "when the capture ended; this is what had arrived by then");
    if (!bytes.length) return { text: "", notes };
  }

  const enc = (headerOf(e.head, "content-encoding") || "").toLowerCase();
  if (enc === "gzip" || enc === "deflate") {
    const raw = await inflate(bytes, enc === "gzip" ? "gzip" : "deflate");
    if (raw) { bytes = raw; notes.push(`decompressed (${enc})`); }
    else return { text: hexdump(bytes), notes: [...notes, `${enc}-encoded — could not decompress${e.more ? " (body truncated by the capture)" : ""}`], mono: true };
  } else if (enc && enc !== "identity") {
    notes.push(`content-encoding: ${enc} — shown as captured`);
  }

  if (looksBinary(bytes)) return { text: hexdump(bytes), notes: [...notes, "binary body — first bytes as hex"], mono: true };

  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const ctype = (headerOf(e.head, "content-type") || "").toLowerCase();
  if (/json/.test(ctype)) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); notes.push("pretty-printed"); }
    catch { /* truncated or not actually JSON — show it raw */ }
    // Highlight either way: the tokenizer is happy with a truncated body, and
    // that's exactly when the colors help most.
    return { text, notes, lang: "json" };
  }
  return { text, notes };
}

/* Headers the viewer itself acted on — marked in the table so the notes under it
 * ("decompressed (gzip)", "un-chunked") point at the header that caused them. */
const ACTED_ON = new Set(["content-encoding", "transfer-encoding", "content-type", "content-length"]);

/** The parsed start line, as its own labelled fields. */
function startLineHtml(m) {
  if (m.request) {
    return `<div class="rv-start">` +
      `<span class="rv-method ${methodClass(m.request.method)}">${esc(m.request.method)}</span>` +
      `<span class="rv-target">${esc(m.request.target)}</span>` +
      `<span class="rv-ver">${esc(m.request.version)}</span>` +
    `</div>`;
  }
  if (m.status) {
    return `<div class="rv-start">` +
      `<span class="rv-code ${statusClass(m.status.code)}">${m.status.code}</span>` +
      `<span class="rv-reason">${esc(m.status.reason)}</span>` +
      `<span class="rv-ver">${esc(m.status.version)}</span>` +
    `</div>`;
  }
  // Unparseable start line (usually a capture cut short) — show it verbatim.
  return `<div class="rv-start"><span class="rv-target">${esc(m.startLine)}</span></div>`;
}

/** Headers as a name/value grid. Order and duplicates are as they were sent. */
function headersHtml(headers) {
  if (!headers.length) return `<div class="rv-note">no headers captured</div>`;
  const rows = headers.map((h) => {
    if (!h.name) return `<div class="rv-h-raw">${esc(h.value)}</div>`;
    const acted = ACTED_ON.has(h.name.toLowerCase()) ? " acted" : "";
    return `<div class="rv-h-name${acted}">${esc(h.name)}</div>` +
      `<div class="rv-h-val">${esc(h.value)}${h.folded ? `<span class="rv-h-note"> (folded)</span>` : ""}</div>`;
  }).join("");
  const dupes = new Set();
  const seen = new Set();
  for (const h of headers) {
    if (!h.name) continue;
    const k = h.name.toLowerCase();
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return `<div class="rv-h-table">${rows}</div>` +
    `<div class="rv-h-count">${headers.length} header${headers.length === 1 ? "" : "s"}` +
      `${dupes.size ? ` · repeated: ${esc([...dupes].join(", "))}` : ""}</div>`;
}

/** One direction of an exchange: its start line, headers, and decoded body.
 *  `msg` is the {head, bytes, more, clen, gap} shape the body store returns. */
async function messageBlock(msg, label) {
  const parsed = parseMessage(msg.head);
  const clen = msg.clen ?? headerOf(msg.head, "content-length");

  const { text, notes, mono, lang } = await decodeBody(msg);
  const bodyLen = msg.bytes.length;
  if (msg.gap) notes.push("a part of this body went missing in transit — shown up to the gap");
  else if (msg.more) notes.push(`truncated by the capture${clen ? ` — ${fmtBytes(bodyLen)} of ${fmtBytes(Number(clen))}` : ""}`);

  // Both halves of what's on screen are worth pasting elsewhere: the whole
  // message for a bug report (head byte-exact, as captured), or just the body
  // for the payload that explains a 500. The body is the decoded, pretty-printed
  // text — what you're reading, not the gzip that arrived.
  const id = ++copyId;
  copyBuf.set(id, { message: String(msg.head ?? "") + text, body: text });
  const tools =
    `<div class="rv-tools">` +
      (label ? `<span class="rv-label">${esc(label)}</span>` : `<span class="rv-label"></span>`) +
      `<span class="rv-btns">` +
        (text ? `<button type="button" class="rv-copy" data-copy="${id}" data-what="body">copy body</button>` : "") +
        `<button type="button" class="rv-copy" data-copy="${id}" data-what="message">` +
          `copy ${label ? esc(label.toLowerCase()) : "message"}</button>` +
      `</span>` +
    `</div>`;

  return tools +
    startLineHtml(parsed) +
    headersHtml(parsed.headers) +
    (notes.length ? `<div class="rv-note">${esc(notes.join(" · "))}</div>` : "") +
    (text
      ? `<pre class="rv-body${mono ? " rv-hex" : ""}${lang === "json" ? " rv-json" : ""}">` +
          `${lang === "json" ? highlightJson(text) : esc(text)}</pre>`
      : `<div class="rv-note">no body bytes in the captured segments${msg.more ? " — the body followed later on the wire" : ""}</div>`);
}

/** Render the expanded viewer for one event into its container. Shows whichever
 *  directions were captured, request first — reading a 400 usually means reading
 *  the payload that caused it. */
async function renderViewer(box, e) {
  copyBuf.clear(); // only one viewer is open at a time; drop the last one's text

  // Nothing was captured for either direction — no point asking the server.
  if (e.rs === undefined && e.qs === undefined && !e.nopv) {
    box.innerHTML = `<div class="rv-note">body capture is off — turn it on with the ` +
      `<b>bodies</b> control at the top of the page (this restarts the probe)</div>`;
    return;
  }

  const data = await fetchBody(e.id);
  if (openSeq !== e.__seq) return; // collapsed while the fetch was in flight
  if (!data || (!data.req && !data.res)) {
    box.innerHTML = `<div class="rv-note">${
      e.nopv ? "not captured — the body budget for that second was spent on other requests"
      : "no longer held — the server evicted this body to make room for newer ones"}</div>`;
    return;
  }

  // Label the sections only when there are two of them to tell apart.
  const both = !!data.req && !!data.res;
  const parts = [];
  if (data.req) parts.push(await messageBlock(decodePart(data.req), both ? "Request" : null));
  if (data.res) parts.push(await messageBlock(decodePart(data.res), both ? "Response" : null));
  if (openSeq !== e.__seq) return; // collapsed while we were decoding
  box.innerHTML = parts.join(`<div class="rv-split"></div>`);
}

/** Expand/collapse the item for `seq` inside the stream container. */
function toggleViewer(item) {
  const seq = Number(item.dataset.seq);
  const row = item.querySelector(".req-row");
  const existing = item.querySelector(".req-view");

  // Collapse whatever was open (including this row, if it was the one).
  if (openSeq !== null) {
    const prev = document.querySelector(`.req-item[data-seq="${openSeq}"]`);
    if (prev) {
      prev.querySelector(".req-view")?.remove();
      prev.querySelector(".req-row")?.setAttribute("aria-expanded", "false");
      prev.classList.remove("open");
    }
    openSeq = null;
  }
  if (existing) {
    // It was open — collapsing is all we do, but that may have been the only
    // thing pausing the stream, so pick the tail back up if we're at the top.
    const stream = document.getElementById("req-stream");
    if (stream && stream.scrollTop <= 3 && streamHeld.length) resumeStream();
    return;
  }

  const e = eventBySeq(seq);
  if (!e) return;
  openSeq = seq;
  // Opening a captured exchange — the feature bodies exist for. Status class,
  // not the code, and nothing from the message itself.
  track("exchange_opened", { status_class: e.code ? `${Math.floor(e.code / 100)}xx` : "none", body_mode: bodyMode });
  item.classList.add("open");
  row.setAttribute("aria-expanded", "true");
  const box = document.createElement("div");
  box.className = "req-view";
  box.innerHTML = `<div class="rv-note">decoding…</div>`;
  item.appendChild(box);
  renderViewer(box, e).catch((err) => { box.innerHTML = `<div class="rv-note">could not decode: ${esc(err.message || err)}</div>`; });
}

/** What to show when the selected endpoint isn't in the current snapshot. */
function noEndpointHtml() {
  return awaitingLinkedEndpoint
    ? `<div class="spark-empty">waiting for traffic on <b>${esc(selectedKey)}</b> — this link opened an endpoint that hasn't been seen yet on the watched interfaces</div>`
    : `<div class="spark-empty">endpoint no longer tracked — pick another row</div>`;
}

/* Full detail render — called when a route is selected. Builds the aggregate
 * block + an empty stream container, then fills the stream and sets the cursor
 * so later snapshots only prepend new rows. */
function renderDetail() {
  const r = currentEndpoint();
  const agg = r ? aggHtml(r) : noEndpointHtml();
  openSeq = null; // the stream is being rebuilt; nothing is expanded in it
  streamHeld = [];
  streamHeldLost = 0;
  el.detailBody.innerHTML =
    `<div id="d-agg">${agg}</div>` +
    `<div id="d-alerts"></div>` +
    `<div class="spark-block req-block"><h3>Live requests · newest first ` +
      `<span class="dim">· click one to read it</span>` +
      `<span id="req-dropped" class="dim"></span></h3>` +
      `<div class="req-wrap">` +
        `<button type="button" id="req-held" class="req-held" hidden></button>` +
        `<div id="req-stream" class="req-stream"></div>` +
      `</div></div>`;
  renderDropped();
  renderAlertsBar(r);

  const stream = document.getElementById("req-stream");
  // Delegated so prepended rows need no per-row listener. Only the row button
  // toggles — the expanded viewer is a sibling of it, not a child, so clicking
  // (or drag-selecting) inside a response never collapses what you're reading.
  stream.addEventListener("click", (ev) => {
    if (ev.target.closest(".rv-copy")) return; // handled by the copy listener
    const row = ev.target.closest(".req-row");
    if (!row || !stream.contains(row)) return;
    // A click that ends a text selection on the row itself is a selection, not
    // a toggle — the status code and timestamp are worth copying too.
    if (!selectionCollapsed() && selectionWithin(row)) return;
    toggleViewer(row.closest(".req-item"));
  });
  // Copy buttons live inside the viewer, so they need their own delegate.
  stream.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".rv-copy");
    if (btn && stream.contains(btn)) onCopyClick(btn);
  });
  // Scrolling back to the top with nothing expanded resumes following.
  stream.addEventListener("scroll", () => {
    if (stream.scrollTop <= 3 && openSeq === null && streamHeld.length) resumeStream();
  });
  document.getElementById("req-held").addEventListener("click", resumeStream);

  const initial = [];
  for (let i = recent.length - 1; i >= 0 && initial.length < REQ_STREAM_ROWS; i--) {
    if (recent[i].key === selectedKey) initial.push(recent[i]);
  }
  streamState.lastSeq = seqCounter; // everything up to now is accounted for
  if (!initial.length) {
    stream.innerHTML = `<div class="spark-empty" style="padding:10px">no completed requests captured yet — waiting for responses…</div>`;
  } else {
    stream.innerHTML = initial.map((e) => reqItemHtml(e, false)).join(""); // already newest-first
  }
}

/* Note rows the exporter had to leave out of a frame (it only happens when the
 * endpoint table plus a second's worth of requests would exceed what the
 * transport carries). The endpoint totals are unaffected — only this tail is. */
function renderDropped() {
  const n = document.getElementById("req-dropped");
  if (n) n.textContent = droppedRows ? ` · ${fmtCount(droppedRows)} not shown (frame limit)` : "";
}

// ── alerts ──────────────────────────────────────────────────────────────────
// A rule watches one endpoint for a status condition and pings Slack. Rules live
// in the server (it sees every snapshot), so adding one is instant — nothing
// restarts and no counters reset.

const ALERT_CHOICES = [
  { v: "5xx", label: "Any 5xx", hint: "server errors on this endpoint" },
  { v: "4xx", label: "Any 4xx", hint: "client errors — 404s, 401s, …" },
  { v: "error", label: "Any 4xx or 5xx", hint: "anything that failed" },
  { v: "code", label: "A specific status code", hint: "e.g. only 503" },
];

/** The bar under the aggregates: existing rules for this route + a Set alert button. */
function renderAlertsBar(r) {
  const host = document.getElementById("d-alerts");
  if (!host) return;
  if (!r) { host.innerHTML = ""; return; }
  const mine = alertsFor(r.key);
  host.innerHTML =
    `<div class="al-bar">` +
      `<button type="button" class="al-add${caps.slack === false ? " al-add-off" : ""}" id="al-add">` +
        `${caps.slack === false ? "＋ Set alert (Slack not connected)" : "＋ Set alert"}</button>` +
      (mine.length
        ? mine.map((a) => {
            const fired = a.lastFiredAt
              ? `fired ${fmtAgo(Date.now() - a.lastFiredAt)} ago${a.firedCount > 1 ? ` · ${a.firedCount}×` : ""}`
              : "not fired yet";
            return `<span class="al-chip${a.lastError ? " al-err" : ""}${a.global ? " al-global" : ""}" title="${esc(a.lastError || fired)}">` +
              `<span class="al-when">${esc(a.label)}</span>` +
              (a.global ? `<span class="al-scope">every endpoint</span>` : "") +
              `<span class="al-ch">${esc(a.channel)}</span>` +
              `<span class="al-state">${esc(a.lastError ? "failed" : fired)}</span>` +
              `<button type="button" class="al-del" data-id="${esc(a.id)}" title="Remove this alert">×</button>` +
            `</span>`;
          }).join("")
        : `<span class="al-none">no alerts on this endpoint</span>`) +
    `</div>`;

  document.getElementById("al-add").addEventListener("click", (e) => {
    e.stopPropagation();
    openAlertPop(e.currentTarget, r.key);
  });
  host.querySelectorAll(".al-del").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); deleteAlert(b.dataset.id); }));
}

/* Said the same way wherever a rule can be created — the rules dialog and this
 * popover — because they're the same condition. Not connected doesn't block
 * creating a rule: configuring alerts before wiring Slack is a normal order to
 * work in, and a warning you can act on beats a block you could walk around by
 * using the other form. */
function slackBannerHtml() {
  if (caps.slack === false) {
    return `<div class="ar-banner">Slack isn't connected, so these rules can't deliver yet. ` +
      `<a href="${SETTINGS_URL}" target="_blank" rel="noopener">Connect it at yeet.cx/settings ↗</a> ` +
      `— no restart needed, this page notices within 30 seconds.</div>`;
  }
  if (caps.slack !== true) {
    return `<div class="ar-note">Couldn't confirm the Slack integration, so delivery is unverified. ` +
      `If alerts fail, the reason shows on the rule — check ` +
      `<a href="${SETTINGS_URL}" target="_blank" rel="noopener">yeet.cx/settings</a>.</div>`;
  }
  return "";
}

function openAlertPop(anchor, key) {
  const pop = openPop(anchor, "alert-pop",
    `<div class="pop-title">Alert on this endpoint</div>` +
    slackBannerHtml() +
    `<div class="al-key">${esc(key)}</div>` +
    ALERT_CHOICES.map((c, i) =>
      `<label class="pop-item"><input type="radio" name="alwhen" value="${c.v}" ${i === 0 ? "checked" : ""}/> ` +
      `<span>${esc(c.label)}<span class="pop-hint">${esc(c.hint)}</span></span></label>`).join("") +
    `<div class="al-row al-code-row" hidden><label>Code <input type="number" class="al-code" min="100" max="599" value="503"/></label></div>` +
    `<div class="pop-sep"></div>` +
    // The catchall: one rule for the whole host, which is the sane starting
    // point ("tell me about any 5xx anywhere") before you know which routes
    // matter. One cooldown covers everything, and the alert names the worst
    // offenders rather than sending one message per route.
    `<label class="pop-item"><input type="checkbox" class="al-any"/> ` +
      `<span>Every endpoint on this host<span class="pop-hint">instead of just this one — one alert, listing where</span></span></label>` +
    `<div class="al-row"><label>Channel <input type="text" class="al-channel" value="${esc(slackChannel)}" spellcheck="false"/></label></div>` +
    `<div class="al-row"><label>At most once every <input type="number" class="al-cooldown" min="10" max="86400" value="300"/> s</label></div>` +
    `<label class="pop-item"><input type="checkbox" class="al-body"/> ` +
      `<span>Include the response body<span class="pop-hint">posts the payload into the channel — Slack has no spoiler, so it's visible there</span></span></label>` +
    `<div class="pop-note">Matches keep counting during the quiet period and the ` +
      `next alert says how many.</div>` +
    `<div class="pop-err" hidden></div>` +
    `<div class="pop-actions"><button class="pop-apply">Create</button></div>`);
  if (!pop) return;

  const codeRow = pop.querySelector(".al-code-row");
  pop.querySelectorAll('input[name="alwhen"]').forEach((radio) =>
    radio.addEventListener("change", () => { codeRow.hidden = pop.querySelector('input[name="alwhen"]:checked').value !== "code"; }));

  const anyBox = pop.querySelector(".al-any");
  const keyLine = pop.querySelector(".al-key");
  anyBox.addEventListener("change", () => {
    keyLine.textContent = anyBox.checked ? "* — every endpoint" : key;
    keyLine.classList.toggle("al-key-any", anyBox.checked);
  });

  pop.querySelector(".pop-apply").addEventListener("click", async () => {
    const when = pop.querySelector('input[name="alwhen"]:checked').value;
    const payload = {
      key: anyBox.checked ? "*" : key,
      when,
      channel: pop.querySelector(".al-channel").value.trim(),
      cooldownSec: Number(pop.querySelector(".al-cooldown").value),
    };
    if (when === "code") payload.code = Number(pop.querySelector(".al-code").value);
    payload.includeBody = pop.querySelector(".al-body").checked;
    const err = pop.querySelector(".pop-err");
    err.hidden = true;
    const res = await postAlert(payload);
    if (res.error) { err.textContent = res.error; err.hidden = false; return; }
    closePop();
  });
}

async function postAlert(payload) {
  try {
    const res = await fetch("/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) return { error: j.error || `request failed (${res.status})` };
    track("alert_rule_created", {
      when: payload.when,
      catchall: payload.key === "*",
      include_body: !!payload.includeBody,
      cooldown_sec: payload.cooldownSec,
      // Whether they kept the default channel, not what they typed.
      default_channel: payload.channel === slackChannel,
    });
    alertRules = j.alerts || alertRules;
    renderAlertsPill();
    if (selectedKey) renderAlertsBar(currentEndpoint());
    return {};
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function deleteAlert(id) {
  try {
    const res = await fetch(`/api/alerts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (j.ok) {
      track("alert_rule_deleted");
      alertRules = j.alerts || alertRules.filter((a) => a.id !== id);
      renderAlertsPill();
      if (selectedKey) renderAlertsBar(currentEndpoint());
    }
  } catch { /* leave the chip in place; the next refresh reconciles */ }
}

/** Re-read the rules (their fired counts change server-side as they trigger). */
// ── all rules, in one place ──────────────────────────────────────────────────
// The per-endpoint bar only shows rules for the endpoint you're looking at, so
// there's a header pill that opens every rule at once — where they can be edited
// or removed without first working out which endpoint each one belongs to.

function renderAlertsPill() {
  const n = alertRules.length;
  const broken = alertRules.filter((a) => a.lastError).length;
  el.alertsPill.textContent = n ? `alerts: ${n}${broken ? ` · ${broken} failing` : ""}` : "alerts: none";
  el.alertsPill.classList.add("clickable");
  el.alertsPill.classList.toggle("warn", broken > 0);
}

function alertsModalOpen() { return !el.alertsModal.hidden; }

function openAlertsModal() {
  el.alertsModal.hidden = false;
  renderAlertsModal();
}

function closeAlertsModal() { el.alertsModal.hidden = true; }

/** One editable row per rule: what it watches, where it posts, how often. */
function ruleRowHtml(a) {
  const fired = a.lastFiredAt
    ? `fired ${fmtAgo(Date.now() - a.lastFiredAt)} ago${a.firedCount > 1 ? ` · ${a.firedCount}×` : ""}`
    : "not fired yet";
  return `<div class="ar-row${a.lastError ? " ar-err" : ""}" data-id="${esc(a.id)}">` +
    `<div class="ar-scope">` +
      (a.global
        ? `<span class="ar-any">every endpoint</span>`
        : `<button type="button" class="ar-goto" title="Open this endpoint">${esc(a.key)}</button>`) +
    `</div>` +
    `<label class="ar-f"><span>When</span>` +
      `<select class="ar-when">` +
        ALERT_CHOICES.map((c) => `<option value="${c.v}" ${c.v === a.when ? "selected" : ""}>${esc(c.label)}</option>`).join("") +
      `</select></label>` +
    `<label class="ar-f ar-f-code"${a.when === "code" ? "" : " hidden"}><span>Code</span>` +
      `<input type="number" class="ar-code" min="100" max="599" value="${a.code || 500}"/></label>` +
    `<label class="ar-f"><span>Channel</span><input type="text" class="ar-channel" value="${esc(a.channel)}" spellcheck="false"/></label>` +
    `<label class="ar-f"><span>Every</span><input type="number" class="ar-cooldown" min="10" max="86400" value="${a.cooldownSec}"/><span class="ar-unit">s</span></label>` +
    `<label class="ar-f ar-f-check"><span>Body</span>` +
      `<span class="ar-check"><input type="checkbox" class="ar-body" ${a.includeBody ? "checked" : ""}/>` +
      `<span>include it${a.includeBody ? "" : ""}</span></span></label>` +
    `<div class="ar-state">${esc(a.lastError || fired)}</div>` +
    `<div class="ar-actions">` +
      `<button type="button" class="ar-save" disabled>Save</button>` +
      `<button type="button" class="ar-del" title="Remove this rule">Delete</button>` +
    `</div>` +
  `</div>`;
}

function renderAlertsModal() {
  const body = el.alertsModalBody;
  // Catchalls first — they apply everywhere, so they're the ones to notice.
  const sorted = alertRules.slice().sort((a, b) =>
    (a.global === b.global ? a.key.localeCompare(b.key) : a.global ? -1 : 1));

  body.innerHTML =
    slackBannerHtml() +
    (sorted.length
      ? `<div class="ar-list">${sorted.map(ruleRowHtml).join("")}</div>`
      : `<div class="ar-empty">No alert rules yet. Add one below, or from any endpoint's detail panel.</div>`) +
    `<div class="ar-new">` +
      `<div class="ar-new-title">Add a rule</div>` +
      `<label class="ar-f ar-f-wide"><span>Endpoint</span>` +
        `<input type="text" class="ar-n-key" value="*" spellcheck="false" placeholder="* or: GET host /path"/></label>` +
      `<label class="ar-f"><span>When</span><select class="ar-n-when">` +
        ALERT_CHOICES.map((c) => `<option value="${c.v}">${esc(c.label)}</option>`).join("") +
      `</select></label>` +
      `<label class="ar-f ar-f-code" hidden><span>Code</span><input type="number" class="ar-n-code" min="100" max="599" value="503"/></label>` +
      `<label class="ar-f"><span>Channel</span><input type="text" class="ar-n-channel" value="${esc(slackChannel)}" spellcheck="false"/></label>` +
      `<label class="ar-f"><span>Every</span><input type="number" class="ar-n-cooldown" min="10" max="86400" value="300"/><span class="ar-unit">s</span></label>` +
      `<label class="ar-f ar-f-check"><span>Body</span>` +
        `<span class="ar-check"><input type="checkbox" class="ar-n-body"/><span>include it</span></span></label>` +
      `<button type="button" class="ar-add">Create</button>` +
      `<div class="ar-hint"><code>*</code> watches every endpoint. Otherwise use the key exactly as the table shows it: <code>GET shop.internal /api/orders</code>. ` +
        `Including the body posts the response payload into the channel; the alert always links back here either way.</div>` +
    `</div>` +
    `<div class="ar-err-msg" hidden></div>`;

  wireAlertsModal();
}

function wireAlertsModal() {
  const body = el.alertsModalBody;
  const err = body.querySelector(".ar-err-msg");
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  const clear = () => { err.hidden = true; };

  // Existing rules: enable Save once something actually changed.
  body.querySelectorAll(".ar-row").forEach((row) => {
    const id = row.dataset.id;
    const saveBtn = row.querySelector(".ar-save");
    const whenSel = row.querySelector(".ar-when");
    const codeField = row.querySelector(".ar-f-code");
    const touched = () => { saveBtn.disabled = false; };
    row.querySelectorAll("select, input").forEach((f) => {
      f.addEventListener("input", touched);
      f.addEventListener("change", touched);
    });
    whenSel.addEventListener("change", () => { codeField.hidden = whenSel.value !== "code"; });

    saveBtn.addEventListener("click", async () => {
      clear();
      const patch = {
        when: whenSel.value,
        channel: row.querySelector(".ar-channel").value.trim(),
        cooldownSec: Number(row.querySelector(".ar-cooldown").value),
      };
      if (whenSel.value === "code") patch.code = Number(row.querySelector(".ar-code").value);
      patch.includeBody = row.querySelector(".ar-body").checked;
      saveBtn.disabled = true;
      const res = await patchAlert(id, patch);
      if (res.error) { fail(res.error); saveBtn.disabled = false; }
    });

    row.querySelector(".ar-del").addEventListener("click", async () => {
      clear();
      await deleteAlert(id);
      renderAlertsModal();
    });

    row.querySelector(".ar-goto")?.addEventListener("click", () => {
      // Jump to the endpoint this rule watches, if it's still in the table.
      const key = alertRules.find((a) => a.id === id)?.key;
      if (!key) return;
      closeAlertsModal();
      if ((snapshot?.endpoints || []).some((e) => e.key === key)) selectEndpoint(key);
    });
  });

  // The "add" form.
  const nWhen = body.querySelector(".ar-n-when");
  const nCode = body.querySelector(".ar-new .ar-f-code");
  nWhen.addEventListener("change", () => { nCode.hidden = nWhen.value !== "code"; });
  body.querySelector(".ar-add").addEventListener("click", async () => {
    clear();
    const payload = {
      key: body.querySelector(".ar-n-key").value.trim(),
      when: nWhen.value,
      channel: body.querySelector(".ar-n-channel").value.trim(),
      cooldownSec: Number(body.querySelector(".ar-n-cooldown").value),
    };
    if (nWhen.value === "code") payload.code = Number(body.querySelector(".ar-n-code").value);
    payload.includeBody = body.querySelector(".ar-n-body").checked;
    const res = await postAlert(payload);
    if (res.error) return fail(res.error);
    renderAlertsModal();
  });
}

async function patchAlert(id, patch) {
  try {
    const res = await fetch(`/api/alerts?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) return { error: j.error || `request failed (${res.status})` };
    alertRules = j.alerts || alertRules;
    renderAlertsPill();
    renderAlertsModal();
    if (selectedKey) renderAlertsBar(currentEndpoint());
    return {};
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function refreshAlerts() {
  try {
    const j = await fetch("/api/alerts", { cache: "no-store" }).then((x) => x.json());
    if (j.ok) {
      alertRules = j.alerts;
      renderAlertsPill();
      if (selectedKey) renderAlertsBar(currentEndpoint());
      // Refresh an open dialog too, but not while a field is focused — that
      // would yank the input out from under whoever is typing in it.
      if (alertsModalOpen() && !el.alertsModalBody.contains(document.activeElement)) renderAlertsModal();
    }
  } catch { /* transient */ }
}

// ── stream pause ────────────────────────────────────────────────────────────
// A live tail that moves under you is unusable for reading one entry, and
// compensating scrollTop isn't enough — the rows still shift and the scrollbar
// crawls. So the stream *holds* instead: as soon as you scroll off the top or
// expand a request, new rows queue up behind a banner and nothing in view moves
// until you come back. Rows aren't trimmed while held either, so the request
// you're reading can't be pruned out from under you.
let streamHeld = [];        // rows that arrived while paused, oldest first
const HELD_MAX = 500;       // bounded; the oldest are forgotten past this
let streamHeldLost = 0;     // how many were forgotten, so we can say so

/** Paused whenever you're not at the top, or something is expanded. */
function streamPaused(stream) {
  return openSeq !== null || (stream ? stream.scrollTop > 3 : false);
}

function renderHeldBanner() {
  const banner = document.getElementById("req-held");
  if (!banner) return;
  const n = streamHeld.length;
  if (!n) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.textContent = `${fmtCount(n)} new request${n === 1 ? "" : "s"}` +
    `${streamHeldLost ? ` (${fmtCount(streamHeldLost)} older discarded)` : ""} · click to resume`;
}

/** Flush what queued up, jump back to the top, and start following again. */
function resumeStream() {
  const stream = document.getElementById("req-stream");
  if (!stream) return;
  // Collapse whatever is open — it's what was pinning the stream.
  if (openSeq !== null) {
    const item = document.querySelector(`.req-item[data-seq="${openSeq}"]`);
    if (item) toggleViewer(item);
    openSeq = null;
  }
  if (streamHeld.length) {
    prependRows(stream, streamHeld);
    streamHeld = [];
    streamHeldLost = 0;
  }
  stream.scrollTop = 0;
  renderHeldBanner();
}

/** Insert rows (oldest first) at the top and trim to the cap. */
function prependRows(stream, rows) {
  const placeholder = stream.querySelector(".spark-empty");
  if (placeholder) stream.innerHTML = "";
  stream.insertAdjacentHTML("afterbegin", rows.map((e) => reqItemHtml(e, true)).join(""));
  while (stream.children.length > REQ_STREAM_ROWS) {
    const gone = stream.lastElementChild;
    if (openSeq !== null && Number(gone.dataset.seq) === openSeq) openSeq = null;
    stream.removeChild(gone);
  }
}

/* Snapshot-time refresh — update the aggregate numbers, then either follow the
 * tail or queue new rows if the reader is holding it still. */
function refreshDetail() {
  if (!selectedKey) return;
  const r = currentEndpoint();
  if (r) awaitingLinkedEndpoint = false;
  const aggEl = document.getElementById("d-agg");
  if (aggEl) aggEl.innerHTML = r ? aggHtml(r) : noEndpointHtml();
  renderDropped();
  renderAlertsBar(r);

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

  if (streamPaused(stream)) {
    streamHeld.push(...fresh);
    if (streamHeld.length > HELD_MAX) {
      streamHeldLost += streamHeld.length - HELD_MAX;
      streamHeld = streamHeld.slice(-HELD_MAX);
    }
    renderHeldBanner();
    return; // nothing in view moves
  }

  prependRows(stream, fresh);
  stream.scrollTop = 0;
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
  // Slack may get connected while the page is open; the button's behaviour and
  // the bar's hint both follow this, so re-render the bar when it changes.
  if (snap.caps && snap.caps.slack !== caps.slack) {
    caps = snap.caps;
    if (selectedKey) renderAlertsBar(currentEndpoint());
    if (alertsModalOpen()) renderAlertsModal();
  } else if (snap.caps) {
    caps = snap.caps;
  }
  // The exporter reports what it's actually capturing; trust it over local state.
  if (snap.bodies && snap.bodies !== bodyMode) { bodyMode = snap.bodies; renderBodies(); }

  // Accumulate the streamed request/response deltas (tags each with __seq).
  if (Array.isArray(snap.recent) && snap.recent.length) ingestRecent(snap.recent);
  if (snap.recentDropped) droppedRows += snap.recentDropped;

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
  // Anonymous — this fires from the gate, before there's an identity to attach.
  track("login_started");
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
  // Nothing is tracked on this path — the reload runs startApp again for real.
  if (!snapshot) { location.reload(); return; }
  // The yeet identity behind the gate — the owner id from `yeet whoami`, the
  // only handle this server has for who is looking at it.
  if (boot.auth?.identity) window.hwIdentify?.(boot.auth.identity);
  track("dashboard_opened", {
    endpoints: snapshot?.endpoints?.length || 0,
    body_mode: bodyMode,
    ifaces: watching === "all" ? "all" : (watching || "").split(",").filter(Boolean).length,
    alert_rules: alertRules.length,
    // Arrived from an alert's link rather than by opening the dashboard.
    deep_linked: new URL(window.location.href).searchParams.has(ENDPOINT_PARAM),
  });
  renderIface();
  renderBodies();
  renderAlertsPill();
  renderTotals();
  renderTable();
  openFromUrl();
  connect();
  // Rules mutate server-side as they fire, so re-read them on a slow timer —
  // often enough that "fired 12s ago" is honest, rarely enough to be free.
  setInterval(refreshAlerts, 10_000);
}

/** Honour `?endpoint=…` on load — the target of the links in Slack alerts — and
 *  `/detail` for the full-screen form of the same link. */
function openFromUrl() {
  try {
    const url = new URL(window.location.href);
    const key = url.searchParams.get(ENDPOINT_PARAM);
    if (key) selectEndpoint(key, { focused: url.pathname === FOCUS_PATH });
    else if (url.pathname === FOCUS_PATH) syncUrl(); // /detail with nothing to show → /
  } catch { /* a malformed URL just means no deep link */ }
}

// Back/forward between the list, an open panel, and full screen should all work
// like links, since each of those states is a URL.
window.addEventListener("popstate", () => {
  const url = new URL(window.location.href);
  const key = url.searchParams.get(ENDPOINT_PARAM);
  const wantFocus = !!key && url.pathname === FOCUS_PATH;
  if (key && key !== selectedKey) selectEndpoint(key, { focused: wantFocus });
  else if (!key && selectedKey) closeDetail();
  else if (wantFocus !== focused) { focused = wantFocus; applyFocus(); }
});

// ── boot ────────────────────────────────────────────────────────────────
el.iface.addEventListener("click", (e) => { e.stopPropagation(); openIfacePop(); });
el.bodies.addEventListener("click", (e) => { e.stopPropagation(); openBodiesPop(); });
el.alertsPill.addEventListener("click", (e) => {
  e.stopPropagation();
  alertsModalOpen() ? closeAlertsModal() : openAlertsModal();
});
el.alertsModalClose.addEventListener("click", closeAlertsModal);
// Clicking the backdrop (but not the card) closes it.
el.alertsModal.addEventListener("click", (e) => { if (e.target === el.alertsModal) closeAlertsModal(); });
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
