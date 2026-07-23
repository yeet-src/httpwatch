// The captured-body store.
//
// The exporter can't answer a question — the console portal is one-way into this
// process — so it pushes every head and body it captured as `part` lines ahead
// of the snapshot that references them. This module is where those land: a
// bounded, id-keyed cache that the browser reads from with GET /api/body/:id
// when someone opens a request. That turns "the body had to fit in this second's
// snapshot" into "the body had to fit in the store", which is a budget measured
// in tens of megabytes instead of tens of kilobytes.
//
// Bodies pass through in whatever encoding the exporter chose for them — `raw`
// (a byte-exact latin1 string, cheapest for text) or `b64` (cheapest for
// anything compressed) — and are handed to the browser the same way. There is no
// reason to pay for a decode here and an encode back, so parts are just
// concatenated as text. For base64 that is only valid because every part but the
// last carries a multiple of 3 raw bytes, which is why PART_RAW_MAX over there is
// 65535 and not 65536.
//
// Ids are monotonic within one exporter run and restart at 1 with the probe, so
// reset() must be called whenever the probe is restarted or a new run's ids would
// collide with the old run's bodies.

/**
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]      total base64 held, before evicting
 * @param {number} [opts.maxExchanges]  exchanges held, before evicting
 */
export function createBodyStore({ maxBytes = 64 << 20, maxExchanges = 4000 } = {}) {
  /** id -> { at, bytes, req, res } — insertion-ordered, which is also age order
   *  (ids are monotonic), so eviction is just "drop from the front". */
  const store = new Map();
  let bytes = 0;
  let dropped = 0; // exchanges evicted since the last reset, for /healthz

  const blank = () => ({ head: "", enc: "raw", d: "", len: 0, clen: null, more: false, gap: false, at: 0 });

  /** Raw bytes a held part-string stands for. Base64 is 3 bytes per 4 chars less
   *  whatever the padding stands in for; a raw part is its own length. */
  const rawLen = (m) => {
    if (m.enc !== "b64") return m.d.length;
    if (!m.d.length) return 0;
    return (m.d.length / 4) * 3 - (m.d.endsWith("==") ? 2 : m.d.endsWith("=") ? 1 : 0);
  };

  function evict() {
    while (store.size > maxExchanges || bytes > maxBytes) {
      const first = store.keys().next();
      if (first.done) break;
      const e = store.get(first.value);
      bytes -= e.bytes;
      store.delete(first.value);
      dropped++;
    }
  }

  return {
    /** Fold one `part` line into the store. Head lines open a direction; body
     *  lines append to it, in order. */
    part(msg) {
      const id = Number(msg.id);
      if (!Number.isFinite(id)) return;
      const k = msg.k === "req" ? "req" : "res";

      let ex = store.get(id);
      if (!ex) {
        ex = { at: Date.now(), bytes: 0, req: null, res: null };
        store.set(id, ex);
      }

      if (typeof msg.head === "string") {
        // A head line starts (or restarts) this direction.
        const m = blank();
        m.head = msg.head;
        m.enc = msg.enc === "b64" ? "b64" : "raw";
        m.len = Number(msg.len) || 0;
        m.clen = msg.clen == null ? null : Number(msg.clen);
        m.more = !!msg.more;
        m.at = Date.now();
        if (ex[k]) {
          const held = ex[k].head.length + ex[k].d.length;
          ex.bytes -= held;
          bytes -= held;
        }
        ex[k] = m;
        ex.bytes += m.head.length;
        bytes += m.head.length;
        evict();
        return;
      }

      if (typeof msg.d !== "string") return;
      const m = ex[k];
      if (!m || m.gap) return; // no head for this direction, or already broken
      // Parts are emitted in order; a mismatch means one went missing, and
      // concatenating across the hole would silently corrupt the body.
      if (Number(msg.off) !== rawLen(m)) { m.gap = true; m.more = true; return; }
      m.d += msg.d;
      ex.bytes += msg.d.length;
      bytes += msg.d.length;
      evict();
    },

    /** One exchange's captured directions, or null if it isn't (or is no longer)
     *  held. Shape is what the browser's viewer wants, base64 and all. */
    get(id) {
      const ex = store.get(Number(id));
      if (!ex) return null;
      const shape = (m) => m && {
        head: m.head,
        enc: m.enc,
        d: m.d,
        // What the sender said the body was, vs what we actually hold. The
        // viewer shows the difference rather than implying the message ended.
        clen: m.clen,
        bytes: rawLen(m),
        more: m.more,
        gap: m.gap,
      };
      return { id: Number(id), req: shape(ex.req), res: shape(ex.res) };
    },

    /** Drop everything. Ids restart with the probe, so this is mandatory on any
     *  restart — otherwise a new exchange 7 would serve the old run's body. */
    reset() {
      store.clear();
      bytes = 0;
      dropped = 0;
    },

    stats() {
      return { exchanges: store.size, bytes, dropped };
    },
  };
}
