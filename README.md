# `httpwatch`

> **`httpinspect`, served to your browser.** Every plaintext HTTP request crossing the box, decoded off the wire by eBPF and rendered live in the browser. No proxy, no sidecar, no app changes — one Docker command.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/render-native%20DOM%20%C2%B7%20no%20CDN-4fc1ff" alt="native browser components">
  <img src="https://img.shields.io/badge/license-GPL--2.0-3DA639" alt="GPL-2.0">
</p>

<p align="center">
  <img src="assets/httpwatch.gif" alt="httpwatch — a live HTTP endpoint dashboard in the browser" width="820">
</p>

**httpwatch turns the plaintext HTTP crossing your host into a live web dashboard.** Every `METHOD host path` endpoint, ranked by traffic, with a running count, req/s, and p95 latency. Click a row for a live detail panel — that route's individual requests newest-first and color-coded by status class, plus percentiles, a status-code mix, and a req/s sparkline. Same eBPF capture as [`httpinspect`](https://github.com/yeet-src/httpinspect), rendered in the browser instead of a terminal.

> [!TIP]
> **It's not a TUI piped to the browser.** The probe ships raw aggregated JSON out of the yeet isolate; the page receives it over SSE and draws its own table, panels, and sparklines in plain DOM — no framework, no CDN, no terminal emulator.

## Contents

