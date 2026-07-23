// Login gate backed by the yeet CLI.
//
// The dashboard is gated on the yeet daemon being logged in (`yeet whoami`).
// When it isn't, the browser drives a device-style login: we spawn `yeet login`
// (which prints `Please login at: <url>` then blocks until the user completes it
// in a browser), scrape that URL, hand it to the page, and poll `whoami` until
// it resolves.
//
// This is host-level auth (is *this* yeet instance logged in), not per-visitor
// auth — the first visitor to complete login unlocks the dashboard.

import { spawn } from "node:child_process";

// CSI/OSC escape sequences — the login banner is full of them; strip before
// scraping the URL.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g;
const stripAnsi = (s) => s.replace(ANSI, "");

const LOGIN_URL_RE = /Please login at:\s*(\S+)/i;
const REFRESH_MS = 10_000;      // background re-check of login state
const URL_TIMEOUT_MS = 20_000;  // give up waiting for `yeet login` to print a URL

export function createAuth({ yeetBin, socket, userSocket }) {
  const globalArgs = [];
  if (socket) globalArgs.push("--socket", socket);
  if (userSocket) globalArgs.push("--user-socket", userSocket);

  let loggedIn = false;
  let identity = null;
  let loginProc = null;      // the in-flight `yeet login` child, if any
  let loginUrl = null;       // the scraped verification URL, if known
  let loginError = null;
  let urlPromise = null;     // resolves to { url } | { error } for concurrent callers

  /** `yeet whoami -q` → exit 0 means logged in. */
  function whoamiQuiet() {
    return new Promise((resolve) => {
      const c = spawn(yeetBin, [...globalArgs, "whoami", "-q"], { stdio: "ignore", env: { ...process.env, NO_COLOR: "1" } });
      c.on("error", () => resolve(false));
      c.on("close", (code) => resolve(code === 0));
    });
  }

  /** `yeet whoami` → first non-empty stdout line, for a display name. */
  function whoamiName() {
    return new Promise((resolve) => {
      let out = "";
      const c = spawn(yeetBin, [...globalArgs, "whoami"], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, NO_COLOR: "1" } });
      c.stdout.on("data", (d) => (out += d));
      c.on("error", () => resolve(null));
      c.on("close", () => {
        const line = stripAnsi(out).split("\n").map((s) => s.trim()).filter(Boolean)[0];
        resolve(line || null);
      });
    });
  }

  async function refresh() {
    const was = loggedIn;
    loggedIn = await whoamiQuiet();
    if (loggedIn && !identity) identity = await whoamiName();
    if (!loggedIn) identity = null;
    return loggedIn !== was;
  }

  /** Begin (or join) a login flow; resolves once the URL is known. */
  function startLogin() {
    if (loggedIn) return Promise.resolve({ loggedIn: true });
    if (urlPromise) return urlPromise; // a login is already in flight

    loginError = null;
    loginUrl = null;
    const child = spawn(yeetBin, [...globalArgs, "login"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    loginProc = child;

    urlPromise = new Promise((resolve) => {
      let buf = "";
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      const scan = (d) => {
        buf += stripAnsi(d.toString());
        const m = LOGIN_URL_RE.exec(buf);
        if (m) { loginUrl = m[1]; done({ url: loginUrl }); }
      };
      child.stdout.on("data", scan);
      child.stderr.on("data", scan);

      const timer = setTimeout(() => done({ error: "timed out waiting for the login URL" }), URL_TIMEOUT_MS);

      child.on("error", (err) => { loginError = String(err); done({ error: loginError }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        loginProc = null;
        loginUrl = null;
        urlPromise = null; // allow a fresh attempt later
        if (code === 0) { refresh(); }           // success → whoami now resolves
        else if (!loggedIn) loginError = "login did not complete";
        done({ error: loginError || "login process exited" });
      });
    });
    return urlPromise;
  }

  function state() {
    return { loggedIn, identity, loginUrl, loginPending: !!loginProc, error: loginError };
  }

  // Prime + poll in the background so request handlers read a cached flag.
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);

  return {
    isLoggedIn: () => loggedIn,
    refresh,
    startLogin,
    state,
    stop() {
      clearInterval(timer);
      try { loginProc?.kill("SIGTERM"); } catch { /* ignore */ }
    },
  };
}
