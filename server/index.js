// httpwatch server.
//
// Runs the httpinspect exporter isolate (via portal.js), holds the latest JSON
// snapshot in memory, and serves:
//   GET /            the dashboard HTML, with the latest snapshot inlined as
//                    window.__INITIAL__ so the page hydrates immediately
//   GET /events      Server-Sent Events — one `snapshot` event per exporter tick
//   POST /api/iface  change the watched interfaces (restarts the probe)
//   POST /api/bodies change which message bodies are captured (restarts it too)
//   GET  /api/body/<id>  one exchange's captured head + body, base64 (see bodies.js)
//   /api/alerts      GET/POST/PATCH/DELETE alert rules (no restart)
//
// `GET /?endpoint=<METHOD host path>` opens that endpoint's detail panel on load,
// which is what the links in Slack alerts point at. `GET /detail?endpoint=…` is
// the same page with that endpoint full screen — same HTML, the client reads the
// path — so a full-screen view can be shared as its own link.
//
// Every one of those three page URLs also answers in **markdown**, for anything
// that reads text instead of running the page — curl, a script, an agent on the
// host. Same data, chosen by Accept (or `?format=md`, or a `.md` suffix), and
// each page carries the links to go deeper. See markdown.js.
//   GET /app.js, /style.css, /analytics.js   static assets (no framework, no CDN)
//   GET /healthz     liveness
//
// Zero runtime npm deps: Node's built-in http + global WebSocket (the portal
// client) are all we need. Analytics is the same story — analytics.js pulls the
// PostHog library from the proxy at runtime, so there's still nothing to install.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startExporter } from "./portal.js";
import { createAuth } from "./auth.js";
import { createAlerts } from "./alerts.js";
import { createBodyStore } from "./bodies.js";
import { renderBody, renderDetail, renderLoginRequired, renderOverview, wantsMarkdown } from "./markdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");

/* What this dashboard is called in analytics. Names the PRODUCT, not the container or the
 * host — so it is a constant here, and the one line that differs when this wiring is copied
 * to the next dashboard. See `posthogKey` below. */
const APP = "httpwatch";

const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "0.0.0.0",
  yeetBin: process.env.YEET_BIN || "yeet",
  agentDir: process.env.AGENT_DIR || join(__dirname, "..", "agent"),
  socket: process.env.YEET_SOCKET || "/run/yeet/yeetd.sock",
  userSocket: process.env.YEET_USER_SOCKET || "/run/yeet/yeetd.user.sock",
  // Exporter flags (passed after `--`): interface filter + query handling.
  iface: process.env.IFACE || "",
  keepQuery: /^(1|true|yes)$/i.test(process.env.KEEP_QUERY || ""),
  // Which message bodies to capture: none | response | both. Requests are
  // opt-in because their bodies carry credentials.
  bodies: /^(none|response|both)$/i.test(process.env.BODIES || "")
    ? process.env.BODIES.toLowerCase()
    : "response",
  // Slack alerts: the channel new rules default to, and where rules are kept
  // across a server restart (best effort — set to "" to disable persistence).
  slackChannel: process.env.SLACK_CHANNEL || "#alerts",
  // Base URL used for the "open in httpwatch" link in alerts. Left unset, it's
  // learned from the Host header of a real browser request — the server has no
  // other way to know how it's reachable from someone's laptop.
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  alertsFile: process.env.ALERTS_FILE === "" ? null : (process.env.ALERTS_FILE || join(__dirname, "alerts.json")),
  /* Product analytics for the browser dashboard, through the yeet PostHog proxy
   * rather than us.posthog.com. POSTHOG_KEY="" turns it off; nothing about the
   * captured traffic is sent either way (see public/analytics.js).
   *
   * Several of these dashboards report into the SAME PostHog project, so every event says
   * which product raised it — `app`, stamped on the way out by analytics.js. Not cosmetic:
   * `dashboard_opened`, `login_started` and `alert_rule_created` exist in more than one of
   * them with different properties, so unlabelled they are one series that means nothing. */
  posthogKey: process.env.POSTHOG_KEY === "" ? null
    : (process.env.POSTHOG_KEY || "phc_nZgQxuBUL76Lhk5diKf3aBN3NtMUzJsigw4TbDRoUopa"),
  posthogHost: (process.env.POSTHOG_HOST || "https://ph.yeet.cx").replace(/\/+$/, ""),
  posthogDebug: /^(1|true|yes)$/i.test(process.env.POSTHOG_DEBUG || ""),
  // How many individual exchanges to keep for the markdown views. The browser
  // accumulates its own stream from SSE and needs nothing kept here; a client
  // that fetches one page at a time has no way to accumulate anything, so
  // without this its "recent exchanges" would only ever be the last tick.
  recentRows: Math.max(0, Number(process.env.RECENT_ROWS || 500)),
};

