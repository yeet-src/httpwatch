// Shared BPF object. The single src/bpf/httptop.bpf.c unit is compiled and
// linked into bin/probe.bpf.o and loaded once here; the feature probe
// (httptop.js) imports this `control` and reads the `events` ring buffer.
// All binds + attaches happen before the single start(), so they live here.
//
// httptop attaches at the TC layer (TCX, ingress + egress) on every up
// interface. The TCX wildcard skips loopback, so we enumerate explicitly
// (incl. `lo`, where most local HTTP lives); `--iface a,b` narrows to named
// interfaces. This module imports only yeet:bpf — no `@/` aliases — so it
// stays runnable on its own for the import.meta.main self-test below.
import { BpfObject, DataSec, RingBuf } from "yeet:bpf";

/* --bodies=none|response|both — how much of each message the kernel captures.
 * Response bodies are on by default; request bodies are opt-in because that's
 * where credentials and PII live. Anything unrecognized falls back to the
 * default rather than failing the run.
 *
 * `cap` is the first segment of a message, `extra` the continuation budget after
 * it, `extraErr` the (much larger) continuation budget for a 4xx/5xx — an error's
 * body is the reason any of this is captured. The kernel shrinks these to the
 * real Content-Length when the sender gave one, so a big ceiling only costs
 * anything for a response that is genuinely big. */
const BODY_MODES = {
  none:     { reqCap: 512,   reqExtra: 0,     respCap: 128,   respExtra: 0,     respExtraErr: 0 },
  response: { reqCap: 512,   reqExtra: 0,     respCap: 16384, respExtra: 49152, respExtraErr: 262144 },
  both:     { reqCap: 16384, reqExtra: 49152, respCap: 16384, respExtra: 49152, respExtraErr: 262144 },
};
const wantedMode = String(yeet.args.bodies ?? "response").toLowerCase();
export const bodyMode = wantedMode in BODY_MODES ? wantedMode : "response";

/* Aggregate ceiling on body bytes crossing the ring buffer, in MB/s. The
 * per-message budgets above are generous; this is what keeps a busy host from
 * turning that into tens of MB/s of ringbuf traffic. Start lines and headers are
 * exempt in the kernel, so hitting this costs bodies and never the endpoint
 * table. `--body-rate 32` to raise it on a host you're deliberately hammering. */
const bodyRateMb = Math.max(1, Number(yeet.args.body_rate) || 8);

const wanted = yeet.args.iface
  ? new Set(String(yeet.args.iface).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

let ifaces = [];
try {
  const { data, errors } = await yeet.graph.query(
    `{ network_interfaces { index name is_up } }`,
  );
  if (errors) throw new Error(errors[0].message);
  ifaces = (data.network_interfaces || []).filter((i) => i.is_up && (!wanted || wanted.has(i.name)));
} catch (err) {
  console.error(`[httptop] could not list interfaces: ${err.message}`);
  yeet.exit();
}

const ifindexes = ifaces.map((i) => i.index);
if (ifindexes.length === 0) {
  console.error("[httptop] no matching up interfaces to watch");
  yeet.exit();
}

// What the status bar shows for the watched interfaces.
export const ifaceLabel = wanted ? ifaces.map((i) => i.name).join(",") : `all (${ifaces.length})`;

// `base: import.meta.dirname` resolves the object path against the running bundle.
const tcx = { kind: "tcx", ifindex: ifindexes };
const probe = new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname });

export const control = await (async () => {
  try {
    return await probe
      .bind("events", { kind: "ringbuf", btf_struct: "http_event" })
      .bind("probe.data", { kind: "data" })   // the capture-size knobs
      .attach("on_ingress", tcx)
      .attach("on_egress", tcx)
      .start();
  } catch (err) {
    console.error(`[httptop] failed to load eBPF: ${err.message}`);
    console.error("[httptop] need CAP_BPF/root and a compiled bin/probe.bpf.o (run `make`).");
    yeet.exit();
  }
})();

// Push the capture sizes for this mode into the program's .data. The programs
// attach during start(), so for a few milliseconds they run with their compiled
// defaults (response bodies on, request bodies off) — the ingest layer keys off
// `bodyMode`, not off what arrives, so nothing from that window is stored.
try {
  const m = BODY_MODES[bodyMode];
  new DataSec(control, "probe.data").patch({
    req_cap: m.reqCap, req_extra: m.reqExtra,
    resp_cap: m.respCap, resp_extra: m.respExtra, resp_extra_err: m.respExtraErr,
    rate_bytes: BigInt(bodyRateMb * 1024 * 1024), // 64-bit field: BigInt, not Number
  });
} catch (err) {
  console.error(`[httptop] could not set capture knobs (bodies=${bodyMode}): ${err.message}`);
}

// Standalone correctness probe — `yeet run src/probes/probe.js` dumps the
// endpoints it aggregates over a few seconds, so you can eyeball that the
// kernel filter, the btf_struct envelope, and the loopback dedup all behave
// before any UI exists. Dormant once httptop.js imports `control`.
if (import.meta.main) {
  const REQ = /^([A-Z]+) +(\S+) +HTTP\/\d\.\d$/;
  const parse = (bytes) => {
    let t = "";
    for (let i = 0; i < bytes.length; i++) { const c = bytes[i]; if (c === 0) break; t += String.fromCharCode(c); }
    const lines = t.split("\r\n\r\n")[0].split("\r\n");
    const m = REQ.exec(lines[0] || "");
    if (!m) return null;
    let host = "-";
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(":");
      if (c > 0 && lines[i].slice(0, c).toLowerCase() === "host") { host = lines[i].slice(c + 1).trim(); break; }
    }
    let path = m[2]; const q = path.indexOf("?"); if (q >= 0) path = path.slice(0, q);
    return { method: m[1], host, path };
  };

  const stats = new Map();
  const seen = new Set();
  let dupes = 0;
  await new RingBuf(control, "events").subscribe((raw) => {
    const ev = raw.http_event ?? raw;
    const k = `${ev.family}:${ev.sport}>${ev.dport}#${ev.seq}`;
    if (seen.has(k)) { dupes++; return; }
    seen.add(k);
    const d = ev.data instanceof Uint8Array ? ev.data : Uint8Array.from(Object.values(ev.data));
    const r = parse(d.subarray(0, Number(ev.captured)));
    if (!r) return;
    const key = `${r.method} ${r.host} ${r.path}`;
    stats.set(key, (stats.get(key) || 0) + 1);
  });

  await new Promise((r) => setTimeout(r, 4500));
  console.log(`[verify] watching ifindexes ${ifindexes.join(",")}`);
  console.log(`[verify] deduped ${dupes} loopback double-sightings`);
  console.log("[verify] aggregated endpoints (count desc):");
  [...stats.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}  ${k}`));
  await control.stop();
  yeet.exit();
}