**Run it** — [Quick start (Linux)](#quick-start) · [macOS](#running-on-macos-docker-desktop) · [From source](#from-source)

**Learn it** — [HTTP-on-the-wire primer](#a-30-second-primer-on-http-on-the-wire) · [Use cases](#common-use-cases) · [What you're looking at](#what-youre-looking-at) · [Without a browser](#reading-it-without-a-browser) · [How it works](#how-it-works)

**Reference** — [Building from source](#building-from-source) · [Try it without traffic](#try-it-without-real-traffic) · [What the dashboard reports](#what-the-dashboard-reports) · [Requirements](#requirements) · [FAQ](#community-questions) · [License](#license)

## Quick start

One command — no clone, no build. The image is multi-arch, so it pulls the right build for amd64 or arm64 automatically:

```sh
docker run --rm -it \
  --cap-add SYS_ADMIN \
  --cap-add NET_ADMIN \
  --cap-add BPF \
  --cap-add PERFMON \
  --security-opt apparmor=unconfined \
  --pid=host \
  --network=host \
  -v /sys/kernel/btf/vmlinux:/sys/kernel/btf/vmlinux:ro \
  -v "$HOME/.local/state/httpwatch:/data" -e STATE_UID="$(id -u)" -e STATE_GID="$(id -g)" \
  ghcr.io/yeet-src/httpwatch:latest      # → http://localhost:8080
```

`SYS_ADMIN` mounts the container-private bpffs, `NET_ADMIN` attaches the TCX programs, and `BPF`/`PERFMON` load the program and its maps. `apparmor=unconfined` lifts Docker's default profile, which otherwise denies the bpffs `mount` — it's the one thing `--privileged` relaxes that a capability can't. The read-only BTF mount (a world-readable kernel file) lets the probe CO-RE-relocate to your kernel.

The last line is the only writable mount: it keeps your [Slack alert rules](#alerts) in `~/.local/state/httpwatch/alerts.json` so they survive `--rm`, and the two `STATE_*` vars just make that file yours rather than root's. **Drop that line entirely if you don't want alerts to persist** — everything else works the same, rules simply live and die with the container.

Open **http://localhost:8080** (or `http://<host>:8080` over your network) and the table fills as plaintext HTTP flows. On Linux, add `sudo` if you're not in the `docker` group; on **macOS**, see [Running on macOS](#running-on-macos-docker-desktop).

Tune it with environment variables (`-e VAR=…`); the interface set and body capture are also editable live in the UI:

| var          | default       | meaning                                                              |
| ------------ | ------------- | -------------------------------------------------------------------- |
| `PORT`       | `8080`        | port the dashboard is served on (bound on the host — must be free)   |
| `IFACE`      | all up ifaces | comma-separated interfaces to watch, e.g. `lo,eth0` (initial set)    |
| `KEEP_QUERY` | off           | keep query strings distinct — `/x?id=1` and `/x?id=2` stay separate rows |
| `BODIES`     | `response`    | which message bodies to capture: `none`, `response`, or `both`. `both` captures request bodies too — that's where passwords and tokens live, and anyone who can reach the dashboard can then read them |
| `BODY_STORE_BYTES` | `67108864` | how much captured body the server holds for reading back (64MB). Older exchanges are evicted first; a row whose body is gone says so |
| `BODY_STORE_MAX` | `4000`      | how many exchanges the body store holds, whichever limit is reached first |
| `SLACK_CHANNEL` | `#alerts`  | channel new alert rules default to                                   |
| `PUBLIC_URL` | learned from the `Host` header | base URL for the "open in httpwatch" link in alerts, e.g. `https://watch.example.com`. A dotted host or IP also gets a real Slack button instead of a plain link — Slack rejects buttons pointing at `localhost` or any dotless name |
| `ALERTS_FILE` | `/data/alerts.json` | where alert rules are persisted inside the container; set to empty to keep them in memory only |
| `STATE`      | `~/.local/state/httpwatch` | (make only) host directory bind-mounted at `/data`, so alert rules outlive the container. Any value containing `/` is a host path; a bare name uses a docker volume instead |
| `RECENT_ROWS` | `500`       | how many individual exchanges the server keeps for the [markdown views](#reading-it-without-a-browser) (the browser accumulates its own from SSE; a one-shot reader can't). `0` disables the tail |
| `YEET_AUTH_KEY` | —          | log the host in at startup                                           |

For a persistent deployment, run it detached and self-healing:

```sh
docker run -d \
  --name httpwatch \
  --restart unless-stopped \
  --cap-add SYS_ADMIN \
  --cap-add NET_ADMIN \
  --cap-add BPF \
  --cap-add PERFMON \
  --security-opt apparmor=unconfined \
  --pid=host \
  --network=host \
  -v /sys/kernel/btf/vmlinux:/sys/kernel/btf/vmlinux:ro \
  -v "$HOME/.local/state/httpwatch:/data" -e STATE_UID="$(id -u)" -e STATE_GID="$(id -g)" \
  -e PUBLIC_URL="http://$(hostname -f 2>/dev/null || hostname):8080" \
  ghcr.io/yeet-src/httpwatch:latest
```

For a long-lived deployment the state mount matters more, not less — it's what keeps alert rules across image updates — and `PUBLIC_URL` makes the links in Slack alerts work for people who aren't on the box.

### Running on macOS (Docker Desktop)

Docker Desktop runs a Linux VM shared by all your containers, so `--network=host` lets the probe watch your **other containers'** plaintext HTTP — not your Mac's own apps, which live outside the VM. Two things to get right:

1. **Update Docker Desktop** — the VM kernel needs TCX (6.6+), or the probe fails to attach with `tcx: -EINVAL`.
2. **Publish the UI port** — `--network=host` captures but doesn't expose the UI to macOS, so add `-p $PORT:$PORT`.

```sh
export PORT=8080          # any free port on your Mac; export so $PORT expands below
docker run --rm -it \
  --cap-add SYS_ADMIN \
  --cap-add NET_ADMIN \
  --cap-add BPF \
  --cap-add PERFMON \
  --security-opt apparmor=unconfined \
  --pid=host \
  --network=host \
  -e PORT=$PORT \
  -p $PORT:$PORT \
  -v /sys/kernel/btf/vmlinux:/sys/kernel/btf/vmlinux:ro \
  ghcr.io/yeet-src/httpwatch:latest      # → http://localhost:$PORT
```

### From source

To build it yourself or hack on it, clone and drive it with the `Makefile` (`VAR=… make run` forwards the same env vars, and it falls back to `sudo docker` automatically):

```sh
git clone git@github.com:yeet-src/httpwatch.git && cd httpwatch
make run          # build the image, run yeetd + server + probe, serve on :8080
```

The first `make run` builds a self-contained image (base, yeet toolchain, eBPF object, yeetd) — a few minutes, internet needed **once**; after that it starts in seconds. Other targets:

```sh
make up           # detached + --restart unless-stopped (persistent deployment)
make down         # stop and remove it
```

## A 30-second primer on HTTP-on-the-wire

What the probe reads (identical to `httpinspect`):

- **A request is text.** An HTTP/1.x request opens with a request line — `GET /path HTTP/1.1` — then headers, then a blank line. The first bytes of the TCP payload *are* that line.
- **The endpoint is `METHOD host path`.** Method and path from the request line; host from the `Host:` header (or the absolute-form target on a proxied/`CONNECT` request). Traffic is tallied by that triple.
- **Plaintext only.** It works because the bytes on the wire *are* the request. Under TLS the payload is ciphertext here, so HTTPS is invisible.

## Common use cases

A ground-truth view of the plaintext HTTP crossing a host — from a browser, over the network, no terminal on the box:

- A service is slow — which endpoint is getting hammered, at what rate? Open its detail for the request stream and p95.
- Suspected retry storm or 5xx wave — sort by `REQ/S`, click the route, watch responses tick past color-coded.
- Auditing a remote box over your tailnet — what plaintext HTTP is flowing, and to which hosts, with no SSH or TUI.
- Local microservices over `lo` — see the chatter without instrumenting any of them.

## What you're looking at

A **top bar** with the watched interfaces (click the `iface:` pill to change them live), a `bodies:` pill for what gets captured, an `alerts:` pill that opens [every alert rule in one place](#alerts) (it reads `3 · 1 failing` when one can't deliver), and a connection indicator; the **endpoints table**, one row per `METHOD host path` sorted busiest-first (click a header to re-sort, a row to open its detail); and a **footer** with totals — requests, endpoints, bytes on the wire, uptime.

| column   | meaning                                                          |
| -------- | --------------------------------------------------------------- |
| `#`      | rank by the current sort                                        |
| `METHOD` | HTTP method                                                     |
| `HOST`   | `Host:` header (or authority from an absolute-form target)      |
| `PATH`   | request path, shown in full (wraps, never truncated); query string collapsed unless `KEEP_QUERY` |
| `COUNT`  | cumulative requests seen for this endpoint                      |
| `REQ/S`  | requests in the last second (`·` when idle)                     |
| `p95`    | 95th-percentile on-the-wire latency                             |
| `LAST`   | how long ago this endpoint was last hit                         |

Click any row for the **detail panel** — the live breakdown where the web version goes beyond the TUI:

- total requests and share of traffic, current and peak req/s
- **latency** p50 / p95 / max, from pairing each response with its request on the wire
- **status codes** by class (2xx / 3xx / 4xx / 5xx)
- a req/s sparkline over the last minute
- a **live request stream** — completed requests newest-first, color-coded by status class (2xx green · 3xx cyan · 4xx yellow · 5xx red), each with status, latency, and a ms timestamp
- **click any request in that stream to read it** — status line, headers, and body, un-chunked, un-gzipped and JSON pretty-printed (and syntax-highlighted) in the browser, so a 500 shows you the actual error instead of just the code. With request bodies enabled you get both halves of the exchange, request first — reading a 400 usually means reading the payload that caused it. Each half has **copy body** and **copy message** buttons (the message is the head exactly as captured plus the decoded body), and text inside an open response is freely selectable — clicking or dragging in there won't collapse it, only the row itself toggles

- **Slack alerts** — "＋ Set alert", pick a condition (any 5xx, any 4xx, either, or one specific code), a channel, a quiet period, and optionally **the response body** so the alert carries the actual error. Every alert links back to the endpoint's panel here. Tick **every endpoint on this host** for a catchall instead of a single route — the sane starting point before you know which routes matter. The rule takes effect on the next tick: nothing restarts and no counters reset. Matches keep counting while a rule is cooling down, and the next alert says how many it covered and where.

Everything updates in place over SSE. Collapse the panel with the drawer icon or `Esc`; `Esc` closes an open response first.

**Go full screen when the panel gets tight.** The expand icon (or `f`) hands the endpoint the whole window: the list steps aside, the aggregates take a column, and the request stream gets the full height — plus taller header and body views, so reading a response stops being a scroll through a 460px column. It's a real URL — **`/detail?endpoint=<METHOD host path>`** — so the full-screen view can be pasted to someone and it opens the way you left it. Expanding pushes a history entry, so `←` (or `Esc`) drops you back to the list with the panel still open.

**The request stream holds still while you read it.** Scroll off the top or expand a request and new rows queue up behind a "N new requests · click to resume" pill instead of shifting what you're looking at — and nothing gets trimmed away underneath you. Scroll back to the top, collapse the request, or click the pill to start following again.

## Reading it without a browser

`curl` the dashboard and you get **markdown**, not the HTML shell:

```console
$ curl localhost:8080
# httpwatch

- **Probe:** running
- **Watching:** `lo` (available: `lo`, `eth0`)
- **Requests:** 12,481 across 37 endpoints
…
| # | Endpoint                        | Reqs  | req/s | p50 ms | p95 ms | Status              | Detail |
| 1 | `GET shop.internal /api/orders` | 4,120 |   3.2 |    4.2 |   31.0 | 200 ×4,102 · 500 ×16 | [open](/detail?endpoint=GET%20shop.internal%20%2Fapi%2Forders&format=md) |
```

The page is a shell that hydrates from an inlined snapshot and then streams SSE, so without this the most convenient way to inspect a host — ask it over HTTP — was the one way that didn't work. Now the same three URLs answer in either representation, and **the markdown carries its own links**, so a reader that starts at `/` can reach a decoded response body without being told how:

| Depth | URL | What it gives you |
| --- | --- | --- |
| 1 | `/` | probe state, totals, the endpoint table — every row linking to its detail page. `&limit=` up to 500, `&sort=count\|rate\|p95\|p50\|bytes\|last\|errors` |
| 2 | `/detail?endpoint=<METHOD host path>` | percentiles, status-code shares, req/s for the last minute as numbers, and the tail of individual exchanges — each linking to its body. `&rows=` up to 500 |
| 3 | `/api/body/<id>?format=md` | one exchange's head and body, **decoded** — dechunked, gunzipped, fenced, with a note when the capture cut it short. `&dir=req\|res\|both`, `&max=` up to 200,000 characters |

Every page also lists the JSON routes (`/healthz`, `/api/alerts`, `/events`) for anything that would rather parse than read.

**How the view is chosen.** For the two page routes, anything that doesn't ask for `text/html` in its `Accept` header gets markdown — plain `curl`, `wget`, a script, an agent — and a browser gets the app. No User-Agent sniffing: a list of bot names is wrong the day something new appears. Override it either way with `?format=md` or `?format=html`, or fetch `/index.md` and `/detail.md`. HTML responses advertise their twin with a `Link: <…?format=md>; rel=alternate` header, and both carry `Vary: Accept`.

**`/api/*` is exempt** and keeps returning JSON unless the URL asks for markdown outright (`?format=md` or a `.md` suffix). Its callers are `fetch()`, which sends a wildcard `Accept` — including the dashboard's own body viewer — so negotiating there would hand the page markdown where it expected JSON. Nothing is lost: every markdown link to a body carries `format=md` already.

**The login gate still applies.** Logged out, these return `401` with markdown explaining that the *host* needs `yeet login` — there is no header a caller could add, so a bare `401` would send someone hunting for a token that doesn't exist. `/healthz` needs no login and stays JSON.

## How it works

The eBPF capture is [`httpinspect`](https://github.com/yeet-src/httpinspect) verbatim, vendored under `agent/`. The one new piece is a headless entry that prints JSON instead of drawing a TUI; the rest is the node server and the browser app.

```
 ┌──────── Docker container (--cap-add SYS_ADMIN,NET_ADMIN,BPF,PERFMON · host pid+net) ───────┐
 │  yeetd ◄── privileged BPF load ── [ yeet isolate: the httpinspect exporter (agent/) ]      │
 │                                        │ probe.js + httptop.js  (unchanged capture)         │
 │                                        │ export.js  (NEW: samples signals → JSON/1s)        │
 │                                        ▼ console.log(JSON)  snapshot/1s + body parts        │
 │                                   yeet console WebSocket portal                             │
 │                                        │                                                    │
 │   node server ── connects as a ws client ── latest snapshot + captured-body store          │
 │      :8080     ├─ GET /            dashboard HTML, snapshot inlined for instant hydration   │
 │                ├─ GET /events      SSE: one snapshot per tick ─────────► browser (DOM)      │
 │                └─ GET /api/body/N  one exchange's head + body, on demand ◄── row expanded   │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

```
agent/                   the httpinspect exporter (vendored, unchanged capture)
  src/probes/probe.js      loads the shared BPF object, attaches TCX, exposes `control`
  src/probes/httptop.js    ingest: parse, pair responses for latency, aggregate → signals
  src/lib/format.js        pure formatters (percentiles, sparkline scaling)
  src/export.js            NEW headless entry: samples the signals → prints a JSON snapshot/1s
  src/main.jsx             the original TUI entry (kept for reference; unused by the web build)
server/
  portal.js                spawns the exporter isolate, connects its console WS portal, parses snapshots
  bodies.js                the captured-body store: reassembles the streamed parts, serves them by id
  auth.js                  host login — yeet whoami / yeet login (scrapes the login URL)
  alerts.js                per-endpoint alert rules: status-tally diffing, cooldowns, delivery
  slack-alert.yeet.js      one-shot yeet script that calls yeet.alert (the only place it can run)
  index.js                 HTTP + SSE server: inline hydration, live iface switching, respawn
  markdown.js              the same pages as markdown for anything that isn't a browser
  decode.js                dechunk + gunzip a captured body (shared by alerts and markdown)
  public/                  index.html · style.css · app.js  (native dashboard, no framework/CDN)
docker/entrypoint.sh       mount a private bpffs → start yeetd → wait for socket → start the server
Dockerfile · Makefile      multi-stage build; one slim image (yeetd + server + probe)
```

### The yeet side

`agent/src/probes/` is the only BPF-aware code — it loads the object, attaches the two TC programs, and ships decoded `http_event`s over a ring buffer; `httptop.js` parses method + Host + path, pairs responses with requests for on-the-wire latency, and aggregates into reactive signals. `export.js` reads those signals and prints a JSON snapshot once a second (the endpoint table plus newly completed request/response pairs). The build points esbuild at `export.js` instead of the TUI's `main.jsx`, so the bundle *is* the exporter. For the capture internals, see [`httpinspect`](https://github.com/yeet-src/httpinspect).

### Alerts

Rules can be created from an endpoint's detail panel ("＋ Set alert") or from the **`alerts:` pill** in the top bar, which opens every rule at once — each row editable in place (condition, channel, quiet period), deletable, and showing when it last fired or why it failed. Clicking a rule's endpoint jumps to that endpoint. Editing a rule keeps its cooldown if it still watches the same thing, and resets it if you repoint it, so a rule can't inherit a quiet period it never earned.

`yeet.alert` only exists **inside** a yeet isolate — there's no CLI or HTTP equivalent — and the running exporter can't be told about new rules (no control channel into a live isolate, and restarting it would reset every counter). So rules live in the server and delivery is a one-shot `yeet run server/slack-alert.yeet.js` per notification, which buys runtime-editable rules for the cost of a process per alert.

**What an alert looks like.** It's a [Block Kit](https://api.slack.com/block-kit) message with a coloured bar down its left edge — red for server errors, amber for client errors, blue for one specific code — carrying a header that names the condition and the endpoint, the match count with an **Open in httpwatch** button beside it, **which status codes** it was (`500 ×2 · 503 ×1` — the thing a class-wide rule like *any 5xx* would otherwise never tell you), the endpoints that contributed as a bulleted list of up to ten with the rest counted, the response body if the rule asked for one, and a footer with the interface, the quiet period, and the time rendered in each reader's own timezone. A single-endpoint rule skips the list, since its header already says where.

**The button needs a routable URL.** Slack validates a button's target when the message is posted and refuses a hostname with no dot — `http://localhost:3000`, `http://httpwatch:8080`, a bare container or LAN name — which is exactly what the link is by default, since it's learned from the `Host` header. So the alert checks the URL first and falls back to an ordinary mrkdwn link, which Slack doesn't validate that way and which works just as well: it opens in the reader's own browser, and Slack never fetches it, so pointing at an internal address is fine. Set `PUBLIC_URL` to a dotted name or an IP to get the button. IPs and IPv6 literals pass.

The server passes those parts separately and the yeet script owns the layout, so the message can be restyled without touching detection. Slack validates presentation as a whole and rejects it as a whole, so delivery walks down a ladder — coloured with a button → coloured with a link → blocks with a button → blocks with a link → plain text — and logs any downgrade. The button is given up before the colour is: a refused URL is the likeliest rejection, and losing the colour, the codes and the endpoint list over a link that renders fine as text would be a bad trade. Being logged out, rate limited, or pointed at a channel that doesn't exist skips the ladder — a simpler message would fail identically.

**Bodies in alerts.** Tick *include the response body* on a rule and the alert carries the payload of one matching response, dechunked and gunzipped (a gzip cut short by the capture still yields its readable prefix), truncated to ~1200 chars. It's opt-in per rule because it posts that payload into a Slack channel, and **Slack has no spoiler markup** — nothing hides it behind a click the way Discord's `||…||` does. It goes in a preformatted block, which is the most contained thing Slack offers — and because that block carries literal text rather than markup, nothing in a payload can break out of it or be reinterpreted as formatting; if you'd rather not put payloads in the channel at all, leave it off and use the link. When there's no body to send, the alert says which reason it was — capture off, the body budget dropped it, or the body was evicted from the store before the alert fired — rather than looking like an empty response.

**Every alert links back.** `GET /?endpoint=<METHOD host path>` opens that endpoint's detail panel directly, and that's what the link in each alert points at — click it in Slack and you land on the failing route with its live request stream. The open endpoint is kept in the address bar too, so copying the URL shares what you're looking at, and back/forward work (`/detail?endpoint=…` is the same link, full screen). The base URL is learned from the `Host` header of a real browser request; set `PUBLIC_URL` when that guess would be wrong (behind a proxy, or for links that need to work off-network).

Detection diffs each snapshot's `endpoints[].status` tallies rather than reading the streamed request rows: the tallies are cumulative aggregates that never lose a response, while rows are subject to the per-frame row budget. A probe restart re-baselines instead of alerting on the reset — but cooldowns deliberately survive it, so toggling interfaces isn't a way around the throttle.

**Is Slack connected?** The exporter polls `yeet.caps()` every 30s (it's isolate-only, so nothing else can ask) and reports the providers in each snapshot. Both places a rule can be created — the endpoint popover and the rules dialog — say the same thing about it: **connected** → nothing to report; **definitely not** → a banner with a link to yeet.cx/settings, and the `alerts:` pill reads `N failing`; **unknown** (not logged in, call failed or timed out) → a softer note that delivery is unverified. Not-connected doesn't block creating rules — configuring alerts before wiring Slack is a normal order to work in, and a rule that can't deliver shows the reason on its row. Delivery is still attempted on *unknown*, because a capability hiccup must never silence alerting. Connecting Slack is picked up within 30s — no restart.

**Rules are persisted to a file on your host.** `make run` / `make up` bind-mount `~/.local/state/httpwatch` at `/data`, so the rules live in a plain file you can read, back up, edit or delete:

```
~/.local/state/httpwatch/alerts.json
```

It survives the container being stopped, deleted and recreated, and it's the authoritative copy — edit it while the container is down and the change is picked up on the next start. The container has to run as root (BPF), which would normally leave the file root-owned; `make` passes your uid so it's written back to you and stays editable. `make run STATE=/srv/httpwatch` puts it elsewhere, `STATE=httpwatch-data` (any name without a `/`) switches to a docker named volume instead, and deleting the file clears your rules.

There are **two files**, and the split is deliberate:

| file | what | who edits it |
| ---- | ---- | ------------ |
| `alerts.json` | the rules — endpoint, condition, channel, quiet period | **you** |
| `alerts.state.json` | when each rule last fired, and how often | the server |

Keeping timing out of the rules file is what lets it stay short enough to read, and persisting it separately is what stops a restart from re-opening every quiet period — without it, a container in a restart loop would alert on every loop. State is keyed by what a rule *is* (endpoint + condition) rather than by its id, so reordering the rules file or dropping ids never applies one rule's timing to another. Delete the state file to clear all cooldowns; delete a rule and its state is pruned with it.

The rules file is meant to be edited by hand. It carries only configuration (no counters or timestamps to get stale), explains itself in a `_readme` field, and skips any rule that doesn't validate rather than refusing to start. `id` can be omitted and `channel`/`cooldownSec` fall back to the defaults, so the minimum viable setup is one line:

```json
{ "rules": [ { "key": "*", "when": "5xx" } ] }
```

`key` is either an endpoint exactly as the dashboard shows it (`GET shop.internal /api/orders`) or `"*"` for **every endpoint**. A catchall keeps one cooldown for the whole rule, so a bad deploy across fifty routes is one message naming the worst offenders rather than fifty messages:

```
httpwatch: any 5xx on any endpoint
10 matching responses since the last alert across 3 endpoints:
GET shop.internal /api/orders ×7
POST auth.internal /login ×2
GET cdn.internal /a.js ×1
```

## Building from source

`make build` produces the image. The eBPF object and JS bundle compile **inside** the build via the vendored yeet toolchain (clang + bpftool + esbuild), so you need no system C/BPF toolchain and no local Node. It's multi-stage — the toolchain stays in the build stage, and the runtime image (`node:22-bookworm-slim` + yeetd) ships only the compiled probe, the bundle, and the server (~515 MB).

`vmlinux.h` is **committed** (unlike in `httpinspect`): the build sandbox has no `/sys/kernel/btf` to regenerate it, and CO-RE relocates the object to whatever kernel runs the container.

## Try it without real traffic

`agent/demo/` is `httpinspect`'s self-contained loopback traffic source, so you can watch the dashboard fill on a quiet box:

```sh
bash agent/demo/traffic.sh              # fake server + a steady request mix on 127.0.0.1:8731
make run IFACE=lo                       # in another shell: watch it on loopback
```

`traffic.sh` runs the whole thing — it starts `demo/server.py` itself, prints a heartbeat every couple of seconds, and on `Ctrl-C` stops the server and exits. Don't start `server.py` separately; the script refuses a port that's already busy rather than generating traffic for whatever else is listening. Move it with `PORT=9001`.

The routes it hits give the dashboard a spread of methods, hosts and latencies, with `/api/orders` failing about 8% of the time so there's something red to click. The bodies are one-liners, though — for exercising the response viewer, a route returning a real gzipped or chunked error is more interesting.

## What the dashboard reports

The captured heads and bodies stay in the server's memory and go to exactly two places you choose: your browser, and any Slack channel you point an alert at.

## Requirements

> [!IMPORTANT]
> - **A Linux host** (or a Linux VM you want to observe) with **BTF + TCX** (kernel **6.6+**) — the default on current Fedora, Arch, Ubuntu, and Debian 12+. CO-RE means no per-kernel recompile.
> - **Docker** that can grant the eBPF caps and lift AppArmor — the container runs with `SYS_ADMIN`, `NET_ADMIN`, `BPF`, `PERFMON`, `--security-opt apparmor=unconfined`, and `--pid=host --network=host` (no `--privileged`), plus a read-only mount of the host's kernel BTF. The bpffs is private to the container; nothing else is shared.
> - **macOS/Windows Docker Desktop** watches the VM, not your laptop — handy for inspecting your other containers, but for host-level capture use Linux. See [Running on macOS](#running-on-macos-docker-desktop).

## Community questions

**Do I have to clone the repo?** No — `docker run … ghcr.io/yeet-src/httpwatch:latest` runs the prebuilt image. Cloning is only for building or hacking.

**Does it need a proxy or sidecar?** No. It reads off the wire from the kernel's TC layer — nothing to route through, nothing to reconfigure.

**Why don't I see my HTTPS traffic?** It's encrypted before it hits the wire; at the TC layer there's no request line to parse. A fundamental limit, not a bug.

**Why `--network=host`?** So the probe attaches to your *host's* interfaces and the server binds your host's port. Without it you'd inspect an empty container network.

**Why did my counts reset?** You changed the watched interfaces in the UI, which restarts the probe.

## License

GPL-2.0. The vendored eBPF program under `agent/` declares `char LICENSE[] SEC("license") = "GPL"`, required for the kernel helpers it uses.

---

Built with [yeet](https://yeet.cx/docs/), a JS runtime for writing eBPF programs and live system dashboards on Linux, wrapped for the browser over a WebSocket-portal bridge.
