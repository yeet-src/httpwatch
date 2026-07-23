# `httpinspect`

> **`top` for the HTTP endpoints on your host.** Every plaintext HTTP request crossing the box — decoded off the wire and ranked live in your terminal by traffic, rate, and latency. No proxy, no sidecar, no app changes.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-GPL--2.0-3DA639" alt="GPL-2.0">
  <a href="https://discord.gg/dYZu9PjKB"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <img src="assets/http-endpoint.gif" alt="httpinspect — a live HTTP endpoint dashboard in the terminal" width="820">
</p>

**`httpinspect` turns the HTTP requests crossing your host into a live `top`-style table** — every endpoint sorted by traffic, with a running request count, a per-second rate, and how long ago each was last hit. Open one and you get a focused detail screen: on-the-wire latency (p50 / p95 / max), status-code mix, and req/s and latency sparklines — all built on eBPF, all reading the bytes straight off the wire.

> [!TIP]
> **No proxy, no port to point at, no app changes.** `httpinspect` attaches eBPF programs at the TC layer and reads HTTP request lines straight off the wire as packets flow through the kernel — including loopback, so requests between local services are covered too. Your traffic is never intercepted, held, or delayed.

## Quick start

```sh
curl -fsSL https://yeet.cx | sh
make            # compile bin/probe.bpf.o + bundle the JS (toolchain auto-fetched)
yeet run .      # watch every up interface, including loopback
```
[Manual install guide](https://yeet.cx/docs/install/manual-installation) | Linux only

With any plaintext HTTP flowing on the box, that's it — `httpinspect` enumerates the up interfaces, attaches at the TC layer, and starts ranking endpoints. Flags tune what it watches and how it groups (pass them after `--`, so the runtime routes them to the script):

| flag             | default       | meaning                                                              |
| ---------------- | ------------- | -------------------------------------------------------------------- |
| `--iface=<list>` | all up ifaces | comma-separated interface names to watch, e.g. `--iface=lo,eth0`     |
| `--keep-query`   | off           | keep query strings distinct — `/x?id=1` and `/x?id=2` stay separate rows instead of collapsing into one |
| `--bodies=<mode>` | `response`   | which message bodies to capture: `none`, `response`, or `both`. Sets the kernel's capture sizes, so `none` really does stop the bytes at the kernel. `both` includes request bodies — those carry credentials, hence opt-in. Only the web UI displays bodies; the TUI shows aggregates either way |
| `--body-rate=<MB>` | `8`         | ceiling on captured body bytes per second, in aggregate. Start lines and headers are exempt, so hitting it costs bodies and never the endpoint table. Raise it on a host you're deliberately hammering |

```sh
yeet run . -- --iface lo,eth0   # only these interfaces
yeet run . -- --keep-query      # /x?id=1 and /x?id=2 stay separate rows
yeet run . -- --bodies both     # capture request bodies as well as responses
yeet run . -- --body-rate 32    # allow 32 MB/s of bodies instead of 8
```

Runs until `Ctrl-C`. Resize the terminal and the table reflows; needs a real terminal (it's a TUI — don't pipe or redirect the output).

## A 30-second primer on HTTP-on-the-wire

The mental model for what `httpinspect` reads:

**A request is text.** An HTTP/1.x request starts with a request line — `GET /path HTTP/1.1` — followed by headers, one per line, then a blank line. The very first bytes of the TCP payload *are* that line.

**The endpoint is `METHOD host path`.** The method and path come from the request line; the host comes from the `Host:` header (or the absolute-form target on a proxied/`CONNECT` request). `httpinspect` tallies traffic by that triple.

**Plaintext only.** This works because the bytes on the wire *are* the request. Under TLS (`https://`) the payload is ciphertext at this layer, so HTTPS is invisible — see the caveats.

## Common use cases

`httpinspect` is for anyone who wants a ground-truth picture of the plaintext HTTP actually crossing a host — not what an app's own access log claims it served.

- A service is slow. Which endpoint is getting hammered, and at what rate?
- You suspect a retry storm. Watch a path's `REQ/S` spike in real time.
- Auditing a box: what plaintext HTTP is actually flowing, and to which hosts?
- Local microservices talking over `lo` — see the chatter without instrumenting any of them.

## What you're looking at

```
httpinspect · iface: all (3) · plaintext HTTP only
 #  METHOD  HOST            PATH              COUNT   REQ/S   LAST
 1  GET     shop.internal   /api/products      1843    27     0s
 2  POST    auth.internal   /login              512     4      1s
 3  GET     shop.internal   /health             318     ·      3s
```

A **status bar** names the app, the interfaces being watched, and a reminder that this is plaintext HTTP only. The **table** is one row per `METHOD host path` endpoint, sorted by total count (busiest first), capped to what fits the terminal. The **footer** carries total requests, distinct endpoints, total bytes seen on the wire, and uptime.

| column   | meaning                                                          |
| -------- | --------------------------------------------------------------- |
| `#`      | rank by total count                                             |
| `METHOD` | HTTP method, color-coded (GET, POST, PUT, …)                    |
| `HOST`   | `Host:` header (or authority from an absolute-form target)      |
| `PATH`   | request path; query string collapsed unless `--keep-query`      |
| `COUNT`  | cumulative requests seen for this endpoint                      |
| `REQ/S`  | requests in the last second (`·` when idle)                     |
| `LAST`   | how long ago this endpoint was last hit                         |

Colors come from yeet's terminal styling and no-op to plain text when stdout isn't a TTY — but `httpinspect` is a TUI and needs a real terminal, so it refuses to run piped or redirected rather than render garbage.

## Navigation

The dashboard is interactive:

| key                        | action                                              |
| -------------------------- | --------------------------------------------------- |
| `↑` / `↓` (or `k` / `j`)   | move the selection up/down the endpoint list        |
| `PgUp` / `PgDn`            | jump ten rows                                       |
| `Enter`                    | open the **detail screen** for the highlighted endpoint |
| `Esc` (or `←`)             | return to the list                                  |
| `q`                        | back to the list (in detail) / quit (in the list)   |
| `Ctrl-C`                   | quit                                                |

The **detail screen** is a focused, live breakdown of one `METHOD host path` endpoint:

- total requests and its share of all traffic, current and peak req/s
- **latency** (p50 / p95 / max) — derived by pairing each response with its request on the wire (see below)
- **status codes** seen, color-coded by class (2xx/3xx/4xx/5xx)
- bytes on the wire, first/last-seen ages
- block sparklines of req/s and of recent response latency

It updates in place as new traffic arrives — no need to back out and re-enter.

## How it works

The project follows the standard yeet-script layout: `src/probes/` is the only BPF-aware code (it owns the object and exposes plain signals), `src/components/` is pure presentation that reads those signals, and `src/lib/` is pure helpers. They reference each other through the `@/` source alias; `src/main.jsx` wires them together and owns input.

```
src/bpf/httptop.bpf.c    TC programs: detect + capture HTTP segments → ringbuf
src/probes/probe.js      loads the shared BPF object, attaches TCX, exposes `control`
src/probes/httptop.js    ingest: parse, pair responses for latency, aggregate → signals
src/lib/format.js        formatters, method colors, column widths, sparkline (pure)
src/components/*.jsx     pure UI: statusbar, list, detail, footer, legend
src/main.jsx             entry: tty guard, navigation, mount, key input
bin/probe.bpf.o          the linked BPF object lands here (built by `make`)
demo/                    fake server + load generator for the recording
```

### The BPF side

A single BPF object attaches two TC (`tcx`) programs, auto-attached on `start()` by their `SEC()` names, and ships decoded events to userspace over a ring buffer:

| program      | hook           | what it captures                                                       |
| ------------ | -------------- | ---------------------------------------------------------------------- |
| `on_ingress` | `tcx/ingress`  | inbound TCP segments — requests arriving / responses returning         |
| `on_egress`  | `tcx/egress`   | outbound TCP segments — requests this host sends / responses it serves |

For each segment the program does a cheap in-kernel check on the first payload bytes: does it begin with an HTTP method token (`GET `, `POST `, …) — a **request** — or with `HTTP/` — a **response** status line? Only those two cross the ring buffer; ACKs and non-HTTP traffic are dropped in the kernel. Every event carries a monotonic kernel timestamp.

How much of each message crosses the ringbuf is set by globals in `.data` (`req_cap`, `req_extra`, `resp_cap`, `resp_extra`, `resp_extra_err`, `rate_bytes`), patched from JS at startup to match `--bodies` — so turning bodies off is a real reduction in kernel→user traffic rather than a userspace filter. `*_cap` is the first segment of a message, `*_extra` the continuation budget after it. Without bodies, a request is capped at 512 bytes (the line + `Host` is all the table needs) and a response at 128 (the status line).

> [!NOTE]
> The verifier, not the kernel API, is what shapes this file. Two rules earned the hard way, both from the same root cause — **an outstanding `bpf_ringbuf_reserve` reference disables state pruning**: don't reserve inside a rolled loop, and don't run a scan over a reserved record's bytes. Either one takes an otherwise-fine program past the 1M instruction ceiling. `make veristat` needs root; without it, `yeet run agent` against a running daemon prints the whole verifier log, and the line that matters is the last one.

Two separate things would otherwise cut a body short, and each has its own mechanism.

**A body spilling into later segments** wouldn't be recognized on its own (it doesn't start with a method or `HTTP/`), so a captured message arms a per-flow entry in the `body_win` LRU map: the next **in-order** segment in that direction is forwarded as a third event kind, `KIND_BODY`, until the byte budget is spent. Requests and responses travel opposite directions, so their windows are separate entries and one map serves both. Out-of-order or retransmitted segments fail the sequence check and are dropped rather than mis-stitched, and the next message on a keep-alive flow replaces the entry.

