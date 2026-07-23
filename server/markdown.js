// The markdown face of the dashboard: the same data the browser gets, rendered
// for something that reads text instead of running JavaScript — curl, a script,
// an agent poking at the host.
//
// Why this exists at all: the HTML page is a shell that hydrates from an inlined
// snapshot and then streams SSE updates, so `curl /` hands back markup and a
// bootstrap blob. Anything that can't run the page sees nothing useful, which
// makes the most convenient way to inspect a host — ask it over HTTP — the one
// way that doesn't work.
//
// Three depths, each a URL a reader can construct from the one above it:
//
//   /                     overview: probe state, totals, the endpoint table
//   /detail?endpoint=…    one endpoint: percentiles, status codes, exchanges
//   /api/body/<id>        one exchange: decoded head and body
//
// Every page ends with the links out of it, because discovery is the whole point:
// a reader that lands on the overview must be able to reach a response body
// without being told how by a human. Links are root-relative and carry
// `format=md` explicitly, so following one keeps you in markdown even from a
// client whose Accept header would have got HTML.

import { captured, decodeCaptured, headerOf } from "./decode.js";

/* Table rows are capped so a curl of a busy host stays readable — a caller who
 * wants everything says so with ?limit=. */
const ENDPOINTS_DEFAULT = 40;
const ENDPOINTS_MAX = 500;
const EXCHANGES_DEFAULT = 40;
const EXCHANGES_MAX = 500;
/* Characters of a decoded body per direction. Generous next to the 1200 an alert
 * carries: a reader that asked for one exchange's body wants the body. */
const BODY_DEFAULT = 4000;
const BODY_MAX = 200_000;

/**
 * Should this request be answered in markdown?
 *
 * `?format=` is explicit and wins both ways, which is what makes the two views
 * testable from anything: a browser can ask for markdown, curl can ask for HTML.
 *
 * Otherwise it's the Accept header, and the rule is deliberately about HTML
 * rather than about clients: something that lists `text/html` among what it
 * wants is a browser and gets the app. A wildcard Accept (curl, fetch, wget, most
 * agents) and a missing Accept both mean "whatever you've got", and for those
 * markdown is the more useful answer. No User-Agent sniffing — a list of bot
 * names would be wrong the day something new shows up.
 *
 * Note this is the rule for the *page* routes. `/api/*` keeps serving JSON unless
 * the URL asks for markdown outright: its callers use `fetch()`, which sends a
 * wildcard Accept, so negotiating there would break them. See index.js.
 */
export function wantsMarkdown(req, params) {
  const fmt = String(params?.get("format") || "").toLowerCase();
  if (/^(md|markdown|text|txt|plain)$/.test(fmt)) return true;
  if (/^(html|web|app|browser)$/.test(fmt)) return false;

  const accept = String(req.headers.accept || "").trim();
  if (!accept) return true;
  if (/text\/markdown/i.test(accept)) return true;
  if (/\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(accept)) return false;
  /* Everything else, `Accept: application/json` included, gets markdown. That
   * looks wrong for a moment and isn't: these page routes have no JSON
   * representation to offer, so the choice is between HTML a JSON client can't
   * use and a text page whose "Digging in" table names every JSON route this
   * server does have. The second is the useful answer.
   *
   * What must not get markdown is the JSON *API*, whose callers really do send a
   * wildcard Accept — and that's enforced at the route in index.js, not here, so
   * this rule can stay about pages. */
  return true;
}

// ── formatting ──────────────────────────────────────────────────────────────
const n0 = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—");
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");
const n2 = (v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "—");

function bytes(v) {
  if (!Number.isFinite(v)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  // One decimal above bytes: "42 MB" and "42.1 MB" are a different amount of
  // information when you're comparing two endpoints.
  return `${i === 0 ? x : x.toFixed(1)} ${u[i]}`;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(s / 86400), "d"],
    [Math.floor((s % 86400) / 3600), "h"],
    [Math.floor((s % 3600) / 60), "m"],
    [s % 60, "s"],
  ].filter(([v], i) => v > 0 || i === 3);
  return parts.map(([v, u]) => `${v}${u}`).join(" ");
}

/** "2.4s ago" — relative to now, which is what a reader actually wants to know
 *  about a timestamp in a live capture. Absolute time comes along beside it. */
function ago(ts, now) {
  if (!Number.isFinite(ts)) return "—";
  const d = now - ts;
  if (d < 1000) return "just now";
  if (d < 60_000) return `${(d / 1000).toFixed(1)}s ago`;
  return `${duration(d)} ago`;
}

