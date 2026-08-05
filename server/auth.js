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

// `yeet whoami` prints a banner ("Currently logged in as:") before the fields,
// so the first non-empty line is prose, not an id. Take the labelled field.
//
// The owner is whoever the host is registered to — an ORG- id for a host owned
// by an organisation, a USER- id for a personal one. yeet itself treats
// owner_id as an opaque string (common/src/objects/whoami: `owner_id: String`),
// so don't validate the prefix; anything id-shaped is the id. The fallback only
// exists in case the `Owner ID:` label is ever reworded.
const OWNER_ID_RE = /^\s*Owner ID:\s*(\S+)/im;
const ANY_ID_RE = /\b[A-Z][A-Z0-9]*-[A-Z0-9]{8,}\b/;

/** Pull the owner id (`ORG-…`/`USER-…`) out of `yeet whoami` stdout, or null. */
export function parseOwnerId(stdout) {
  const text = stripAnsi(String(stdout));
  const labelled = OWNER_ID_RE.exec(text)?.[1];
  if (labelled) return labelled;
  // Host ID is labelled too, so a bare scan must not pick it up by accident.
  const m = ANY_ID_RE.exec(text.replace(/^\s*Host ID:.*$/gim, ""));
  return m?.[0] || null;
}

// Background re-check of login state. Logged out, the poll is what notices the
// user finishing the login in their browser, so it has to be brisk. Logged in,
// it only catches the rare logout/expiry, and every tick is a `yeet whoami`
// round trip — so back right off.
const REFRESH_MS = 10_000;
const REFRESH_LOGGED_IN_MS = 5 * 60_000;
const URL_TIMEOUT_MS = 20_000;  // give up waiting for `yeet login` to print a URL

// `whoami` runs on a timer, so leaving analytics on would have every host
// idling on the dashboard trickle events into our own pipeline forever.
const WHOAMI_ENV = { NO_COLOR: "1", YEET_NO_ANALYTICS: "1" };

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
      const c = spawn(yeetBin, [...globalArgs, "whoami", "-q"], { stdio: "ignore", env: { ...process.env, ...WHOAMI_ENV } });
      c.on("error", () => resolve(false));
      c.on("close", (code) => resolve(code === 0));
    });
  }

  /** `yeet whoami` → the owner id, for a stable per-user handle. */
  function whoamiName() {
    return new Promise((resolve) => {
      let out = "";
      const c = spawn(yeetBin, [...globalArgs, "whoami"], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...WHOAMI_ENV } });
      c.stdout.on("data", (d) => (out += d));
      c.on("error", () => resolve(null));
      c.on("close", () => {
        resolve(parseOwnerId(out));
      });
    });
  }

  async function refresh() {
    const was = loggedIn;
    loggedIn = await whoamiQuiet();
    if (loggedIn && !identity) identity = await whoamiName();
    if (!loggedIn) identity = null;
    // A flip changes which cadence applies — re-arm now rather than letting the
    // pending tick run at the old rate (a login otherwise keeps the 10s poll for
    // one more round).
    if (loggedIn !== was) schedule();
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

  // Prime + poll in the background so request handlers read a cached flag. The
  // timer re-arms itself after each check rather than running at a fixed rate,
  // so the cadence follows the login state (and so a slow `whoami` can't stack
  // up behind itself).
  let timer = null;
  let stopped = false;
  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, loggedIn ? REFRESH_LOGGED_IN_MS : REFRESH_MS);
  }
  async function tick() {
    try { await refresh(); } finally { schedule(); }
  }
  refresh().then(schedule, schedule);

  return {
    isLoggedIn: () => loggedIn,
    refresh,
    startLogin,
    state,
    stop() {
      stopped = true;
      clearTimeout(timer);
      try { loginProc?.kill("SIGTERM"); } catch { /* ignore */ }
    },
  };
}
