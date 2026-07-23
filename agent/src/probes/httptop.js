// HTTP ingest + aggregation — the kernel → user data layer. It subscribes to
// the `events` ring buffer on the shared object, parses method + Host + path
// out of each captured request, pairs responses to measure on-the-wire
// latency, and aggregates by endpoint into the reactive signals the
// components read (`rows`, `tick`) plus the `totals` / `endpoint()` lookups.
//
// Each completed pair also carries a head + body preview (stitched from the
// KIND_BODY continuation events the kernel forwards) on the `recentEvents` log,
// which is what lets the web UI open one request and read the error it returned.
// Which directions are kept follows --bodies: responses by default, requests
// only with `both`, neither with `none`. The TUI shows only the aggregates.
//
// Unlike the from() idiom (subscription tied to a signal being watched), the
// subscription and tick timers are started eagerly at module load: ingestion
// has to keep running on *both* screens, and the detail screen never reads
// `rows`, so a from() over `rows` would tear the ring buffer down whenever
// detail is open. A daemon-style always-on feed is the right shape here.
import { signal } from "yeet:tui";
import { RingBuf } from "yeet:bpf";
import { bodyMode, control } from "@/probes/probe.js";
import { fmtCount } from "@/lib/format.js";

/* What --bodies asked for. The kernel is already capturing only this much (the
 * knobs in probe.js), so these flags just keep the ingest side from stashing
 * bytes it was told not to keep. */
const keepReqBody = bodyMode === "both";
const keepRespBody = bodyMode !== "none";

export const TICK_MS = 400; /* redraw cadence between per-second rate samples */

/* Collapse the query string so `/x?id=1` and `/x?id=2` aggregate together.
 * `--keep-query` keeps them distinct. */
const keepQuery = !!yeet.args.keep_query;

/* endpoint key -> { method, host, path, count, prev, rate, peak, bytes,
 * first, last, hist, lat, status, lastMs } */
const stats = new Map();
export const rows = signal([]);
export const totals = { reqs: 0, bytes: 0, startMs: Date.now() };
export const endpointCount = () => stats.size;
export const endpoint = (key) => stats.get(key) ?? null;
export const keyOf = (r) => `${r.method} ${r.host} ${r.path}`;

/* Bumped every redraw tick. The detail screen reads it so it re-renders as an
 * endpoint's in-place fields (rate, latency, …) change — those mutations don't
 * touch a signal on their own. The list re-renders via `rows` instead. */
export const tick = signal(0);

export const HIST_LEN = 60;  /* req/s samples kept per endpoint (≈1 min) */
export const LAT_LEN = 200;  /* recent response latencies kept (ms) */

/* Rolling log of individual completed request/response pairs (newest last).
 * Only the web exporter uses this: it drains the buffer each tick to stream a
 * per-route request history to the browser, color-coded by status class. The
 * TUI never reads it. Bounded so a slow/absent drain can't leak memory.
 *
 * Each entry also carries head + body previews for the directions --bodies asked
 * for, so the browser can show what an individual 4xx/5xx actually said. */
const recentEvents = [];
const RECENT_CAP = 4000;

/* Stable per-exchange id. Bodies no longer ride inside the snapshot frame — they
 * are streamed as their own console lines and reassembled by the server — so the
 * row and its bodies need a name they can be matched up by. Monotonic within one
 * exporter run, which is the same lifetime as the ids on the server. */
let idCounter = 0;

/* http_event.flags: the kernel dropped the rest of that segment. Anything after
 * it would be stitched across a hole, so the message ends there. */
const F_TRUNC = 1;

/* How much of one message we keep. The kernel caps what it ships (a first
 * segment plus a continuation budget, both sized in probes/probe.js); these are
 * the backstop on what we hold in memory per exchange. They sit just above the
 * largest thing the kernel will send, so in practice the kernel's budget is what
 * decides — these only catch a runaway. */