// ── shared state ──────────────────────────────────────────────────────────
let latest = null;          // most recent snapshot object (or null pre-data)
let status = { state: "starting" };
let handle = null;          // the live exporter handle (restartable)
let currentIface = config.iface; // interface filter in effect ("" = all)
let currentBodies = config.bodies; // body-capture mode in effect
let restarting = false;     // guards concurrent probe restarts
// Alert destinations the host can reach, as last reported by the exporter
// (yeet.caps is isolate-only). `slack: null` means we couldn't tell.
let caps = { slack: null, providers: null };
// How this dashboard was last reached by a browser, so alerts can link back to
// it. Guessed from the Host header rather than from our own bind address, which
// is usually 0.0.0.0 and useless in a link. PUBLIC_URL overrides it.
let observedOrigin = null;
const sseClients = new Set(); // Set<http.ServerResponse>
/* A bounded tail of individual exchanges ({id, key, ts, code, ms}), oldest
 * first — the same rows the browser gets over SSE, kept so a one-shot reader can
 * see more than the last second. Cheap: a row is ~90 bytes, and the ids in it go
 * stale exactly when the body store does (see restartProbe). */
const recentRows = [];

// Captured heads and bodies, streamed in ahead of each snapshot and read back by
// the browser on demand. Bounded; see bodies.js for why they live here and not
// in the snapshot.
const bodies = createBodyStore({
  maxBytes: Number(process.env.BODY_STORE_BYTES || 64 << 20),
  maxExchanges: Number(process.env.BODY_STORE_MAX || 4000),
});

/** Deep link to one endpoint's detail panel, or null without a base URL. */
function linkForEndpoint(key) {
  const base = config.publicUrl || observedOrigin;
  return base ? `${base}/?endpoint=${encodeURIComponent(key)}` : null;
}

// Login gate (yeet whoami / yeet login).
const auth = createAuth({ yeetBin: config.yeetBin, socket: config.socket, userSocket: config.userSocket });

// Per-endpoint Slack alert rules, evaluated against each snapshot here in the
// server (the exporter can't be told about rules without a restart).
const alerts = createAlerts({
  yeetBin: config.yeetBin,
  scriptPath: join(__dirname, "slack-alert.yeet.js"),
  socket: config.socket,
  userSocket: config.userSocket,
  defaultChannel: config.slackChannel,
  file: config.alertsFile,
  isLoggedIn: () => auth.isLoggedIn(),
  ifaceLabel: () => currentIface || "all",
  // Known-false means don't bother spawning an alert that can only fail; null
  // (couldn't tell) still tries, so a caps hiccup never silences alerting.
  slackConnected: () => caps.slack,
  linkFor: linkForEndpoint,
  // Bodies live in the store, not in the snapshot — a rule that wants one looks
  // it up by the id its row carried.
  bodyOf: (id) => bodies.get(id),
});

function broadcast(snapshot) {
  latest = snapshot;
  if (snapshot?.caps) caps = snapshot.caps;
  if (config.recentRows && snapshot?.recent?.length) {
    recentRows.push(...snapshot.recent);
    if (recentRows.length > config.recentRows) recentRows.splice(0, recentRows.length - config.recentRows);
  }
  // Before fanning out: diff this snapshot's status tallies and fire what's due.
  try { alerts.evaluate(snapshot); } catch (err) { console.error(`[alerts] evaluate failed: ${err.message}`); }
  const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* dropped on its own close */ }
  }
}

function broadcastStatus(evt) {
  status = { state: evt.kind, ...evt, at: Date.now() };
  const frame = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* ignore */ }
  }
}