**A body inside one huge segment** is the loopback case, and it used to be the binding limit: `lo` has a 64KB MTU and with GSO a single segment routinely carries far more than one `DATA_MAX` record holds, so everything past the first 2KB was skipped. A segment is now emitted as up to `SEG_CHUNKS` records, each stamped with the TCP sequence of **its own first byte** — which is also what keeps the JS-side loopback dedup (keyed on flow + seq) from collapsing siblings. That caps any *single* segment at ~32KB; a body spread across many segments is bounded by the continuation budget instead, so on a normal 1500-byte-MTU link this ceiling never binds.

Those records are emitted by a **hand-unrolled** sequence, not a loop, and that is load-bearing rather than a micro-optimization. `bpf_ringbuf_reserve` hands back a *reference*; the verifier assigns every state a fresh reference id and switches off state pruning while one is outstanding, so a rolled loop forks states that never merge — this program hit 43944 reference ids and blew the 1M instruction ceiling before it was unrolled. Neither `#pragma unroll` nor `#pragma clang loop unroll(full)` will do it for you here (LLVM declines and warns), hence the macro.

A 4xx/5xx gets a much larger continuation ceiling (`resp_extra_err`) than a success — an error's body is the reason any of this is captured. The status code is read straight off the start line, three bytes at a fixed offset. A `101` response arms no window at all, or the protocol that replaces HTTP after the upgrade would be slurped in as "body".

