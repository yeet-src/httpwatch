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

**Learn it** — [HTTP-on-the-wire primer](#a-30-second-primer-on-http-on-the-wire) · [Use cases](#common-use-cases) · [What you're looking at](#what-youre-looking-at) · [How it works](#how-it-works)

**Reference** — [Building from source](#building-from-source) · [Try it without traffic](#try-it-without-real-traffic) · [Requirements](#requirements) · [Caveats](#honest-caveats) · [FAQ](#community-questions) · [License](#license)

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
  ghcr.io/yeet-src/httpwatch:latest      # → http://localhost:8080
```

`SYS_ADMIN` mounts the container-private bpffs, `NET_ADMIN` attaches the TCX programs, and `BPF`/`PERFMON` load the program and its maps. `apparmor=unconfined` lifts Docker's default profile, which otherwise denies the bpffs `mount` — it's the one thing `--privileged` relaxes that a capability can't. The read-only BTF mount (a world-readable kernel file, the only host mount) lets the probe CO-RE-relocate to your kernel.

Open **http://localhost:8080** (or `http://<host>:8080` over your network) and the table fills as plaintext HTTP flows. On Linux, add `sudo` if you're not in the `docker` group; on **macOS**, see [Running on macOS](#running-on-macos-docker-desktop).

Tune it with environment variables (`-e VAR=…`); the interface set is also editable live in the UI:

| var          | default       | meaning                                                              |
| ------------ | ------------- | -------------------------------------------------------------------- |
| `PORT`       | `8080`        | port the dashboard is served on (bound on the host — must be free)   |
| `IFACE`      | all up ifaces | comma-separated interfaces to watch, e.g. `lo,eth0` (initial set)    |
| `KEEP_QUERY` | off           | keep query strings distinct — `/x?id=1` and `/x?id=2` stay separate rows |
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
  ghcr.io/yeet-src/httpwatch:latest
```

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
- **Plaintext only.** It works because the bytes on the wire *are* the request. Under TLS the payload is ciphertext here, so HTTPS is invisible (see [caveats](#honest-caveats)).

## Common use cases

A ground-truth view of the plaintext HTTP crossing a host — from a browser, over the network, no terminal on the box:

- A service is slow — which endpoint is getting hammered, at what rate? Open its detail for the request stream and p95.
- Suspected retry storm or 5xx wave — sort by `REQ/S`, click the route, watch responses tick past color-coded.
- Auditing a remote box over your tailnet — what plaintext HTTP is flowing, and to which hosts, with no SSH or TUI.
- Local microservices over `lo` — see the chatter without instrumenting any of them.

## What you're looking at

A **top bar** with the watched interfaces (click the `iface:` pill to change them live) and a connection indicator; the **endpoints table**, one row per `METHOD host path` sorted busiest-first (click a header to re-sort, a row to open its detail); and a **footer** with totals — requests, endpoints, bytes on the wire, uptime.

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

Everything updates in place over SSE. Collapse the panel with the drawer icon or `Esc`.

## How it works

The eBPF capture is [`httpinspect`](https://github.com/yeet-src/httpinspect) verbatim, vendored under `agent/`. The one new piece is a headless entry that prints JSON instead of drawing a TUI; the rest is the node server and the browser app.

```
 ┌──────── Docker container (--cap-add SYS_ADMIN,NET_ADMIN,BPF,PERFMON · host pid+net) ───────┐
 │  yeetd ◄── privileged BPF load ── [ yeet isolate: the httpinspect exporter (agent/) ]      │
 │                                        │ probe.js + httptop.js  (unchanged capture)         │
 │                                        │ export.js  (NEW: samples signals → JSON/1s)        │
 │                                        ▼ console.log(JSON)                                  │
 │                                   yeet console WebSocket portal                             │
 │                                        │                                                    │
 │   node server ── connects as a ws client ── holds latest snapshot                          │
 │      :8080     ├─ GET /        dashboard HTML, snapshot inlined for instant hydration       │
 │                └─ GET /events  SSE: one snapshot per tick ─────────────► browser (DOM)      │
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
  auth.js                  host login — yeet whoami / yeet login (scrapes the login URL)
  index.js                 HTTP + SSE server: inline hydration, live iface switching, respawn
  public/                  index.html · style.css · app.js  (native dashboard, no framework/CDN)
docker/entrypoint.sh       mount a private bpffs → start yeetd → wait for socket → start the server
Dockerfile · Makefile      multi-stage build; one slim image (yeetd + server + probe)
```

### The yeet side

`agent/src/probes/` is the only BPF-aware code — it loads the object, attaches the two TC programs, and ships decoded `http_event`s over a ring buffer; `httptop.js` parses method + Host + path, pairs responses with requests for on-the-wire latency, and aggregates into reactive signals. `export.js` reads those signals and prints a JSON snapshot once a second (the endpoint table plus newly completed request/response pairs). The build points esbuild at `export.js` instead of the TUI's `main.jsx`, so the bundle *is* the exporter. For the capture internals, see [`httpinspect`](https://github.com/yeet-src/httpinspect).

## Building from source

`make build` produces the image. The eBPF object and JS bundle compile **inside** the build via the vendored yeet toolchain (clang + bpftool + esbuild), so you need no system C/BPF toolchain and no local Node. It's multi-stage — the toolchain stays in the build stage, and the runtime image (`node:22-bookworm-slim` + yeetd) ships only the compiled probe, the bundle, and the server (~515 MB).

`vmlinux.h` is **committed** (unlike in `httpinspect`): the build sandbox has no `/sys/kernel/btf` to regenerate it, and CO-RE relocates the object to whatever kernel runs the container.

## Try it without real traffic

`agent/demo/` is `httpinspect`'s self-contained loopback traffic source, so you can watch the dashboard fill on a quiet box:

```sh
python3 agent/demo/server.py &          # fake plaintext-HTTP server on 127.0.0.1:8731
PORT=8731 bash agent/demo/traffic.sh    # steady, weighted request mix over loopback
make run IFACE=lo                       # watch it on loopback
```

## Requirements

> [!IMPORTANT]
> - **A Linux host** (or a Linux VM you want to observe) with **BTF + TCX** (kernel **6.6+**) — the default on current Fedora, Arch, Ubuntu, and Debian 12+. CO-RE means no per-kernel recompile.
> - **Docker** that can grant the eBPF caps and lift AppArmor — the container runs with `SYS_ADMIN`, `NET_ADMIN`, `BPF`, `PERFMON`, `--security-opt apparmor=unconfined`, and `--pid=host --network=host` (no `--privileged`), plus a read-only mount of the host's kernel BTF. The bpffs is private to the container; nothing else is shared.
> - **macOS/Windows Docker Desktop** watches the VM, not your laptop — handy for inspecting your other containers, but for host-level capture use Linux. See [Running on macOS](#running-on-macos-docker-desktop).

## Honest caveats

> [!NOTE]
> `httpwatch` is observability, not enforcement — it tells you what crossed the wire, it doesn't stop or modify anything.

- **Plaintext HTTP only.** TLS payloads are ciphertext at this layer, so HTTPS is invisible. ([Contact us](https://yeet.cx) for custom yeet scripts.)
- **No bodies.** Only the endpoint table, status codes, and latency — the probe reads just the first ~512 bytes of a request (request line + headers) and the response status line.
- **The stream shows completed pairs.** A row appears once a response is matched to its request; request-only endpoints still count in the table but don't stream rows.
- **Latency is on-the-wire, not server-internal** — the request→response delta at this host's TC layer, so it includes network RTT for remote hosts. FIFO pairing is exact for ordered HTTP/1.x, approximate under pipelining.
- **Access is host-level, not per-visitor.** Anyone who can reach the port sees the dashboard — put real access control (tailnet, reverse-proxy auth) in front of it if you need per-user auth.
- **Switching interfaces restarts the probe,** so counts reset.
- **Under heavy load some segments may be missed,** so counts are a close lower bound, not an exact tally.

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
