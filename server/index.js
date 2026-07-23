// httpwatch server.
//
// Runs the httpinspect exporter isolate (via portal.js), holds the latest JSON
// snapshot in memory, and serves:
//   GET /            the dashboard HTML, with the latest snapshot inlined as
//                    window.__INITIAL__ so the page hydrates immediately
//   GET /events      Server-Sent Events — one `snapshot` event per exporter tick
//   GET /app.js, /style.css   static assets (no framework, no CDN)
//   GET /healthz     liveness
//
// Zero runtime npm deps: Node's built-in http + global WebSocket (the portal
// client) are all we need.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startExporter } from "./portal.js";
import { createAuth } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");

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
};

// ── shared state ──────────────────────────────────────────────────────────
let latest = null;          // most recent snapshot object (or null pre-data)
let status = { state: "starting" };
let handle = null;          // the live exporter handle (restartable)
let currentIface = config.iface; // interface filter in effect ("" = all)
let restarting = false;     // guards concurrent /api/iface restarts
const sseClients = new Set(); // Set<http.ServerResponse>

// Login gate (yeet whoami / yeet login).
const auth = createAuth({ yeetBin: config.yeetBin, socket: config.socket, userSocket: config.userSocket });

function broadcast(snapshot) {
  latest = snapshot;
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

/** Serve index.html with the current snapshot + config inlined for hydration. */
async function serveIndex(res) {
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
    config: { keepQuery: config.keepQuery, iface: currentIface || null },
  };
  // JSON is safe to inline except for the </script> and U+2028/2029 gotchas.
  const json = JSON.stringify(boot)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  html = html.replace("/*__BOOT__*/null", json);
  res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
  res.end(html);
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

// ── exporter lifecycle (restartable, so the iface can change at runtime) ────
function buildScriptArgs(iface) {
  const a = [];
  if (iface) a.push("--iface", iface);
  if (config.keepQuery) a.push("--keep-query");
  return a;
}

function startWithIface(iface) {
  return startExporter({
    yeetBin: config.yeetBin,
    agentDir: config.agentDir,
    socket: config.socket,
    userSocket: config.userSocket,
    scriptArgs: buildScriptArgs(iface),
    onSnapshot: broadcast,
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

/** POST /api/iface {iface:"lo,eth0"|""} — restart the probe on a new interface set. */
async function handleSetIface(req, res) {
  const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (restarting) return reply(409, { ok: false, error: "a restart is already in progress" });

  let body;
  try { body = JSON.parse((await readBody(req)) || "{}"); }
  catch { return reply(400, { ok: false, error: "invalid JSON body" }); }

  // Sanitize into a comma list of valid interface names ("" = all interfaces).
  const iface = String(body.iface ?? "")
    .split(",").map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]+$/.test(s))
    .join(",");

  restarting = true;
  broadcastStatus({ kind: "spawning", args: iface ? ["--iface", iface] : [] });
  try {
    if (handle) { try { await handle.stop(); } catch { /* ignore */ } }
    latest = null; // drop stale data captured on the previous interface set
    handle = await startWithIface(iface);
    currentIface = iface;
    console.log(`[httpwatch] switched iface to ${iface || "all"}`);
    reply(200, { ok: true, iface: iface || null });
  } catch (err) {
    broadcastStatus({ kind: "error", error: err.message });
    reply(500, { ok: false, error: err.message });
  } finally {
    restarting = false;
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/api/iface") {
    if (req.method !== "POST") { res.writeHead(405, { "content-type": "application/json" }); return void res.end(JSON.stringify({ ok: false, error: "POST only" })); }
    if (!requireAuth(res)) return;
    return void handleSetIface(req, res);
  }
  if (url === "/api/login/start") {
    if (req.method !== "POST") { res.writeHead(405, { "content-type": "application/json" }); return void res.end(JSON.stringify({ ok: false, error: "POST only" })); }
    return void handleLoginStart(res);
  }
  switch (url) {
    case "/":
    case "/index.html":
      return void serveIndex(res);
    case "/app.js":
      return void serveStatic(res, "app.js", MIME[".js"]);
    case "/style.css":
      return void serveStatic(res, "style.css", MIME[".css"]);
    case "/api/auth":
      return void handleAuth(res);
    case "/events":
      if (!requireAuth(res)) return;
      return void handleEvents(req, res);
    case "/healthz":
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, state: status.state, hasData: !!latest, iface: currentIface || null, loggedIn: auth.isLoggedIn() }));
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      return void res.end("not found");
  }
});

// ── boot ────────────────────────────────────────────────────────────────────
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
    handle = await startWithIface(currentIface);
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