Parsing `Content-Length` in-kernel to stop exactly at the body's end was tried and removed: it can only run against a record we are already holding a ringbuf reference to, which is the same pruning problem, and on its own it exceeded the instruction ceiling. JS parses it off the captured head instead — which is where the "truncated, N of M bytes" report comes from anyway — so what's actually lost is only stopping *early* on a response that never reaches its budget.

Because those budgets are large, body bytes are also metered in aggregate by a coarse per-second token bucket (`rate_bytes`, `--body-rate`). The first record of every request and response is exempt from it, so a flood costs bodies and never the endpoint table.

The knobs are also the reason the section attribute on those globals matters: a zero-initialized global would land in `.bss` instead, splitting the knobs across two sections — and silently moving between them whenever a default changes to or from `0`.

The one map carrying data to userspace is `events` — a `RINGBUF` bound by its `btf_struct` (`http_event`), one decoded record per captured chunk (a small segment is one record; a big one is several). `probe.data` is bound as a data section so JS can write the capture knobs; `body_win` is kernel-internal state, so JS never binds it.

### The JS side

The dashboard runs in yeet's V8 runtime, subscribing to that ring buffer and rendering the terminal UI with `yeet:tui`:

| file                    | responsibility                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `src/probes/probe.js`   | interface discovery, BPF load + TCX attach; exports the shared `control` and the iface label     |
| `src/probes/httptop.js` | request/response ingest, latency pairing, status tally, body stitching, rate ticks → the `rows` / `tick` signals |
| `src/lib/format.js`     | formatters, method colors, column widths, sparkline (pure)                                       |
| `src/components/*.jsx`  | the list and endpoint-detail screens, status bar, footer, legend (pure UI reading signals)       |
| `src/main.jsx`          | tty guard, selection/navigation state, mount, key input                                          |