// ── static asset serving ────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(res, file, type) {
  try {
    const body = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

/** Serve index.html with the current snapshot + config inlined for hydration.
 *  `reqUrl` is only used to advertise this page's markdown twin. */
async function serveIndex(res, reqUrl = "/") {
  let html;
  try {
    html = await readFile(join(PUBLIC, "index.html"), "utf8");
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("index.html missing");
    return;
  }
  const boot = {
    // Withhold captured data until logged in — no snapshot leaks into the HTML.
    snapshot: auth.isLoggedIn() ? latest : null,
    status,
    auth: auth.state(),
    config: { keepQuery: config.keepQuery, iface: currentIface || null, bodies: currentBodies,
              slackChannel: config.slackChannel,
              analytics: config.posthogKey
                ? { key: config.posthogKey, host: config.posthogHost, app: APP, debug: config.posthogDebug }
                : null },
    alerts: auth.isLoggedIn() ? alerts.list() : [],
    caps,
  };
  // JSON is safe to inline except for the </script> and U+2028/2029 gotchas.
  const json = JSON.stringify(boot)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  html = html.replace("/*__BOOT__*/null", json);
  res.writeHead(200, {
    "content-type": MIME[".html"],
    "cache-control": "no-cache",
    // Same URL, two representations, chosen from Accept — so caches must key on
    // it, and the alternate is advertised rather than left to be discovered.
    vary: "Accept",
    link: `<${mdAlternate(reqUrl)}>; rel="alternate"; type="text/markdown"`,
  });
  res.end(html);
}

// ── markdown views ──────────────────────────────────────────────────────────
/** This URL's markdown twin. `set`, not append: a request that already carries
 *  `format=html` would otherwise get a link with both, and the first one wins. */
function mdAlternate(reqUrl) {
  const u = new URL(reqUrl || "/", "http://x");
  u.searchParams.set("format", "md");
  return `${u.pathname}${u.search}`;
}

/** Everything the markdown renderers read, gathered per request. */
function mdContext(req) {
  const host = req.headers.host;
  return {
    snapshot: auth.isLoggedIn() ? latest : null,
    status,
    auth: auth.state(),
    caps,
    iface: currentIface || null,
    bodyMode: currentBodies,
    alerts: auth.isLoggedIn() ? alerts.list() : [],
    recent: recentRows,
    store: bodies,
    base: config.publicUrl || (host && /^[\w.:[\]-]+$/.test(host) ? `http://${host}` : null),
  };
}

function sendMarkdown(res, text, code = 200) {
  const body = Buffer.from(`${text}\n`, "utf8");
  res.writeHead(code, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
    vary: "Accept",
    "content-length": body.length,
  });
  res.end(body);
}

/** The markdown side of the gate. 401 rather than a 200 with an apology in it:
 *  a caller scripting against this needs the status line to say "no data here",
 *  and the body says the part a status code can't — that it's the host that has
 *  to log in, not the request. */
function markdownGate(res, req, what) {
  if (auth.isLoggedIn()) return true;
  sendMarkdown(res, renderLoginRequired(mdContext(req), { what }), 401);
  return false;
}

// ── auth endpoints ──────────────────────────────────────────────────────────
function handleAuth(res) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(auth.state()));
}

async function handleLoginStart(res) {
  const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    const r = await auth.startLogin();
    if (r.error) return reply(502, { ok: false, error: r.error });
    if (r.loggedIn) return reply(200, { ok: true, loggedIn: true });
    return reply(200, { ok: true, url: r.url });
  } catch (err) {
    reply(500, { ok: false, error: String(err) });
  }
}

function requireAuth(res) {
  if (auth.isLoggedIn()) return true;
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "login required" }));
  return false;
}

// ── SSE ─────────────────────────────────────────────────────────────────────
function handleEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");
  // Prime the new client with current state so it never sits blank.
  res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
  if (latest) res.write(`event: snapshot\ndata: ${JSON.stringify(latest)}\n\n`);

  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

// ── exporter lifecycle (restartable, so iface/bodies can change at runtime) ──
function buildScriptArgs(iface, bodyMode) {
  const a = [];
  if (iface) a.push("--iface", iface);
  if (config.keepQuery) a.push("--keep-query");
  if (bodyMode) a.push("--bodies", bodyMode);
  return a;
}

