// The bridge from the yeet isolate to this node process.
//
// We run the httpinspect *exporter* (agent/) as a detached, ws-routed yeet
// isolate:
//
//   yeet run --detach <agent> -p console:ws://127.0.0.1:<port>/c -- <flags>
//
// The daemon mirrors the isolate's console (its JSON snapshots) onto that
// WebSocket listener; we connect as a client, split the stream into lines, and
// hand each parsed snapshot to a callback. The isolate is daemon-owned, so if
// this process restarts the isolate keeps running; if the isolate dies, the
// console socket closes and we respawn.

import { spawn } from "node:child_process";
import net from "node:net";

const CONNECT_RETRIES = 60;
const CONNECT_DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Redirect-detach prints `detached; stop: kill <N>`; plain detach prints
// `[Spawned Detached Isolate <N>]`. Accept either.
const ID_BANNER = /(?:detached; stop: kill|Spawned Detached Isolate)\s+(\d+)/;
const redirectUrl = (text, lane) =>
  new RegExp(`Redirecting\\s+${lane}\\s+to\\s+(ws://\\S+)`).exec(text)?.[1];

/** An OS-assigned free localhost port for the console portal listener. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Run `yeet <args>` to completion, capturing stdout+stderr. */
function execYeet(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ exitCode: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/** Connect a ws client, retrying until the daemon's listener is up. */
async function connectWs(url) {
  for (let i = 0; i < CONNECT_RETRIES; i++) {
    const ws = new WebSocket(url);
    const ok = await new Promise((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });
    if (ok) {
      ws.onerror = null;
      return ws;
    }
    try { ws.close(); } catch { /* ignore */ }
    await sleep(CONNECT_DELAY_MS);
  }
  return null;
}

/** Decode a ws message to text, unwrapping yeet's {type:"console",message}. */
function messageToText(data) {
  if (typeof data === "string") {
    try {
      const o = JSON.parse(data);
      if (o && o.type === "console" && typeof o.message === "string") return o.message;
    } catch { /* raw text */ }
    return data;
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

/**
 * Start the exporter isolate and stream its JSON snapshots.
 *
 * @param {object} opts
 * @param {string} opts.yeetBin        path to the `yeet` binary
 * @param {string} opts.agentDir       the httpinspect exporter project dir
 * @param {string} [opts.socket]       privileged daemon socket
 * @param {string} [opts.userSocket]   user daemon socket
 * @param {string[]} [opts.scriptArgs] flags passed after `--` (e.g. --iface lo)
 * @param {(snap:object)=>void} opts.onSnapshot  called with each parsed snapshot
 * @param {(evt:object)=>void} [opts.onStatus]   lifecycle notifications
 * @returns {Promise<{stop:()=>Promise<void>}>}
 */
export async function startExporter(opts) {
  const { yeetBin, agentDir, socket, userSocket, scriptArgs = [], onSnapshot, onStatus = () => {} } = opts;
  let stopped = false;
  let currentWs = null;
  let currentId = null;

  const globalArgs = [];
  if (socket) globalArgs.push("--socket", socket);
  if (userSocket) globalArgs.push("--user-socket", userSocket);

  async function spawnOnce() {
    const cPort = await freePort();
    const consoleUrl = `ws://127.0.0.1:${cPort}/c`;
    const runArgs = [
      ...globalArgs,
      "run", "--detach",
      "-p", `console:${consoleUrl}`,
      "--name", "httpinspect-export",
      agentDir,
    ];
    if (scriptArgs.length) runArgs.push("--", ...scriptArgs);

    onStatus({ kind: "spawning", args: scriptArgs });
    const res = await execYeet(yeetBin, runArgs);
    const text = `${res.stdout}\n${res.stderr}`;
    const id = ID_BANNER.exec(text)?.[1];
    if (!id) {
      const detail = (res.stderr || res.stdout).trim();
      throw new Error(`yeet run failed (exit ${res.exitCode})${detail ? `: ${detail}` : ""}`);
    }
    currentId = id;
    onStatus({ kind: "spawned", isolateId: id });

    const url = redirectUrl(text, "console") ?? consoleUrl;
    const ws = await connectWs(url);
    if (!ws) throw new Error(`console portal never connected (${url})`);
    currentWs = ws;
    ws.binaryType = "arraybuffer";
    onStatus({ kind: "connected", isolateId: id, url });

    let lineBuf = "";
    ws.onmessage = (ev) => {
      lineBuf += messageToText(ev.data);
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        let line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        line = line.trim();
        if (!line) continue;
        // Non-JSON console output is the isolate's own logs / crash dumps.
        // Surface it (don't swallow it) so a probe that dies isn't an invisible
        // respawn loop — this is exactly the output that hides why it exited.
        if (line[0] !== "{") { onStatus({ kind: "isolate-log", isolateId: id, line }); continue; }
        let msg;
        try { msg = JSON.parse(line); } catch { onStatus({ kind: "isolate-log", isolateId: id, line }); continue; }
        if (msg.t === "snapshot") onSnapshot(msg);
        else if (msg.t === "hello") onStatus({ kind: "hello", iface: msg.iface });
      }
    };

    // The console lane closing means the isolate exited — respawn.
    ws.onclose = () => {
      currentWs = null;
      if (stopped) return;
      onStatus({ kind: "isolate-gone", isolateId: id });
      setTimeout(() => { if (!stopped) spawnOnce().catch((err) => onStatus({ kind: "error", error: String(err) })); }, 1000);
    };
  }

  await spawnOnce();

  return {
    async stop() {
      stopped = true;
      try { currentWs?.close(); } catch { /* ignore */ }
      if (currentId) {
        // Best-effort: kill the daemon-owned isolate so it doesn't linger.
        await execYeet(yeetBin, [...globalArgs, "kill", currentId]).catch(() => {});
      }
    },
  };
}