In userspace, each response is paired with the oldest unmatched request on the same flow — the unordered port pair, since a response travels the reverse direction. The timestamp delta is the **on-the-wire latency**, and the status line gives the **code**; both are aggregated per endpoint.

### Why TC, not a proxy or a syscall wrapper

Reading requests at the TC layer means there's nothing to point traffic through and no app to reconfigure — the programs observe and copy request segments as the kernel moves them, including loopback, so local service-to-service chatter is covered without instrumenting anything. And because the method/`HTTP/` check happens in the kernel, ACKs and non-HTTP traffic never cost a ring-buffer write.

## Building from source

```sh
make           # build bin/probe.bpf.o (clang + bpftool) + bundle the JS (esbuild)
make bpf       # just the BPF object
make bundle    # just the JS bundle (src/main.jsx -> src/index.jsx)
make clean     # remove build artifacts
```

`make` runs two independent compilers: **clang + bpftool** compile every `src/bpf/*.bpf.c` and link them into one loadable object `bin/probe.bpf.o`; **esbuild** bundles `src/main.jsx` into `src/index.jsx`, resolving the `@/` alias and leaving `yeet:*` builtins external. The toolchain (clang, bpftool, esbuild) is fetched into a per-machine cache on first build — no system C/BPF toolchain and no Node/npm required. The generated CO-RE header `src/bpf/include/vmlinux.h` and `bin/` are build artifacts (gitignored).

`#/` (project root) and `@/` (source root) are **bundle-time aliases** that esbuild resolves via `tsconfig` `paths`; the runtime resolver doesn't know them, which is why the BPF object is located with `import.meta.dirname` in `probes/probe.js`.

## Testing across kernels

A BPF program that loads on your laptop can be rejected by an older kernel's verifier. Run `make veristat` to load `bin/probe.bpf.o` with veristat on **your** kernel — a quick check that every program passes, plus per-program complexity. Loading programs needs privileges, so use `sudo`.

`.github/workflows/kernel-matrix.yml` runs the same check across a matrix of kernels in CI (booting each in a VM and running veristat against the object), and `make veristat-matrix` runs that matrix locally on Linux + KVM. See the comments in `build/bpf.mk` for tuning the kernel set.

## Try it without real traffic

`demo/` is a self-contained traffic source so you can see the dashboard fill on a quiet box:

```sh
bash demo/traffic.sh                # starts the fake server AND the request mix
yeet run . -- --iface lo            # in another shell: watch it on loopback
```

`traffic.sh` owns the whole demo: it starts `demo/server.py` itself, waits for it, sends a steady weighted mix over loopback, prints a heartbeat every couple of seconds, and on `Ctrl-C` (or `SIGTERM`) stops the server and exits. Don't start `server.py` separately — the script refuses to run if the port is already busy, rather than quietly generating traffic for whatever else is listening. `PORT=9001 bash demo/traffic.sh` moves it.

`demo/record.sh` drives the same setup under `termgif` to regenerate `assets/http-endpoint.gif`.

## Requirements

