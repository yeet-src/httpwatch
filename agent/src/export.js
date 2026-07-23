// Headless exporter entry for the *web* build of httpinspect.
//
// This replaces the TUI (src/main.jsx) as the bundle entry. It imports the
// exact same data layer the terminal dashboard uses — probes/probe.js loads
// the shared BPF object, probes/httptop.js parses + aggregates HTTP endpoints
// into the reactive `rows`/`totals`/`tick` signals — and, instead of painting
// a terminal, prints one JSON snapshot per second to stdout.
//
// yeet mirrors an isolate's console onto a WebSocket "portal" (the daemon
// exposes `-p console:ws://…`), so "printing to stdout" IS the wire: the node
// server connects to that portal as a client, parses these snapshots, and
// serves them to the browser. No TUI is streamed — the browser gets raw data
// and renders it in native components.
//
//   yeet run . -- --iface lo,eth0   # narrow to interfaces (same flags as the TUI)
//   yeet run . -- --keep-query      # keep query strings distinct
//   yeet run . -- --bodies both     # capture request bodies too (default: response)
//   yeet run . -- --body-rate 32    # raise the MB/s ceiling on captured bodies
//
// The `@/` alias resolves at bundle time (esbuild + tsconfig paths), exactly
// as it does for the TUI entry, so this module reuses the ingest code with no
// forked logic.
import { bodyMode, ifaceLabel } from "@/probes/probe.js";
import { rows, totals, endpointCount, keyOf, drainRecent } from "@/probes/httptop.js";
import { percentile } from "@/lib/format.js";

/* All up interfaces on the host, for the web UI's interface picker. Queried
 * once at startup, independent of the --iface filter the probe applied — so the
 * browser can offer every interface even when we're currently watching a subset. */
let availIfaces = [];
try {
  const { data } = await yeet.graph.query(`{ network_interfaces { name is_up } }`);
  availIfaces = (data.network_interfaces || []).filter((i) => i.is_up).map((i) => i.name);
} catch (err) {
  console.error(`[export] could not list interfaces: ${err.message}`);
}

/* Emit cadence. httptop samples req/s once a second; matching that keeps the
 * rate/sparkline data coherent without emitting redundant frames. */
const EMIT_MS = 1000;

/* Which alert destinations the host can actually reach. `yeet.caps()` lists the
 * OAuth integrations configured at yeet.cx/settings, and it only exists inside
 * an isolate — so this exporter is the one place that can answer the question,
 * and it rides along in the snapshot for the server and the browser to use.
 *
 * Polled rather than read once: connecting Slack shouldn't require restarting
 * the probe to be noticed. `null` means "couldn't tell" (not logged in, or the
 * call failed) — distinct from a definite "not connected", because the UI says
 * different things about those. */
const CAPS_MS = 30_000;
let caps = { slack: null, providers: null };

const CAPS_TIMEOUT_MS = 5000;

async function pollCaps() {
  try {
    // Raced against a timeout: this is a control-plane call, and the dashboard
    // must not be held hostage by it — the first snapshot is awaited below, so a
    // hang here would mean a page that never loads.
    const { credentials } = await Promise.race([
      yeet.caps(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), CAPS_TIMEOUT_MS)),
    ]);
    const providers = [...new Set((credentials || []).map((c) => c.provider))].sort();
    caps = { slack: providers.includes("slack"), providers };
  } catch (err) {
    // Unknown, which is NOT the same as "not connected": the server still tries
    // to deliver on unknown, so a hiccup here can never silence alerting.
    caps = { slack: null, providers: null, error: String(err?.message ?? err) };
  }
}
await pollCaps();
setInterval(() => { pollCaps().catch(() => {}); }, CAPS_MS);

/* Per-endpoint latency samples kept in httptop (LAT_LEN=200). We ship only the
 * recent tail for the detail sparkline — enough to draw, small on the wire. */
const LAT_TAIL = 60;

/* Round to keep the JSON compact; sub-0.01ms precision is noise here. */
const r2 = (n) => Math.round(n * 100) / 100;

/* One frame is one console line on the portal, and the portal SILENTLY DROPS a
 * line bigger than ~256KB — measured on this transport: 254KB frames arrive,
 * materially larger ones never show up at all, with no error at either end. A
 * dropped frame costs a whole second of the dashboard, so every frame has to
 * stay well under that ceiling. */
const FRAME_MAX = 192 << 10;
/* Field names, commas and the shaping we can't predict exactly. */
const FRAME_SLACK = 4 << 10;