function startProbe(iface, bodyMode) {
  return startExporter({
    yeetBin: config.yeetBin,
    agentDir: config.agentDir,
    socket: config.socket,
    userSocket: config.userSocket,
    scriptArgs: buildScriptArgs(iface, bodyMode),
    onSnapshot: broadcast,
    onPart: (part) => bodies.part(part),
    onStatus: (evt) => {
      // Isolate stdout/stderr passed through by the portal — log it, but don't
      // treat a log line as a lifecycle state change or push it to browsers.
      if (evt.kind === "isolate-log") {
        console.error(`[isolate${evt.isolateId ? ` ${evt.isolateId}` : ""}] ${evt.line}`);
        return;
      }
      broadcastStatus(evt);
      const msg = evt.error ? `${evt.kind}: ${evt.error}` : evt.kind;
      console.log(`[exporter] ${msg}${evt.isolateId ? ` (isolate ${evt.isolateId})` : ""}`);
    },
  });
}

/** Read a request body (JSON POST), capped so a client can't OOM us. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 100_000) req.destroy(); });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

/** Swap the running probe for one with different flags. The capture settings are
 *  spawn-time arguments (there's no control channel into a running isolate), so
 *  changing either means a restart — and counts reset, same as an iface change. */
async function restartProbe({ iface = currentIface, bodyMode = currentBodies }, reply) {
  if (restarting) return reply(409, { ok: false, error: "a restart is already in progress" });
  restarting = true;
  broadcastStatus({ kind: "spawning", args: buildScriptArgs(iface, bodyMode) });
  try {
    if (handle) { try { await handle.stop(); } catch { /* ignore */ } }
    latest = null; // drop stale data captured under the previous settings
    // Exchange ids are monotonic *within a run* and restart at 1, so held bodies
    // have to go with them or a new exchange would serve an old one's body. The
    // kept rows point at those ids, so they go too.
    bodies.reset();
    recentRows.length = 0;
    // The new probe's counters start at zero, so alerts must re-baseline or the
    // first snapshot would look like a flood of new responses.
    alerts.reset();
    handle = await startProbe(iface, bodyMode);
    currentIface = iface;
    currentBodies = bodyMode;
    console.log(`[httpwatch] probe restarted (iface ${iface || "all"}, bodies ${bodyMode})`);
    reply(200, { ok: true, iface: iface || null, bodies: bodyMode });
  } catch (err) {
    broadcastStatus({ kind: "error", error: err.message });
    reply(500, { ok: false, error: err.message });
  } finally {
    restarting = false;
  }
}

/** POST /api/iface {iface:"lo,eth0"|""} — restart the probe on a new interface set. */
async function handleSetIface(req, res) {
  const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  let body;
  try { body = JSON.parse((await readBody(req)) || "{}"); }
  catch { return reply(400, { ok: false, error: "invalid JSON body" }); }

  // Sanitize into a comma list of valid interface names ("" = all interfaces).
  const iface = String(body.iface ?? "")
    .split(",").map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]+$/.test(s))
    .join(",");

  await restartProbe({ iface }, reply);
}

/**
 * /api/alerts — per-endpoint Slack alert rules.
 *   GET    ?key=…                 list rules (all, or for one endpoint)
 *   POST   {key, when, code?, channel?, cooldownSec?}   add one
 *   PATCH  ?id=… {any of the above}                     change one in place
 *   DELETE ?id=…                  remove one
 * Rules take effect on the next snapshot; nothing restarts.
 */
async function handleAlerts(req, res) {
  const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET") {
    return reply(200, { ok: true, alerts: alerts.list(url.searchParams.get("key") || undefined) });
  }

  if (req.method === "DELETE") {
    const r = alerts.remove(url.searchParams.get("id") || "");
    return r.error ? reply(404, { ok: false, error: r.error }) : reply(200, { ok: true, alerts: alerts.list() });
  }

  if (req.method === "POST" || req.method === "PATCH") {
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); }
    catch { return reply(400, { ok: false, error: "invalid JSON body" }); }

    if (req.method === "PATCH") {
      const id = url.searchParams.get("id") || body.id || "";
      const r = alerts.update(id, body);
      if (r.error) return reply(r.error === "no such rule" ? 404 : 400, { ok: false, error: r.error });
      return reply(200, { ok: true, rule: r.rule, alerts: alerts.list() });
    }

    const r = alerts.add(body);
    if (r.error) return reply(400, { ok: false, error: r.error });
    return reply(200, { ok: true, rule: r.rule, existing: !!r.existing, alerts: alerts.list() });
  }

  reply(405, { ok: false, error: "GET, POST, PATCH or DELETE only" });
}