> [!IMPORTANT]
> Linux with **BTF** (`CONFIG_DEBUG_INFO_BTF=y`) — needed to generate `vmlinux.h` and for the TC context structs the programs read. Default on current Arch, Fedora, Ubuntu, and Debian 12+. CO-RE means no per-kernel recompile.
>
> A reasonably recent kernel with **TCX** support (`tcx` links, Linux 6.6+), plus the yeet daemon, which handles the privileged BPF load. `curl -fsSL https://yeet.cx | sh` installs it.

## Honest caveats

> [!NOTE]
> `httpinspect` is observability, not enforcement. It tells you what crossed the wire; it does not stop, hold, or modify anything.

- **Plaintext HTTP only.** TLS payloads are ciphertext at this layer, so HTTPS is invisible. Capturing it would need a uprobe on `SSL_write`/`SSL_read`, which is a different tool. ([contact us](https://yeet.cx/?utm_source=github&utm_medium=readme&utm_campaign=httpinspect&utm_content=caveats-tls) for custom yeet scripts)
- Only the captured prefix (512 bytes) of each request is parsed for the table — enough for the request line and `Host` header. With `--bodies=both` the request is captured in full like a response; with anything else request bodies never leave the kernel.
- Bodies are **bounded by a budget rather than by a segment**: ~64KB per message, ~256KB for a 4xx/5xx, ~32KB from any single segment (the loopback case), and metered to `--body-rate` MB/s in aggregate. What doesn't fit is truncated and flagged as such — the UI reports how much of the sender's `Content-Length` you're actually looking at — never silently shortened. The TUI shows only the aggregates; reading an individual message is a web-UI feature.
- The exporter's output goes out as console lines, and **this transport silently drops a line over ~256KB** — measured: 254KB frames arrive, materially larger ones never appear, with no error at either end. That ceiling is per *line*, not per second, so bodies travel as their own `part` lines rather than inside the snapshot: a body is bounded by what one line holds, and the server reassembles the parts into a store the browser reads with `GET /api/body/<id>`. The snapshot itself only carries rows, held under `FRAME_MAX` (192KB, leaving margin because the failure is silent); rows that don't fit are counted in `recentDropped` rather than disappearing, and an exchange whose body missed the per-tick budget is flagged `nopv` so the UI can say why.
- **Latency is on-the-wire, not server-internal.** It's the time between the request and response segments as seen at this host's TC layer, so it includes network RTT for remote hosts. Responses are paired to requests FIFO per flow, which is correct for ordered HTTP/1.x but approximate under pipelining; unmatched requests are dropped after 10s.
- Loopback packets are seen twice (egress and ingress on `lo`); identical 4-tuple+seq sightings are de-duplicated so they're not double-counted.
- Under heavy load or a slow link, some segments may not be captured, so counts are a close lower bound rather than an exact tally.
- IPv6 packets carrying TCP behind extension-header chains (rare) are skipped.

## Community questions

**Does this need a proxy or a sidecar?**
No. `httpinspect` reads requests off the wire from inside the kernel's TC layer, so there's nothing to point traffic through and no app to reconfigure.

**Will it slow down or intercept my traffic?**
No. The programs observe and copy request segments; they don't hold, modify, or redirect packets.

**Why don't I see my HTTPS traffic?**
Because it's encrypted before it hits the wire. At the TC layer the payload is ciphertext, so there's no request line to parse. That's a fundamental limit of capturing here, not a bug.

**Why is a local service showing as `127.0.0.1:port`?**
That's the `Host:` header the client sent. Services addressed by name show their name; those addressed by IP show the IP.

**Can I get a quick check without the full TUI?**
Yes. `yeet run src/probes/probe.js` attaches the probe, aggregates for ~4s, and prints the counts before exiting — a headless sanity check of the capture + parse pipeline.

## License

GPL-2.0. The BPF program declares `char LICENSE[] SEC("license") = "GPL"` in [`src/bpf/httptop.bpf.c`](src/bpf/httptop.bpf.c), required for the kernel helpers it uses.

---

Built with [yeet](https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=httpinspect), a JS runtime for writing eBPF programs and live system dashboards on Linux. Join us on [discord](https://discord.gg/dYZu9PjKB?utm_source=github&utm_medium=readme&utm_campaign=httpinspect).