const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : "—");
/** ISO time-of-day, which is the resolution a stream of exchanges needs. */
const clock = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().slice(11, 23) : "—");

/** Text inside a markdown table cell: `|` would end the cell, and a newline
 *  would end the row. Both are possible in a captured path or header. */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
/** A key/path as inline code in a cell — backticks in the value would close it. */
const code = (s) => `\`${String(s ?? "").replace(/`/g, "ʼ")}\``;

/** A fenced block whose fence can't be closed early by its own content. */
function fence(text, lang = "") {
  const body = String(text ?? "");
  // Longest run of backticks in the body, so the fence is always longer.
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${body}${body.endsWith("\n") ? "" : "\n"}${f}`;
}

/** Guess a fence language from a content-type, for readers that highlight. */
function langOf(head) {
  const ct = headerOf(head, "content-type").toLowerCase();
  if (/json/.test(ct)) return "json";
  if (/html/.test(ct)) return "html";
  if (/xml/.test(ct)) return "xml";
  if (/javascript/.test(ct)) return "js";
  if (/css/.test(ct)) return "css";
  return "";
}

const table = (header, rows) => [
  `| ${header.map(([t]) => t).join(" | ")} |`,
  `| ${header.map(([, a]) => (a === "r" ? "--:" : a === "c" ? ":-:" : "---")).join(" | ")} |`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
].join("\n");

/** The status tally as one cell: `200 ×4102 · 500 ×18`, worst codes last so the
 *  interesting part is where the eye lands. */
function statusCell(status) {
  const entries = Object.entries(status || {})
    .map(([c, n]) => [Number(c), n])
    .sort((a, b) => a[0] - b[0]);
  if (!entries.length) return "—";
  return entries.map(([c, n]) => `${c} ×${n0(n)}`).join(" · ");
}

const mdLink = (label, href) => `[${label}](${href})`;
/** The detail URL for an endpoint key, in markdown, with format pinned. */
const detailUrl = (key) => `/detail?endpoint=${encodeURIComponent(key)}&format=md`;
const bodyUrl = (id) => `/api/body/${encodeURIComponent(id)}?format=md`;

// ── pages ───────────────────────────────────────────────────────────────────

/** Common preamble: what this is, and where the reader is. */
function head(title, ctx, extra = []) {
  const lines = [`# ${title}`, ""];
  if (extra.length) lines.push(...extra, "");
  return lines;
}

/** The gate, in the one form a non-browser reader can act on. Being logged out is
 *  a property of the *host*, not of the request, so there is no credential a
 *  caller could add — someone has to run `yeet login` on the box. Say exactly
 *  that instead of returning a bare 401. */
export function renderLoginRequired(ctx, { what = "This data" } = {}) {
  const st = ctx.auth || {};
  return [
    "# httpwatch — login required",
    "",
    `${what} is withheld until the host this runs on is signed in to yeet.`,
    "",
    "The probe needs a logged-in host to attach, so nothing is captured and nothing",
    "is served until then. This is not a per-request credential: there is no header",
    "or token you can add to this call.",
    "",
    "**To fix it, on the host:** `yeet login`",
    "",
    st.loginPending ? "A login is currently in progress (a browser flow was started on the host)." : null,
    st.error ? `Last login error: \`${st.error}\`` : null,
    "",
    "## Also available without logging in",
    "",
    table([["URL", "l"], ["What", "l"]], [
      [code("/healthz"), "JSON liveness: probe state, whether any data exists, body-store size, login state"],
      [code("/api/auth"), "JSON login state"],
    ]),
    "",
    "Once the host is signed in, start at `/?format=md`.",
  ].filter((l) => l !== null).join("\n");
}

/** Nothing captured yet — a real state on a quiet host, and distinct from an
 *  error. A reader that can't tell those apart will report the wrong thing. */