/** POST /api/bodies {bodies:"none"|"response"|"both"} — change what gets
 *  captured. `both` includes request bodies, which is where credentials live, so
 *  it's never the default and has to be asked for explicitly. */
async function handleSetBodies(req, res) {
  const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  let body;
  try { body = JSON.parse((await readBody(req)) || "{}"); }
  catch { return reply(400, { ok: false, error: "invalid JSON body" }); }

  const bodyMode = String(body.bodies ?? "").toLowerCase();
  if (!/^(none|response|both)$/.test(bodyMode)) {
    return reply(400, { ok: false, error: "bodies must be one of: none, response, both" });
  }
  if (bodyMode === currentBodies) return reply(200, { ok: true, bodies: bodyMode, unchanged: true });

  await restartProbe({ bodyMode }, reply);
}

/** GET /api/body/<id> — one exchange's captured head + body, per direction.
 *  This is the read side of the out-of-band body transport: the row in the
 *  stream carries only an id, and the viewer asks for the rest when it's opened.
 *  A miss is a normal outcome (evicted, over budget, or bodies off), so it's a
 *  200 with `found:false` rather than a 404 the UI would have to special-case. */
function handleGetBody(res, id) {
  const found = /^\d+$/.test(id) ? bodies.get(id) : null;
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(found ? { ok: true, found: true, ...found } : { ok: true, found: false }));
}

// ── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let url = (req.url || "/").split("?")[0];
  const params = new URL(req.url || "/", "http://x").searchParams;
  /* A `.md` suffix means markdown without a query string, which is what makes
   * these pages pleasant to fetch by hand (`curl -O host/index.md`). It's a
   * spelling of ?format=md, not a separate route: strip it and remember. */
  let forceMd = false;
  if (url.endsWith(".md") && url !== "/.md") {
    url = url.slice(0, -3) || "/";
    if (url === "/index") url = "/";
    forceMd = true;
  }
  // Two strengths of "markdown, please". The page routes negotiate on Accept, so
  // a bare curl gets text; the JSON API only switches when it's asked in the URL,
  // because its callers send a wildcard Accept and expect JSON back.
  const explicitMd = forceMd || /^(md|markdown|text|txt|plain)$/i.test(params.get("format") || "");
  const asMarkdown = forceMd || wantsMarkdown(req, params);

  // Remember how we were reached, for the link in alerts. Only from requests a
  // browser actually makes, and never overriding an explicit PUBLIC_URL.
  if (!config.publicUrl && (url === "/" || url === "/index.html" || url === "/detail" || url === "/events")) {
    const host = req.headers.host;
    if (host && /^[\w.-]+(:\d+)?$/.test(host)) {
      // X-Forwarded-Proto for the reverse-proxy-with-TLS case.
      const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
      const next = `${proto === "https" ? "https" : "http"}://${host}`;
      if (next !== observedOrigin) {
        observedOrigin = next;
        console.log(`[httpwatch] alert links will point at ${observedOrigin} (set PUBLIC_URL to override)`);
      }
    }
  }
  if (url === "/api/iface" || url === "/api/bodies") {
    if (req.method !== "POST") { res.writeHead(405, { "content-type": "application/json" }); return void res.end(JSON.stringify({ ok: false, error: "POST only" })); }
    if (!requireAuth(res)) return;
    return void (url === "/api/iface" ? handleSetIface(req, res) : handleSetBodies(req, res));
  }
  if (url.startsWith("/api/body/")) {
    if (req.method !== "GET") { res.writeHead(405, { "content-type": "application/json" }); return void res.end(JSON.stringify({ ok: false, error: "GET only" })); }
    const id = url.slice("/api/body/".length);
    // Markdown here is a *decoded* view — the JSON is base64 and raw on purpose,
    // for a viewer that does its own inflating, which a reader of text can't.
    //
    // Explicitly asked for only. This is an API route with existing callers, and
    // `fetch()` sends a wildcard Accept — the browser's own body viewer included
    // — so negotiating this one on Accept handed the page markdown where it
    // expected JSON. Nothing is lost: every markdown link to a body has format=md.
    if (explicitMd) {
      if (!markdownGate(res, req, "A captured message body")) return;
      return void sendMarkdown(res, renderBody(mdContext(req), id, params));
    }
    if (!requireAuth(res)) return;
    return void handleGetBody(res, id);
  }
  if (url === "/api/alerts") {
    if (!requireAuth(res)) return;
    return void handleAlerts(req, res);
  }
  if (url === "/api/login/start") {
    if (req.method !== "POST") { res.writeHead(405, { "content-type": "application/json" }); return void res.end(JSON.stringify({ ok: false, error: "POST only" })); }
    return void handleLoginStart(res);
  }
  switch (url) {
    case "/":
    case "/index.html":
    // The full-screen endpoint view. Same page, same inlined snapshot — the
    // client reads the path and renders the detail panel full-bleed, so the URL
    // is shareable and the browser's back button leaves it.
    case "/detail":
      /* Content negotiation, not a separate route: a reader that can't run the
       * page gets the same data as text. See markdown.js for why the rule is
       * "asked for text/html → the app" rather than a list of bot names. */
      if (asMarkdown) {
        if (!markdownGate(res, req, "Captured traffic")) return;
        const ctx = mdContext(req);
        return void sendMarkdown(res, url === "/detail"
          ? renderDetail(ctx, params)
          : renderOverview(ctx, params));
      }
      return void serveIndex(res, req.url);
    case "/app.js":
      return void serveStatic(res, "app.js", MIME[".js"]);
    case "/analytics.js":
      return void serveStatic(res, "analytics.js", MIME[".js"]);
    case "/style.css":
      return void serveStatic(res, "style.css", MIME[".css"]);
    case "/api/auth":
      return void handleAuth(res);
    case "/events":
      if (!requireAuth(res)) return;
      return void handleEvents(req, res);
    case "/healthz":
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, state: status.state, hasData: !!latest, iface: currentIface || null, bodies: currentBodies, bodyStore: bodies.stats(), loggedIn: auth.isLoggedIn() }));
    default:
      // A wrong path is where a reader without a browser is most stuck, so the
      // markdown 404 hands back the route list instead of one word.
      if (asMarkdown) {
        return void sendMarkdown(res, [
          `# httpwatch — no route ${`\`${url.replace(/`/g, "ʼ")}\``}`,
          "",
          "Start at [`/?format=md`](/?format=md), which lists every URL this server answers and what each one gives you.",
        ].join("\n"), 404);
      }
      res.writeHead(404, { "content-type": "text/plain" });
      return void res.end("not found");
  }
});

// ── boot ────────────────────────────────────────────────────────────────────
// A dashboard's job is to keep serving. Route handlers are async, so a rejection
// inside one (a client vanishing mid-request, a write to a closed socket) would
// otherwise take the whole process down in Node and stop the capture with it.
// Log loudly and stay up — loudly, so this nets bugs instead of hiding them.
process.on("unhandledRejection", (err) => {
  console.error(`[httpwatch] unhandled rejection: ${err?.stack || err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[httpwatch] uncaught exception: ${err?.stack || err}`);
});

async function main() {
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[httpwatch] port ${config.port} is already in use — set PORT to a free port (with --network=host it must be free on the HOST).`);
    } else {
      console.error(`[httpwatch] server error: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`[httpwatch] serving on http://${config.host}:${config.port}`);
  });

  try {
    handle = await startProbe(currentIface, currentBodies);
  } catch (err) {
    console.error(`[httpwatch] could not start exporter: ${err.message}`);
    broadcastStatus({ kind: "error", error: err.message });
    return; // keep serving the page so the error is visible in the UI
  }

  const shutdown = async () => {
    console.log("[httpwatch] shutting down…");
    try { auth.stop(); } catch { /* ignore */ }
    try { await handle?.stop(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