const HEAD_MAX = 8192;   /* start line + headers, chars */
const BODY_MAX = 262144; /* body, chars — matches the kernel's 4xx/5xx ceiling */

/* Body segments arrive microseconds after the response they belong to, but a
 * drain landing in between would ship the entry before its body is stitched on.
 * Holding entries back by a beat lets them settle first — the stream is a live
 * log, so a fraction of a second of extra lag costs nothing. */
const SETTLE_MS = 150;

export function drainRecent(max = 600) {
  if (recentEvents.length === 0) return [];
  const cutoff = Date.now() - SETTLE_MS;
  // Entries are pushed in completion order, so the settled ones are a prefix.
  let n = 0;
  while (n < recentEvents.length && recentEvents[n].ts <= cutoff) n++;
  if (n === 0) return [];
  const settled = recentEvents.splice(0, n);
  const out = settled.length > max ? settled.slice(-max) : settled;
  for (const e of out) seal(e);
  return out;
}

const CLEN_RE = /(?:^|\r\n)content-length:[ \t]*(\d+)/i;
/* Content-Length off a captured head, or null when the sender didn't send one
 * (chunked, or a head we didn't capture whole). */
function contentLength(head) {
  const m = CLEN_RE.exec(head || "");
  return m ? Number(m[1]) : null;
}

/* Decide, now that no more segments can arrive, whether each direction is the
 * whole message. Content-Length is the authority when it's there — the kernel's
 * per-record "there were more bytes in this segment" flag only catches a hard
 * hole, and a body that simply ran past its budget leaves no such mark. */
function seal(e) {
  if (e.head !== undefined) {
    const cl = contentLength(e.head);
    if (e.trunc || (cl != null && e.body.length < cl)) e.more = true;
    e.clen = cl;
    delete e.trunc;
  }
  if (e.reqHead !== undefined) {
    const cl = contentLength(e.reqHead);
    if (e.reqTrunc || (cl != null && e.reqBody.length < cl)) e.reqMore = true;
    e.reqClen = cl;
    delete e.reqTrunc;
  }
  return e;
}