/* ── message bodies, out of band ───────────────────────────────────────────
 * Bodies used to ride inside the snapshot, which meant every body captured in a
 * second had to fit under FRAME_MAX alongside the endpoint table. Under load
 * that budget ran out and bodies were simply withheld — the thing you opened a
 * request to read was the first thing to go.
 *
 * They now travel as their own console lines. The ~256KB ceiling is per *line*,
 * not per second, so a body is bounded by what one line holds rather than by
 * what the rest of the dashboard left over; the server reassembles the parts
 * into a store keyed by exchange id, and the browser fetches one on demand
 * (GET /api/body/:id) when a row is opened. That the browser can ask for a body
 * at all is the point: the path *into* the isolate is still one-way, but the
 * path from the browser to the server never was.
 *
 * The encoding is picked per body, because neither choice wins outright. As a
 * JSON string a printable ASCII byte costs 1 byte on the wire, a control byte
 * costs 6 (`\uXXXX`), and a byte over 0x7f costs 2 (UTF-8) — so text is cheap
 * and a gzipped body runs to ~2.1 bytes per byte. Base64 is a flat 1.33
 * regardless. Measured on random bytes that's 1.6x more body per line for
 * binary; on ASCII it would be a 33% *loss*, so text goes as-is. Either way the
 * bytes survive the round trip exactly — a latin1 string's code units are its
 * bytes, which is the same trick the capture has always used. */
const PART_RAW_MAX = 65535;   /* raw bytes per part line; a multiple of 3, so every
                                 base64 part is independently decodable */
const PART_BUDGET = 2 << 20;  /* part bytes emitted per tick, max */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Base64 of `s[from,to)` read as bytes (it's a byte-exact latin1 string, so a
 * code unit IS a byte). Hand-rolled: there's no btoa or Buffer in the isolate. */
function b64(s, from, to) {
  let out = "";
  let i = from;
  for (; i + 2 < to; i += 3) {
    const n = (s.charCodeAt(i) & 255) << 16 | (s.charCodeAt(i + 1) & 255) << 8 | (s.charCodeAt(i + 2) & 255);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = to - i;
  if (rem === 1) {
    const n = (s.charCodeAt(i) & 255) << 16;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (s.charCodeAt(i) & 255) << 16 | (s.charCodeAt(i + 1) & 255) << 8;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

/* Is this body cheaper sent as text than as base64? Sampled from the head of the
 * body, the same way the browser decides whether to hexdump it — a body is
 * overwhelmingly all one thing or all the other. */
function isTextish(s) {
  const n = Math.min(s.length, 512);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c > 126) odd++;
  }
  return n === 0 || odd / n <= 0.05;
}

/* Roughly what one exchange costs as part lines. Both directions count together
 * so an exchange is sent or skipped whole — half of one is more confusing than
 * none of it. Accurate rather than approximate because the encoding is chosen to
 * make it so: base64 is exactly 4 bytes per 3 and pure ASCII, and a body only
 * goes as text when it *is* ASCII, where a JSON string is one byte per byte. */
const bodyCost = (body) => (isTextish(body) ? body.length : Math.ceil(body.length / 3) * 4);
const partCost = (e) =>
  (e.head === undefined ? 0 : e.head.length + bodyCost(e.body) + 96) +
  (e.reqHead === undefined ? 0 : e.reqHead.length + bodyCost(e.reqBody) + 96);

/* One direction of one exchange, as the lines that carry it: a header line with
 * the head and what's known about the body, then the body itself in parts.
 * `off` is a *raw byte* offset in both encodings, so the server can check that
 * the parts it received are contiguous without knowing which one it's holding. */
function messageLines(out, id, k, head, body, more, clen) {
  const enc = isTextish(body) ? "raw" : "b64";
  out.push({ t: "part", id, k, head, enc, len: body.length, clen: clen ?? null, more: more ? 1 : 0 });
  for (let off = 0; off < body.length; off += PART_RAW_MAX) {
    const end = Math.min(body.length, off + PART_RAW_MAX);
    out.push({ t: "part", id, k, off, d: enc === "b64" ? b64(body, off, end) : body.slice(off, end) });
  }
}

/* Pick which drained exchanges get their bodies shipped this tick, and build the
 * lines for them. Failed exchanges claim the budget first (a 500's body is the
 * reason this data is captured at all), then the newest. What doesn't make the
 * cut keeps its row in the stream and is flagged, so the UI can say why opening
 * it shows nothing rather than implying the body was empty. */
function bodyLines(list, budget) {
  const send = new Set();
  let spent = 0;
  const claim = (want) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (send.has(i) || !want(e)) continue;
      if (e.head === undefined && e.reqHead === undefined) continue;
      const cost = partCost(e);
      if (spent + cost > budget) continue;
      spent += cost;
      send.add(i);
    }
  };
  claim((e) => e.code >= 400);
  claim(() => true);

  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.head === undefined && e.reqHead === undefined) continue;
    if (!send.has(i)) { e.nopv = 1; continue; }
    if (e.reqHead !== undefined) messageLines(lines, e.id, "req", e.reqHead, e.reqBody, e.reqMore, e.reqClen);
    if (e.head !== undefined) messageLines(lines, e.id, "res", e.head, e.body, e.more, e.clen);
  }
  return lines;
}

/* Shape the drained request/response pairs into at most `budget` serialized
 * bytes of snapshot, and report what didn't fit. A row is now only ~90 bytes —
 * the bodies left — but 600 of them is still 54KB, so the array is still
 * budgeted as a whole; the newest are kept, since this is a live tail. Each row
 * says what its exchange has waiting for it in the body store, so the UI knows
 * whether a row is worth opening before it asks. */
