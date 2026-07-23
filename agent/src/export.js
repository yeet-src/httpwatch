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
//
// The `@/` alias resolves at bundle time (esbuild + tsconfig paths), exactly
// as it does for the TUI entry, so this module reuses the ingest code with no
// forked logic.
import { ifaceLabel } from "@/probes/probe.js";
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

/* Per-endpoint latency samples kept in httptop (LAT_LEN=200). We ship only the
 * recent tail for the detail sparkline — enough to draw, small on the wire. */
const LAT_TAIL = 60;

/* Round to keep the JSON compact; sub-0.01ms precision is noise here. */
const r2 = (n) => Math.round(n * 100) / 100;

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

/* One full snapshot of the dashboard state. `rows` is already sorted by count
 * (busiest first), the same order the TUI list shows. */
function snapshot() {
  return {
    t: "snapshot",
    ts: Date.now(),
    iface: ifaceLabel,
    ifaces: { watching: ifaceLabel, available: availIfaces },
    totals: {
      reqs: totals.reqs,
      bytes: totals.bytes,
      uptimeMs: Date.now() - totals.startMs,
      endpoints: endpointCount(),
    },
    endpoints: rows.get().map(shapeRow),
    // Individual request/response pairs completed since the last emit, newest
    // last — the browser accumulates these into a per-route streaming log.
    recent: drainRecent(),
  };
}

/* One line of JSON per emit — the node portal client splits console output on
 * newlines, so a single-line frame is exactly one parseable message. */
function emit() {
  try {
    console.log(JSON.stringify(snapshot()));
  } catch (err) {
    console.error(`[export] snapshot failed: ${err.message}`);
  }
}

// A "hello" line lets the server log that the exporter is live and confirms the
// portal is wired before the first data tick.
console.log(JSON.stringify({ t: "hello", iface: ifaceLabel, emitMs: EMIT_MS, ts: Date.now() }));

emit(); // first frame immediately, so a freshly-connected browser isn't blank
setInterval(emit, EMIT_MS);

// Keep the isolate alive; the ingest subscription + timers in httptop.js do the
// work, and this entry just samples them on a timer.
await new Promise(() => {});
