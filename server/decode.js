// Making a captured message readable.
//
// A body arrives as the bytes that were on the wire: possibly chunk-framed,
// possibly compressed, and possibly cut off mid-stream because the capture hit
// its budget. Turning that back into text is the same job whether it's going
// into a Slack alert or a markdown page, so it lives here rather than in either.
//
// The browser has its own copy of this logic (public/app.js) and has to: it
// decodes in the page using DecompressionStream, with no zlib and no Buffer.
// These two are expected to agree, and the shapes they produce deliberately
// match — same notes, same truncation marker.

import { constants as zlibConstants, gunzipSync, inflateSync } from "node:zlib";

/** One header off a captured head block, lowercased-name match, "" if absent. */
export function headerOf(head, name) {
  const lines = String(head ?? "").split("\r\n");
  // From 1: line 0 is the request/status line, not a header.
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(":");
    if (c > 0 && lines[i].slice(0, c).trim().toLowerCase() === name) return lines[i].slice(c + 1).trim();
  }
  return "";
}

/** Strip chunked framing, tolerating a stream cut short mid-chunk. */
export function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i, "latin1");
    if (nl < 0) break;
    const size = parseInt(buf.toString("latin1", i, nl).split(";")[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = nl + 2;
    out.push(buf.subarray(start, Math.min(buf.length, start + size)));
    i = start + size + 2;
  }
  return out.length ? Buffer.concat(out) : buf;
}

/** One direction of a body-store entry as `{head, buf, more}`, or null. The
 *  store holds bodies in whichever encoding the exporter picked; latin1 is how a
 *  byte-exact string round-trips, which is the same trick the capture uses. */
export function captured(m) {
  if (!m) return null;
  return {
    head: m.head || "",
    buf: m.enc === "b64" ? Buffer.from(m.d || "", "base64") : Buffer.from(m.d || "", "latin1"),
    more: !!(m.more || m.gap),
  };
}

/**
 * Decode one captured direction into text plus a note about what's off about it.
 *
 * `note` is not an error: "the body is gzip and we couldn't inflate it" and "the
 * capture cut this short" are both things a reader needs told, and neither means
 * the decode failed. Callers show it beside the text.
 *
 * Z_SYNC_FLUSH is what lets a truncated gzip still yield its readable prefix
 * instead of throwing — exactly the case that matters for a 500 whose body ran
 * past the capture budget.
 */
export function decodeCaptured(entry, { max = 0 } = {}) {
  if (!entry?.buf?.length) return { text: "", note: "no body bytes were captured", truncated: false };
  let buf = entry.buf;

  if (/chunked/i.test(headerOf(entry.head, "transfer-encoding"))) buf = dechunk(buf);
  const enc = headerOf(entry.head, "content-encoding").toLowerCase();
  if (enc === "gzip" || enc === "deflate") {
    try {
      const opts = { finishFlush: zlibConstants.Z_SYNC_FLUSH };
      buf = enc === "gzip" ? gunzipSync(buf, opts) : inflateSync(buf, opts);
    } catch {
      return { text: "", note: `body is ${enc}-encoded and could not be decompressed`, truncated: false };
    }
  }

  let text = buf.toString("utf8");
  let truncated = false;
  if (max > 0 && text.length > max) {
    text = `${text.slice(0, max)}\n…truncated`;
    truncated = true;
  }
  return { text, note: entry.more ? "body was truncated by the capture" : "", truncated };
}