/* ---- parsing ------------------------------------------------------ */
function bytesToLatin1(bytes, max) {
  let s = "";
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/* Like bytesToLatin1 but byte-exact: no NUL stop, every byte becomes the code
 * unit of the same value. A body is arbitrary bytes (it may be gzipped), and
 * this is what lets the browser recover them 1:1 with `charCodeAt(i) & 0xff`. */
function bytesToRaw(bytes, max) {
  let s = "";
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const REQ_LINE = /^([A-Z]+) +(\S+) +HTTP\/\d\.\d$/;
const STATUS_LINE = /^HTTP\/\d\.\d (\d{3})/;

/* Status code from a response's first line, or 0 if unparseable. */
function parseStatus(bytes) {
  const m = STATUS_LINE.exec(bytesToLatin1(bytes, bytes.length));
  return m ? Number(m[1]) : 0;
}

/* Parse a request line + Host header out of the captured prefix. Returns
 * { method, host, path } or null if it isn't a well-formed request. */
function parseRequest(bytes) {
  const text = bytesToLatin1(bytes, bytes.length);
  const headEnd = text.indexOf("\r\n\r\n");
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const lines = head.split("\r\n");
  const m = REQ_LINE.exec(lines[0] || "");
  if (!m) return null;

  const method = m[1];
  let target = m[2];

  let host = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const c = line.indexOf(":");
    if (c > 0 && line.slice(0, c).toLowerCase() === "host") {
      host = line.slice(c + 1).trim();
      break;
    }
  }

  // CONNECT / absolute-form targets carry the authority in the target itself.
  if (target.startsWith("http://") || target.startsWith("https://")) {
    const rest = target.slice(target.indexOf("://") + 3);
    const slash = rest.indexOf("/");
    if (!host) host = slash >= 0 ? rest.slice(0, slash) : rest;
    target = slash >= 0 ? rest.slice(slash) : "/";
  }

  let path = target;
  if (!keepQuery) {
    const q = path.indexOf("?");
    if (q >= 0) path = path.slice(0, q);
  }
  return { method, host: host || "-", path };
}

/* ---- ingest ------------------------------------------------------- */
/* Dedup loopback double-sightings (a `lo` packet hits both egress & ingress
 * with the same 4-tuple + seq). Keyed flow+seq, pruned by age. */
const seen = new Map(); // dedupKey -> ms
function isDuplicate(ev, now) {
  const k = `${ev.family}:${ev.sport}>${ev.dport}#${ev.seq}`;
  if (seen.has(k)) return true;
  seen.set(k, now);
  return false;
}

/* Pending requests awaiting a response, per flow. A flow is the unordered port
 * pair (a request's reverse-direction response shares it), so each response
 * pairs with the oldest pending request on the same flow (FIFO — HTTP/1.x is
 * request-ordered). Each entry: { ts (kernel ns), key, at (wall ms, for prune) }. */
const pending = new Map(); // flowKey -> [entry, …]
const flowKey = (ev) => `${ev.family}:${Math.min(ev.sport, ev.dport)}-${Math.max(ev.sport, ev.dport)}`;

/* Where the *next* continuation record on a flow should be appended. Keyed by
 * the sender's direction (a message and its continuations share sport/dport), so
 * it's a one-slot buffer per direction: { target, room, at, headOpen }. `target`
 * is the object being grown — the recentEvents entry for a response, the
 * pending-request entry for a request. Armed by onRequest/onResponse, consumed
 * by onBody, and replaced/dropped by the next message in that direction.
 *
 * Continuations are now both the later *segments* of a message and the later
 * *chunks* of one oversized segment (a 64KB loopback write crosses the ring
 * buffer as ~32 records), so this path carries the bulk of every large body. */
const bodyFill = new Map(); // dirKey -> { target, room, at }
const dirKey = (ev) => `${ev.family}:${ev.sport}>${ev.dport}`;

/* one ring-buffer event (an `http_event`, wrapped under its btf_struct name).
 * Wrapped so a single malformed event can't throw out of the ring-buffer
 * callback — an uncaught throw here has no handler and would kill the isolate
 * (the daemon then reaps it and the server respawns → crash loop). */
function onEvent(raw) {
  try {
    const ev = raw.http_event ?? raw;
    const now = Date.now();
    if (isDuplicate(ev, now)) return;

    const data = ev.data instanceof Uint8Array
      ? ev.data
      : Uint8Array.from(Object.values(ev.data));

    if (ev.kind === 1) onResponse(ev, data, now);
    else if (ev.kind === 2) onBody(ev, data, now);
    else onRequest(ev, data, now);
  } catch (err) {
    console.error(`[httptop] dropped a bad event: ${err.message}`);
  }
}

function onRequest(ev, data, now) {
  // Whatever the previous request in this direction was still collecting is
  // over (see the mirror of this in onResponse).
  bodyFill.delete(dirKey(ev));

  const captured = data.subarray(0, Number(ev.captured));
  const req = parseRequest(captured);
  if (!req) return;

  const key = keyOf(req);
  let row = stats.get(key);
  if (!row) {
    row = { ...req, count: 0, prev: 0, rate: 0, peak: 0, bytes: 0,
            first: now, last: now, hist: [], lat: [], status: {}, lastMs: null };
    stats.set(key, row);
  }
  const len = Number(ev.total_len);
  row.count++;
  row.last = now;
  row.bytes += len;
  totals.reqs++;
  totals.bytes += len;

  // Queue this request so the matching response can measure its latency. With
  // --bodies=both the entry also collects the request's head + body, which
  // onResponse copies onto the completed pair (a row exists only once paired).
  const f = flowKey(ev);
  let q = pending.get(f);
  if (!q) { q = []; pending.set(f, q); }
  const entry = { ts: Number(ev.ts), key, at: now };
  q.push(entry);
  if (q.length > 64) q.shift(); // cap a flow whose responses we never see

  if (!keepReqBody) return;
  const split = splitMessage(captured);
  entry.head = split.head;
  entry.body = split.body;
  if (ev.flags & F_TRUNC) entry.trunc = true;
  armSlot(ev, entry, split, now);
}

/* Split a captured message into its head (start line + headers) and the body
 * bytes that shared the record. `open` means the header block wasn't terminated
 * in here — a long head spilling into the next record — so the caller keeps
 * feeding what follows into the head rather than into the body. */
function splitMessage(captured) {
  const text = bytesToRaw(captured, captured.length);
  const sep = text.indexOf("\r\n\r\n");
  if (sep < 0) return { head: text.slice(0, HEAD_MAX), body: "", open: text.length < HEAD_MAX };
  return { head: text.slice(0, sep).slice(0, HEAD_MAX), body: text.slice(sep + 4, sep + 4 + BODY_MAX), open: false };
}

/* Append one continuation record to whatever the slot's message still wants.
 * A head that hasn't closed yet takes precedence: until the blank line shows up,
 * these bytes are still headers, and only what follows it is body. */
function feedSlot(slot, chunk) {
  const t = slot.target;
  if (slot.headOpen) {
    t.head += chunk;
    const sep = t.head.indexOf("\r\n\r\n");
    if (sep >= 0) {
      t.body = t.head.slice(sep + 4, sep + 4 + BODY_MAX);
      t.head = t.head.slice(0, sep);
      slot.headOpen = false;
      slot.room = BODY_MAX - t.body.length;
    } else if (t.head.length >= HEAD_MAX) {
      // A header block this long isn't going to become readable by growing it.
      t.head = t.head.slice(0, HEAD_MAX);
      slot.headOpen = false;
      slot.room = 0;
    }
    return;
  }
  t.body += chunk.length > slot.room ? chunk.slice(0, slot.room) : chunk;
  slot.room = Math.max(0, slot.room - chunk.length);
}

/* Park a message so the records that follow it in the same direction land on it.
 * Skipped once there's nothing left to collect. */
function armSlot(ev, target, split, now) {
  const slot = { target, at: now, headOpen: split.open, room: BODY_MAX - target.body.length };
  if (slot.headOpen || slot.room > 0) bodyFill.set(dirKey(ev), slot);
}

function onResponse(ev, data, now) {
  // Whatever the previous response on this stream was still collecting, it's
  // over: these bytes belong to a new one. Drop the slot before the early
  // returns below, or a stale target would swallow this response's body.
  bodyFill.delete(dirKey(ev));

  const q = pending.get(flowKey(ev));
  if (!q || q.length === 0) return; // no request seen for this flow
  const req = q.shift();
  const { ts: reqTs, key } = req;
  if (q.length === 0) pending.delete(flowKey(ev));

  const row = stats.get(key);
  if (!row) return;

  const ms = Math.max(0, (Number(ev.ts) - reqTs) / 1e6); // monotonic ns → ms
  row.lat.push(ms);
  if (row.lat.length > LAT_LEN) row.lat.shift();
  row.lastMs = ms;

  const captured = data.subarray(0, Number(ev.captured));
  const code = parseStatus(captured);
  if (code) row.status[code] = (row.status[code] || 0) + 1;

  // One entry per completed pair, for the web request-history stream. The
  // request side was collected while the request was pending (--bodies=both);
  // carry it over now that there's a row to hang it on.
  const entry = { id: ++idCounter, key, ts: now, code: code || 0, ms: Math.round(ms * 100) / 100 };
  if (keepReqBody && req.head !== undefined) {
    entry.reqHead = req.head;
    entry.reqBody = req.body;
    if (req.trunc) entry.reqTrunc = true;
  }
  if (keepRespBody) {
    // The kernel ships the response's first segment — status line, headers, and
    // however much body the server wrote alongside them — as one or more records.
    const split = splitMessage(captured);
    entry.head = split.head;
    entry.body = split.body;
    if (ev.flags & F_TRUNC) entry.trunc = true;
    // The rest of the head, or of the body, continues in the records that follow
    // (both the remaining chunks of this segment and any later segment).
    armSlot(ev, entry, split, now);
  }
  recentEvents.push(entry);
  if (recentEvents.length > RECENT_CAP) recentEvents.shift();
}

/* A KIND_BODY continuation: the kernel already verified it is the in-order next
 * segment of the message that armed this direction, so append it to whatever
 * that message left here — a pending request, or a completed pair's entry. */
function onBody(ev, data, now) {
  const k = dirKey(ev);
  const slot = bodyFill.get(k);
  if (!slot) return; // message we never paired, or its budget is spent
  const n = Number(ev.captured);
  feedSlot(slot, bytesToRaw(data.subarray(0, n), n));
  slot.at = now;
  // F_TRUNC means the kernel dropped the rest of that segment, so what follows
  // can't be stitched on — the message stops here, and stops short.
  if (ev.flags & F_TRUNC) {
    slot.target.trunc = true; // pending requests carry it too; onResponse renames it
    bodyFill.delete(k);
    return;
  }
  if (!slot.headOpen && slot.room <= 0) bodyFill.delete(k);
}

/* ---- ticking ------------------------------------------------------ */
/* Re-sort endpoints by count and push to the `rows` signal (the view reads it
 * reactively). Called on every redraw tick. */
function refresh() {
  rows.set([...stats.values()].sort((a, b) => b.count - a.count));
}

/* Per-second: turn the count delta since the last sample into a req/s rate,
 * and prune stale dedup keys. */
function sampleRates() {
  const now = Date.now();
  for (const row of stats.values()) {
    row.rate = row.count - row.prev;
    row.prev = row.count;
    if (row.rate > row.peak) row.peak = row.rate;
    row.hist.push(row.rate);
    if (row.hist.length > HIST_LEN) row.hist.shift();
  }
  for (const [k, t] of seen) if (now - t > 4000) seen.delete(k);

  // Drop pending requests whose response never arrived (>10s) so unmatched
  // flows don't leak; an empty queue is removed entirely.
  for (const [f, q] of pending) {
    while (q.length && now - q[0].at > 10000) q.shift();
    if (q.length === 0) pending.delete(f);
  }

  // Same for body slots whose continuation stopped coming (the response ended
  // inside its budget, or the flow went quiet). Holding one pins the entry it
  // points at, so they're short-lived by design.
  for (const [k, slot] of bodyFill) if (now - slot.at > 5000) bodyFill.delete(k);

  refresh();
  tick.set(tick.get() + 1); // wake the detail screen (see `tick`)

  // Reflect live totals in the terminal title. `tty` is only defined in TTY
  // mode (absent when piped/redirected), so guard it.
  if (typeof tty !== "undefined") {
    tty.title(`httpinspect · ${fmtCount(totals.reqs)} reqs · ${stats.size} endpoints`);
  }
}

// Start the feed. The ring buffer is single-consumer and ingestion is
// always-on (see the module header), so wire it up at load time.
new RingBuf(control, "events").subscribe(
  onEvent,
  (err) => console.error("[httptop] ringbuf error:", err.message),
);
// A throw in a setInterval callback is uncaught and would kill the isolate, so
// guard the periodic work too — a failed tick should be skipped, not fatal.
const guarded = (fn, label) => () => {
  try { fn(); } catch (err) { console.error(`[httptop] ${label} failed: ${err.message}`); }
};
setInterval(guarded(sampleRates, "rate sample"), 1000);
setInterval(guarded(refresh, "refresh"), TICK_MS); // snappier redraw between rate ticks