function renderNoData(ctx) {
  const st = ctx.status || {};
  return [
    "# httpwatch — no data yet",
    "",
    `Probe state: **${st.state || "unknown"}**${st.error ? ` (\`${st.error}\`)` : ""}.`,
    "",
    st.state === "running" || st.state === "ready"
      ? "The probe is attached but hasn't reported a snapshot yet, or nothing has crossed the watched interface. Snapshots arrive once per second."
      : "The probe isn't running, so there's nothing to report. `/healthz` has the machine-readable version of this.",
    "",
    `Watching interface: ${code(ctx.iface || "all")}. Capturing: **${ctx.bodyMode}** bodies.`,
    "",
    "Retry `/?format=md` in a second or two.",
  ].join("\n");
}

/**
 * The overview: what the top bar, the endpoint table and the footer say, plus the
 * links to go deeper. This is the page a reader lands on with no prior knowledge,
 * so it carries the URL grammar for everything else.
 */
export function renderOverview(ctx, params) {
  const snap = ctx.snapshot;
  if (!snap) return renderNoData(ctx);
  const now = Date.now();
  const t = snap.totals || {};

  const limit = clampInt(params.get("limit"), ENDPOINTS_DEFAULT, 1, ENDPOINTS_MAX);
  const sort = String(params.get("sort") || "count").toLowerCase();
  const eps = sortEndpoints(snap.endpoints || [], sort);
  const shown = eps.slice(0, limit);

  const out = head("httpwatch", ctx, [
    "Live HTTP request/response capture on this host, read off the wire by an eBPF probe.",
    "This is the markdown view of the dashboard — the same data the browser gets.",
  ]);

  out.push("## Now", "");
  out.push(...[
    `- **Probe:** ${ctx.status?.state || "unknown"}${ctx.status?.error ? ` — \`${ctx.status.error}\`` : ""}`,
    `- **Watching:** ${code(snap.ifaces?.watching || ctx.iface || "all")}${
      snap.ifaces?.available?.length ? ` (available: ${snap.ifaces.available.map(code).join(", ")})` : ""}`,
    `- **Capturing:** ${snap.bodies || ctx.bodyMode} bodies`,
    `- **Up:** ${duration(t.uptimeMs)}`,
    `- **Requests:** ${n0(t.reqs)} across ${n0(t.endpoints)} endpoints`,
    `- **On the wire:** ${bytes(t.bytes)}`,
    `- **Snapshot:** ${ago(snap.ts, now)} (${iso(snap.ts)}), refreshed once per second`,
    `- **Slack:** ${ctx.caps?.slack === true ? "connected" : ctx.caps?.slack === false ? "not connected" : "unknown"}`,
    snap.recentDropped ? `- **Note:** ${n0(snap.recentDropped)} request rows were dropped from the last snapshot (frame size limit)` : null,
  ].filter(Boolean));
  out.push("");

  out.push("## Endpoints", "");
  if (!eps.length) {
    out.push("Nothing seen yet on the watched interface.", "");
  } else {
    out.push(
      `${n0(eps.length)} endpoint${eps.length === 1 ? "" : "s"}, ${sortLabel(sort)}` +
      `${eps.length > shown.length ? `, showing the first ${shown.length}` : ""}.`,
      "",
      table(
        [["#", "r"], ["Endpoint", "l"], ["Reqs", "r"], ["req/s", "r"], ["p50 ms", "r"], ["p95 ms", "r"],
         ["Bytes", "r"], ["Status", "l"], ["Last", "r"], ["Detail", "l"]],
        shown.map((e, i) => [
          String(i + 1),
          code(cell(e.key)),
          n0(e.count),
          n1(e.rate),
          n2(e.p50),
          n2(e.p95),
          bytes(e.bytes),
          cell(statusCell(e.status)),
          ago(e.last, now),
          mdLink("open", detailUrl(e.key)),
        ]),
      ),
      "",
    );
    if (eps.length > shown.length) {
      out.push(`${n0(eps.length - shown.length)} more — add \`&limit=${Math.min(ENDPOINTS_MAX, eps.length)}\` (max ${ENDPOINTS_MAX}).`, "");
    }
  }

  const errors = eps.filter((e) => Object.keys(e.status || {}).some((c) => Number(c) >= 400));
  if (errors.length) {
    out.push("### Endpoints returning 4xx/5xx", "");
    out.push(table([["Endpoint", "l"], ["Failing", "l"], ["Detail", "l"]],
      errors.slice(0, limit).map((e) => [
        code(cell(e.key)),
        cell(Object.entries(e.status).filter(([c]) => Number(c) >= 400)
          .sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ×${n0(n)}`).join(" · ")),
        mdLink("open", detailUrl(e.key)),
      ])), "");
  }

  out.push(...alertsSection(ctx));
  out.push(...howToDigIn(ctx, { here: "/?format=md" }));
  return out.join("\n");
}

/** One endpoint, as deep as the server can go without being asked for a body. */
export function renderDetail(ctx, params) {
  const key = String(params.get("endpoint") || "").trim();
  const snap = ctx.snapshot;
  if (!key) {
    return [
      "# httpwatch — detail needs an endpoint",
      "",
      "Pass the endpoint key, exactly as the overview reports it, URL-encoded:",
      "",
      fence("/detail?endpoint=GET%20shop.internal%20%2Fapi%2Forders&format=md"),
      "",
      `The key is \`METHOD host path\` — three parts, single-spaced. ${mdLink("The overview", "/?format=md")} lists them all, each with its detail link.`,
    ].join("\n");
  }
  if (!snap) return renderNoData(ctx);

  const ep = (snap.endpoints || []).find((e) => e.key === key);
  const now = Date.now();
  if (!ep) {
    // A key that isn't in this snapshot is usually a typo or a stale link, but a
    // probe restart also clears the table — so offer near matches rather than a
    // flat "not found", which a reader can't act on.
    // Match on the path segment: a wrong method or a wrong host is exactly the
    // mistake a reader makes, and the path is the part they got right.
    const parts = key.toLowerCase().split(" ");
    const needle = parts[parts.length - 1];
    const near = (snap.endpoints || [])
      .filter((e) => needle && e.key.toLowerCase().includes(needle))
      .slice(0, 10);
    return [
      `# httpwatch — no endpoint ${code(key)}`,
      "",
      "Nothing under that key in the current snapshot. Either it hasn't been seen since the probe last started, or the key is off — it must be `METHOD host path` exactly as reported, and it is case-sensitive.",
      "",
      near.length ? "Closest keys currently seen:" : `${mdLink("The overview", "/?format=md")} lists every key currently seen.`,
      near.length ? "" : null,
      ...(near.length ? near.map((e) => `- ${code(e.key)} — ${mdLink("detail", detailUrl(e.key))}`) : []),
    ].filter((l) => l !== null).join("\n");
  }

  const out = head(cell(key), ctx, [
    `${mdLink("← overview", "/?format=md")} · ${mdLink("this endpoint in the browser UI", `/detail?endpoint=${encodeURIComponent(key)}`)}`,
  ]);

  out.push("## Traffic", "");
  out.push(...[
    `- **Requests:** ${n0(ep.count)} (${n1(ep.rate)}/s now, peak ${n1(ep.peak)}/s)`,
    `- **On the wire:** ${bytes(ep.bytes)}`,
    `- **First seen:** ${iso(ep.first)} (${ago(ep.first, now)})`,
    `- **Last seen:** ${iso(ep.last)} (${ago(ep.last, now)})`,
    `- **Last response time:** ${ep.lastMs == null ? "—" : `${n2(ep.lastMs)} ms`}`,
    `- **Latency:** p50 ${n2(ep.p50)} ms · p95 ${n2(ep.p95)} ms · max ${n2(ep.latMax)} ms (${n0(ep.latN)} samples)`,
    `- **Method / host / path:** ${code(ep.method)} · ${code(ep.host)} · ${code(ep.path)}`,
  ]);
  out.push("");

  const codes = Object.entries(ep.status || {}).map(([c, n]) => [Number(c), n]).sort((a, b) => b[1] - a[1]);
  out.push("## Status codes", "");
  out.push(codes.length
    ? table([["Code", "l"], ["Count", "r"], ["Share", "r"]],
        codes.map(([c, n]) => [String(c), n0(n), `${((n / Math.max(1, ep.count)) * 100).toFixed(1)}%`]))
    : "No responses recorded yet (requests seen, nothing answered).");
  out.push("");

  // req/s over the last minute. A sparkline is a picture; the numbers are the
  // thing a reader can actually compute with, so they go out as numbers.
  if (ep.hist?.length) {
    out.push("## Requests per second, last minute", "", "Oldest first, one value per second:", "",
      fence(ep.hist.map((v) => n1(v)).join(" ")), "");
  }

  out.push(...exchangesSection(ctx, key, params, now));
  out.push(...alertsSection(ctx, key));
  out.push(...howToDigIn(ctx, { here: detailUrl(key), key }));
  return out.join("\n");
}

/** The exchange stream for one endpoint, out of the server's ring. */
function exchangesSection(ctx, key, params, now) {
  const limit = clampInt(params.get("rows"), EXCHANGES_DEFAULT, 1, EXCHANGES_MAX);
  const all = (ctx.recent || []).filter((r) => r.key === key);
  const rows = all.slice(-limit).reverse();   // newest first, which is how a log is read

  const out = ["## Recent exchanges", ""];
  if (!rows.length) {
    out.push(
      "None held. The server keeps a bounded tail of individual request/response pairs, " +
      "and this endpoint has nothing in it — it may have been quiet since the server started, " +
      "or busier endpoints may have pushed its rows out.",
      "");
    return out;
  }
  out.push(
    `${n0(all.length)} held for this endpoint, newest first${all.length > rows.length ? `, showing ${rows.length} — \`&rows=\` up to ${EXCHANGES_MAX}` : ""}.`,
    "",
    table([["Time (UTC)", "l"], ["Age", "r"], ["Code", "r"], ["ms", "r"], ["Exchange", "l"], ["Body", "l"]],
      rows.map((r) => {
        const held = ctx.store?.get?.(r.id);
        return [
          clock(r.ts),
          ago(r.ts, now),
          r.code == null ? "—" : String(r.code),
          r.ms == null ? "—" : n2(r.ms),
          code(r.id),
          held ? mdLink("fetch", bodyUrl(r.id)) : "not held",
        ];
      })),
    "",
    "`Body: not held` means the payload is no longer in the store (bounded, and it recycles) " +
    "or was never captured. The row itself is still real.",
    "");
  return out;
}

/** Alert rules — all of them, or the ones covering one endpoint. */
function alertsSection(ctx, key) {
  const rules = ctx.alerts || [];
  const mine = key ? rules.filter((r) => r.key === key || r.global) : rules;
  const out = [key ? "## Alert rules covering this endpoint" : "## Alert rules", ""];
  if (!mine.length) {
    out.push(key
      ? `None. ${mdLink("Every rule", "/?format=md")} is listed on the overview.`
      : "None configured.", "");
    return out;
  }
  out.push(table(
    [["Watching", "l"], ["Condition", "l"], ["Channel", "l"], ["Quiet period", "r"], ["Fired", "r"], ["Last fired", "l"], ["State", "l"]],
    mine.map((r) => [
      code(cell(r.scope)) + (r.global ? " (every endpoint)" : ""),
      cell(r.label),
      cell(r.channel),
      `${r.cooldownSec}s`,
      n0(r.firedCount),
      r.lastFiredAt ? iso(r.lastFiredAt) : "never",
      r.lastError ? `failing — ${cell(r.lastError)}` : "ok",
    ])), "");
  return out;
}

/** Where to go from here. Every page gets this: a reader that can't find the next
 *  URL is stuck, and it can't ask. */
function howToDigIn(ctx, { here, key }) {
  const example = key || (ctx.snapshot?.endpoints || [])[0]?.key || "GET shop.internal /api/orders";
  const out = ["## Digging in", "",
    `Everything here is a GET, and every URL takes \`format=md\` (or \`format=html\` for the app). ` +
    `Without \`format\`, anything that doesn't ask for \`text/html\` in \`Accept\` gets markdown, so plain \`curl\` works as-is.`,
    "",
    table([["URL", "l"], ["What it gives you", "l"]], [
      [code("/?format=md"), "this overview: probe state, totals, every endpoint with its detail link"],
      [code("/?format=md&limit=200&sort=p95"), `more rows, ordered differently — sort: ${["count", "rate", "p95", "p50", "bytes", "last", "errors"].map(code).join(", ")}`],
      [code(`/detail?endpoint=${encodeURIComponent(example)}&format=md`), "one endpoint: percentiles, status codes, req/s history, its exchange tail"],
      [code("/detail?endpoint=…&format=md&rows=200"), "a longer exchange tail for that endpoint"],
      [code("/api/body/<id>?format=md"), "one exchange's decoded head and body — the `Exchange` column has the ids"],
      [code("/api/body/<id>?format=md&dir=req&max=50000"), "just the request direction, with a bigger character budget"],
      [code("/healthz"), "JSON liveness, no login needed"],
      [code("/api/alerts"), "JSON alert rules (`POST`/`PATCH`/`DELETE` to change them)"],
      [code("/events"), "the live SSE stream of raw snapshots, one JSON object per second"],
    ]),
    "",
    "Endpoint keys are `METHOD host path`, single-spaced, and must be URL-encoded when passed as a query parameter (`%20` for the spaces).",
    "",
  ];
  if (ctx.base) out.push(`Absolute base for these paths: ${code(ctx.base)}.`, "");
  out.push(`This page: ${code(here)}.`);
  return out;
}

/**
 * One exchange's captured head and body, decoded.
 *
 * The deepest a reader can go, and the only page that can hand back something
 * genuinely large, so the character budget is explicit and its truncation is
 * always stated — a body that quietly stopped mid-JSON would be read as a
 * malformed payload rather than a clipped one.
 */
export function renderBody(ctx, id, params) {
  const ex = /^\d+$/.test(String(id)) ? ctx.store?.get?.(id) : null;
  if (!ex) {
    return [
      `# Exchange ${code(id)} — not held`,
      "",
      "No captured message under that id. All of these produce it, and they're not distinguishable from here:",
      "",
      "- the body store recycled it (it's bounded — see `/healthz` for its size)",
      "- capture is off for that direction (`response` by default; request bodies are opt-in)",
      "- the payload was over the per-tick budget and was dropped",
      "- the probe restarted, which resets ids to 1 — a stale id may now be a different exchange",
      "",
      `${mdLink("Overview", "/?format=md")} · exchange ids come from an endpoint's detail page.`,
    ].join("\n");
  }

  const dir = String(params.get("dir") || "both").toLowerCase();
  const max = clampInt(params.get("max"), BODY_DEFAULT, 1, BODY_MAX);
  const want = dir === "req" || dir === "request" ? ["req"]
    : dir === "res" || dir === "response" ? ["res"]
    : ["req", "res"];

  const out = [`# Exchange ${id}`, "",
    `${mdLink("← overview", "/?format=md")} · ${dir === "both" ? "request and response" : dir} · up to ${n0(max)} characters per direction (\`&max=\`)`,
    ""];

  for (const which of want) {
    const label = which === "req" ? "Request" : "Response";
    const entry = captured(ex[which]);
    out.push(`## ${label}`, "");
    if (!entry) {
      out.push(which === "req"
        ? "Not captured. Request bodies are opt-in (`BODIES=both`, or the dashboard's `bodies:` picker) because that's where credentials live."
        : "Not captured for this exchange.", "");
      continue;
    }

    if (entry.head) {
      out.push("### Head", "", fence(entry.head.replace(/\r\n/g, "\n"), "http"), "");
    }
    const { text, note, truncated } = decodeCaptured(entry, { max });
    const raw = ex[which];
    out.push(...[
      `- **Bytes held:** ${bytes(raw.bytes)}${raw.clen != null ? ` of ${bytes(Number(raw.clen))} declared` : ""}`,
      raw.gap ? "- **Gap:** part of this body went missing in transit — what's below runs up to the gap" : null,
      raw.more ? "- **Truncated by the capture:** the message continued past what was kept" : null,
      note ? `- **Note:** ${note}` : null,
      truncated ? `- **Clipped for this page** at ${n0(max)} characters — raise \`&max=\` (up to ${n0(BODY_MAX)}) for more` : null,
    ].filter(Boolean));
    out.push("");
    out.push("### Body", "");
    out.push(text ? fence(text, langOf(entry.head)) : "_empty_", "");
  }

  out.push("## Digging in", "",
    `- ${code(`/api/body/${id}?format=md&dir=res&max=50000`)} — one direction, more of it`,
    `- ${code(`/api/body/${id}`)} — the same exchange as JSON (base64 payloads, exactly as captured)`,
    `- ${mdLink("Overview", "/?format=md")} — back to the endpoint table`);
  return out.join("\n");
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clampInt(raw, dflt, lo, hi) {
  // An absent or empty parameter is not zero. `Number(null)` is 0 and
  // `Number("")` is 0, both of which would silently clamp to `lo` and make every
  // table one row long — so check for a value before trusting the conversion.
  if (raw === null || raw === undefined || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function errorsOf(e) {
  let n = 0;
  for (const [c, v] of Object.entries(e.status || {})) if (Number(c) >= 400) n += v;
  return n;
}

const SORTS = {
  count: (a, b) => b.count - a.count,
  rate: (a, b) => b.rate - a.rate,
  p95: (a, b) => (b.p95 ?? -1) - (a.p95 ?? -1),
  p50: (a, b) => (b.p50 ?? -1) - (a.p50 ?? -1),
  bytes: (a, b) => b.bytes - a.bytes,
  last: (a, b) => b.last - a.last,
  errors: (a, b) => errorsOf(b) - errorsOf(a),
};

function sortEndpoints(eps, sort) {
  const cmp = SORTS[sort] || SORTS.count;
  return [...eps].sort(cmp);
}

function sortLabel(sort) {
  return {
    count: "busiest first",
    rate: "highest current req/s first",
    p95: "slowest p95 first",
    p50: "slowest p50 first",
    bytes: "most bytes first",
    last: "most recently seen first",
    errors: "most 4xx/5xx first",
  }[sort] || "busiest first";
}