function shapeRecent(list, budget) {
  const bare = list.map((e) => {
    const r = { id: e.id, key: e.key, ts: e.ts, code: e.code, ms: e.ms };
    if (e.head !== undefined) { r.rs = e.body.length; if (e.more) r.rmore = 1; }
    if (e.reqHead !== undefined) { r.qs = e.reqBody.length; if (e.reqMore) r.qmore = 1; }
    if (e.nopv) r.nopv = 1; // body withheld — over budget, not "empty body"
    return r;
  });
  const rowCost = bare.map((r) => JSON.stringify(r).length + 1); // + the comma

  let left = budget;
  let first = list.length; // index of the oldest row we can afford to keep
  while (first > 0 && rowCost[first - 1] <= left) {
    left -= rowCost[first - 1];
    first--;
  }
  return { rows: bare.slice(first), dropped: first };
}

/* Shape one aggregated endpoint row into a plain, JSON-safe record. The browser
 * renders entirely from these fields — it never sees a signal or a BigInt. */
function shapeRow(row) {
  const lat = row.lat;
  return {
    key: keyOf(row),
    method: row.method,
    host: row.host,
    path: row.path,
    count: row.count,
    rate: row.rate,
    peak: row.peak,
    bytes: row.bytes,
    first: row.first,
    last: row.last,
    lastMs: row.lastMs == null ? null : r2(row.lastMs),
    // Precomputed percentiles so the browser needn't hold every sample.
    latN: lat.length,
    p50: lat.length ? r2(percentile(lat, 50)) : null,
    p95: lat.length ? r2(percentile(lat, 95)) : null,
    latMax: lat.length ? r2(Math.max(...lat)) : null,
    status: { ...row.status },
    hist: row.hist.slice(-60), // req/s, last ~minute (for the sparkline)
    latTail: lat.slice(-LAT_TAIL).map(r2), // recent response latencies (ms)
  };
}

/* One tick's output: the body part lines to send first, then the snapshot frame.
 *
 * Order matters. The parts go out ahead of the snapshot that references them, so
 * that by the time a row reaches the browser, the body it points at is already
 * in the server's store — a row is never briefly un-openable.
 *
 * The frame itself is built in two passes: everything except the request stream,
 * measured, and then the stream gets whatever room is left under FRAME_MAX. The
 * endpoint table is the part that can't be trimmed without losing the dashboard
 * itself, so it's the stream that yields — and if the table alone is already too
 * big to send, say so on stderr instead of letting the frame disappear silently. */
function tickOutput() {
  const drained = drainRecent();
  const parts = bodyLines(drained, PART_BUDGET);

  const frame = baseSnapshot();
  const room = FRAME_MAX - JSON.stringify(frame).length - FRAME_SLACK;
  if (room < 0) {
    console.error(`[export] frame too large before the request stream (${frame.endpoints.length} endpoints) — ` +
      "the console portal drops lines over ~256KB, so this snapshot may not arrive");
  }
  const { rows: recent, dropped } = shapeRecent(drained, Math.max(0, room));
  frame.recent = recent;
  // Say so rather than letting rows vanish quietly — the UI shows the count.
  if (dropped) frame.recentDropped = dropped;
  return { parts, frame };
}

function baseSnapshot() {
  return {
    t: "snapshot",
    ts: Date.now(),
    iface: ifaceLabel,
    ifaces: { watching: ifaceLabel, available: availIfaces },
    // Which directions this run is capturing, so the UI's picker reflects
    // what's actually happening rather than what was last clicked.
    bodies: bodyMode,
    // Alert destinations this host can reach (see pollCaps).
    caps,
    totals: {
      reqs: totals.reqs,
      bytes: totals.bytes,
      uptimeMs: Date.now() - totals.startMs,
      endpoints: endpointCount(),
    },
    endpoints: rows.get().map(shapeRow),
    // Individual request/response pairs completed since the last emit, newest
    // last — the browser accumulates these into a per-route streaming log. The
    // rows carry only what the list needs; the heads and bodies went out ahead
    // of this frame as `part` lines and are fetched by id when a row is opened.
    // Filled in by tickOutput(), which measures the rest of the frame first to
    // know how much room they get.
    recent: [],
  };
}

/* One line of JSON per message — the node portal client splits console output on
 * newlines, so each line is exactly one parseable message. A tick is now the
 * body parts followed by the snapshot that references them. */
function emit() {
  try {
    const { parts, frame } = tickOutput();
    for (const p of parts) console.log(JSON.stringify(p));
    console.log(JSON.stringify(frame));
  } catch (err) {
    console.error(`[export] snapshot failed: ${err.message}`);
  }
}

// A "hello" line lets the server log that the exporter is live and confirms the
// portal is wired before the first data tick.
console.log(JSON.stringify({ t: "hello", iface: ifaceLabel, bodies: bodyMode, emitMs: EMIT_MS, ts: Date.now() }));

emit(); // first frame immediately, so a freshly-connected browser isn't blank
setInterval(emit, EMIT_MS);

// Keep the isolate alive; the ingest subscription + timers in httptop.js do the
// work, and this entry just samples them on a timer.
await new Promise(() => {});
