// SPDX-License-Identifier: GPL-2.0
//
// httptop — capture plaintext HTTP request lines at the TC layer.
//
// Attaches SchedCls programs to every host interface (incl. loopback) via TCX
// (ingress + egress). We locate the IP header by sniffing the link layer
// (Ethernet/loopback carry a 14-byte L2 header; tun/raw-IP devices carry none),
// then read payload bytes with the absolute `bpf_skb_load_bytes`, which copies
// across paged frags — the relative-to-network-header helper only sees the
// linear head and EFAULTs on the (usually paged) TCP payload.
//
// Cheap in-kernel filter: only segments whose payload *starts* with a known
// HTTP method token (a request) or "HTTP/" (a response status line) cross the
// ringbuf. ACKs and non-HTTP traffic never leave the kernel. Each event carries
// a monotonic kernel timestamp; JS pairs each response with the oldest pending
// request on the same flow to derive on-the-wire latency, and parses the status
// code. JS parses the request line + Host header from requests.
//
// Bodies: a captured message ships its start line + headers + as much body as
// the budget allows, so the UI can show what a 4xx/5xx actually said. Two things
// would otherwise cut a body short, and each has its own mechanism:
//
//   * A body spilling into *following segments* — those don't start with a
//     method or "HTTP/", so a request/response arms a short-lived per-flow entry
//     in `body_win` and the next in-order segment in that direction is forwarded
//     as a KIND_BODY continuation until the byte budget is spent. That costs one
//     hash lookup per data segment we'd otherwise have dropped.
//
//   * A body inside *one huge segment* — on loopback (64KB MTU) and with GSO a
//     single segment routinely carries far more than one ringbuf record holds.
//     So a segment is emitted as up to SEG_CHUNKS records of DATA_MAX bytes,
//     each stamped with the TCP sequence of its own first byte (which is also
//     what keeps the JS-side loopback dedup from collapsing siblings). That
//     puts a ~32KB ceiling on any ONE segment; a body spread over many segments
//     is limited by the continuation budget instead, not by this.
//
// Failed responses get a much larger continuation ceiling than successful ones,
// since a 500's body is the reason this data is captured at all. The status code
// is read straight off the start line — three bytes at a fixed offset, no scan.
// Parsing Content-Length here to stop exactly at the body's end was tried and
// removed: it can only run on a record we are holding a ringbuf reference to,
// and that suppresses verifier state pruning (see the note above the unrolled
// chunk emission). JS parses it off the captured head instead, which is where
// the "truncated, N of M bytes" report is produced anyway — so the only thing
// lost is stopping early on a response that never reaches its budget.
//
// Because those budgets are large, body bytes are also metered in aggregate by a
// coarse per-second token bucket (`rate_bytes`). The first chunk of every
// request/response is exempt from it, so a flood costs the bodies and never the
// endpoint table itself.
//
// How much of each direction is captured is a runtime knob (the `req_*`/`resp_*`
// globals below), patched from JS to match the --bodies mode — so with bodies
// off the extra bytes never leave the kernel at all. Response bodies are on by
// default; request bodies are opt-in, since that's where credentials live.
//
// Plaintext only: TLS payloads are ciphertext here, so HTTPS is not visible
// (that would need a uprobe on SSL_write/SSL_read). Both IPv4 and IPv6 are
// handled; IPv6 packets with extension headers (rare for TCP) are skipped.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define ETH_P_IP   0x0800
#define ETH_P_IPV6 0x86DD
#define L2_ETH     14          /* Ethernet / loopback link header */

#define TCX_NEXT (-1)          /* passive observer: run next prog / default-pass */

#define DATA_MAX   2048        /* must be a power of two (see mask below) */
#define CHUNK_MAX  (DATA_MAX - 1)
#define SEG_CHUNKS 16          /* records emitted from one segment, max (~32KB) */
#define MIN_REQ    16          /* "GET / HTTP/1.1\r\n" is already 16 bytes */

#define DIR_EGRESS  0
#define DIR_INGRESS 1

#define KIND_REQUEST  0
#define KIND_RESPONSE 1
#define KIND_BODY     2        /* continuation of the message before it */

#define F_TRUNC 1              /* flags: bytes of this segment were dropped */

#define REQ_CAP        512     /* enough for the request line + Host header */
#define RESP_CAP       16384   /* first segment of a response (head + body) */
#define BODY_EXTRA     49152   /* continuation bytes per message, max */
#define BODY_EXTRA_ERR 262144  /* …and for a 4xx/5xx, which is what we're here for */
#define RATE_BYTES     (8 << 20) /* aggregate body bytes per second, max */

/* Live knobs in .data, patched from JS at startup (see probes/probe.js) to match
 * the --bodies mode. They decide how much of each message crosses the ringbuf,
 * so turning bodies off is a real reduction in kernel→user traffic, not a
 * userspace filter. `*_extra` of 0 disables body-continuation capture for that
 * direction. Caps are masked to the data[] bound regardless of what JS writes,
 * so a bogus value can't overrun anything — it just gets clamped.
 *
 * The explicit section attribute matters: a zero-initialized global would
 * otherwise land in .bss, splitting the knobs across two sections that JS would
 * have to bind and patch separately — and silently moving between them whenever
 * a default changes to or from 0. Pinning all four to .data keeps it one bind. */
#define KNOB __attribute__((section(".data")))
KNOB __u32 req_cap        = REQ_CAP;
KNOB __u32 req_extra      = 0;     /* request bodies are opt-in (they hold secrets) */
KNOB __u32 resp_cap       = RESP_CAP;
KNOB __u32 resp_extra     = BODY_EXTRA;
KNOB __u32 resp_extra_err = BODY_EXTRA_ERR;
KNOB __u64 rate_bytes     = RATE_BYTES;

struct http_event {
    __u64 ts;           /* bpf_ktime_get_ns() at capture (monotonic) */
    __u16 sport;
    __u16 dport;
    __u32 seq;          /* TCP seq of this record's FIRST byte, not the segment's */
    __u8  family;       /* 4 or 6 */
    __u8  dir;
    __u8  kind;         /* KIND_REQUEST | KIND_RESPONSE | KIND_BODY */
    __u8  flags;        /* F_TRUNC: the rest of this segment was dropped */
    __u32 total_len;    /* payload bytes still on the wire from this record's start */
    __u32 captured;     /* bytes actually copied into data[] */
    __u8  data[DATA_MAX];
};
/* anchor so the struct survives into BTF for JS-side decoding */
__attribute__((used)) static const struct http_event __http_event_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 16 << 20);
} events SEC(".maps");

/* One direction of a flow — the same key a message and its body segments share
 * (they come from the same sender), and distinct from the reverse direction, so
 * a request's window and its response's window never collide. Ports only,
 * matching the flow identity JS already pairs on. */
struct flow_key {
    __u16 sport;        /* network order, straight off the wire */
    __u16 dport;
    __u8  family;
    __u8  pad[3];
};

/* How much of a message body is still wanted, and where it must start. */
struct body_state {
    __u32 next_seq;     /* host-order TCP seq the next wanted segment begins at */
    __u32 remaining;    /* continuation bytes still within budget (never 0) */
};

/* Armed by a request or a response, consumed by its continuation segments. LRU
 * so a flow that goes quiet mid-body is evicted instead of pinning an entry. */
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 8192);
    __type(key, struct flow_key);
    __type(value, struct body_state);
} body_win SEC(".maps");

/* Does the 8-byte prefix begin with an HTTP method token (method + space)? */
static __always_inline int is_http_request(const __u8 *m)
{
    if (m[0] == 'G' && m[1] == 'E' && m[2] == 'T' && m[3] == ' ') return 1;
    if (m[0] == 'P' && m[1] == 'U' && m[2] == 'T' && m[3] == ' ') return 1;
    if (m[0] == 'H' && m[1] == 'E' && m[2] == 'A' && m[3] == 'D' && m[4] == ' ') return 1;
    if (m[0] == 'P' && m[1] == 'O' && m[2] == 'S' && m[3] == 'T' && m[4] == ' ') return 1;
    if (m[0] == 'T' && m[1] == 'R' && m[2] == 'A' && m[3] == 'C' && m[4] == 'E' && m[5] == ' ') return 1;
    if (m[0] == 'P' && m[1] == 'A' && m[2] == 'T' && m[3] == 'C' && m[4] == 'H' && m[5] == ' ') return 1;
    if (m[0] == 'D' && m[1] == 'E' && m[2] == 'L' && m[3] == 'E' && m[4] == 'T' && m[5] == 'E' && m[6] == ' ') return 1;
    if (m[0] == 'O' && m[1] == 'P' && m[2] == 'T' && m[3] == 'I' && m[4] == 'O' && m[5] == 'N' && m[6] == 'S' && m[7] == ' ') return 1;
    if (m[0] == 'C' && m[1] == 'O' && m[2] == 'N' && m[3] == 'N' && m[4] == 'E' && m[5] == 'C' && m[6] == 'T' && m[7] == ' ') return 1;
    return 0;
}

/* Does the prefix begin with an HTTP response status line ("HTTP/")? */
static __always_inline int is_http_response(const __u8 *m)
{
    return m[0] == 'H' && m[1] == 'T' && m[2] == 'T' && m[3] == 'P' && m[4] == '/';
}

/* Aggregate ceiling on body bytes crossing the ringbuf, as a coarse one-second
 * token bucket. The per-message budgets below are large enough that a busy host
 * could otherwise push tens of MB/s through the ring; this caps that. The first
 * chunk of every request/response is exempt, so what a flood costs is bodies —
 * never the endpoint table. Deliberately racy across CPUs: it's a guard rail,
 * not an accountant, and being off by a segment costs nothing. */
static __u64 win_ns;      /* .bss: start of the current window */
static __u64 win_bytes;   /* …and what has been spent inside it */

static __always_inline int take_budget(__u32 n)
{
    __u64 now = bpf_ktime_get_ns();
    if (now - win_ns >= 1000000000ULL) {
        win_ns = now;
        win_bytes = 0;
    }
    if (win_bytes + n > rate_bytes)
        return 0;
    __sync_fetch_and_add(&win_bytes, (__u64)n);
    return 1;
}

/* Status code off a "HTTP/x.y SSS" start line, or 0 if those aren't digits. */
static __always_inline __u32 status_of(const __u8 *b, __u32 len)
{
    if (len < 12)
        return 0;
    __u8 a = b[9], c = b[10], d = b[11];
    if (a < '0' || a > '9' || c < '0' || c > '9' || d < '0' || d > '9')
        return 0;
    return (a - '0') * 100 + (c - '0') * 10 + (d - '0');
}

/* Copy `n` payload bytes at `off` into one ringbuf record and submit it.
 * Returns -1 if the ring is full or the copy failed — the caller then stops,
 * because everything after that would be stitched across a hole.
 *
 * `do_scan` is a literal at every call site, so reading the status code off the
 * start line compiles into the first record's copy only. */
static __always_inline int emit_chunk(struct __sk_buff *skb, __u32 poff, __u32 off,
                                      __u32 n, __u32 plen, __u32 seq_h,
                                      __u16 sport, __u16 dport, __u8 family, __u8 dir,
                                      __u8 kind, int trunc, int do_scan, __u32 *status)
{
    /* Re-derive n's bounds here, at the call that needs them. Every caller
       computes n as `rem < CHUNK_MAX ? rem : CHUNK_MAX`, so it is bounded by
       construction — but on Linux 6.6 that upper bound is lost when the value is
       spilled to the stack and reloaded (later kernels track the range through a
       32-bit spill; 6.6 does not). The load is then rejected with "R4 unbounded
       memory access, use 'var &= const' or 'if (var < const)'" — while `umin=1`,
       from the `if (rem)` guard, survives. So this is not a redundant clamp: it's
       the difference between loading and not loading on 6.6.
       (Verified: 6.6.144 rejected at 1585 insns; 6.12+ accept without it.)

       An AND with a constant is the one narrowing every verifier performs, and
       DATA_MAX is a power of two, so CHUNK_MAX is exactly its mask — this is a
       no-op at runtime. The AND can in principle yield 0, which no helper accepts
       as a size, so restore the lower bound too rather than leaving the next
       kernel to reject it from the other side.

       barrier_var first, and it is not optional: LLVM can prove n <= CHUNK_MAX
       from the caller's ternary, so a bare AND gets folded away or hoisted above
       the spill — measured, the object had the mask 68 times and not once at a
       load site, where r4 was still filled straight off the stack. The barrier
       makes n opaque at exactly this point, so the AND is emitted here, after the
       fill, which is the only place it buys anything. (Unlike the earlier
       barrier this file's notes reject: that one would have sat in a loop LLVM
       needed to unroll. The chunks are unrolled by hand now, so nothing
       structural depends on this staying asm-free.) */
    barrier_var(n);
    n &= CHUNK_MAX;
    if (!n)
        return -1;

    struct http_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return -1;
    if (bpf_skb_load_bytes(skb, poff + off, e->data, n) < 0) {
        bpf_ringbuf_discard(e, 0);
        return -1;
    }
    e->ts        = bpf_ktime_get_ns();
    e->sport     = bpf_ntohs(sport);
    e->dport     = bpf_ntohs(dport);
    e->seq       = seq_h + off;
    e->family    = family;
    e->dir       = dir;
    e->kind      = kind;
    e->flags     = trunc ? F_TRUNC : 0;
    e->total_len = plen - off;
    e->captured  = n;
    if (do_scan && kind == KIND_RESPONSE)
        *status = status_of(e->data, n);
    bpf_ringbuf_submit(e, 0);
    return 0;
}

/* One more record of the current segment, or nothing if the segment is spent.
 * A macro rather than a loop body on purpose — see the note at its use site. */
#define CHUNK_AFTER_FIRST                                                      \
    if (rem) {                                                                 \
        __u32 n = rem < CHUNK_MAX ? rem : CHUNK_MAX;                           \
        rem -= n;                                                              \
        if (emit_chunk(skb, poff, off, n, plen, seq_h, sport, dport, family,   \
                       dir, KIND_BODY, rem == 0 && off + n < plen, 0,          \
                       &status) < 0)                                           \
            rem = 0;             /* ring full: stop, and leave the window shut */ \
        else                                                                   \
            off += n;                                                          \
    }

static __always_inline int handle(struct __sk_buff *skb, __u8 dir)
{
    /* Locate the IP header. Prefer the Ethernet/loopback hypothesis (L2=14):
       its ethertype is unambiguous. Fall back to raw IP at offset 0 (tun). */
    __u32 l3;
    __u8  family;
    __u16 etype = 0;
    bpf_skb_load_bytes(skb, 12, &etype, 2);
    if (etype == bpf_htons(ETH_P_IP))        { l3 = L2_ETH; family = 4; }
    else if (etype == bpf_htons(ETH_P_IPV6)) { l3 = L2_ETH; family = 6; }
    else {
        __u8 b0 = 0;
        if (bpf_skb_load_bytes(skb, 0, &b0, 1) < 0)
            return TCX_NEXT;
        __u8 v = b0 >> 4;
        if (v == 4)      { l3 = 0; family = 4; }
        else if (v == 6) { l3 = 0; family = 6; }
        else return TCX_NEXT;
    }

    /* Advance to the TCP header. */
    __u32 l4;
    if (family == 4) {
        __u8 vihl = 0, proto = 0;
        if (bpf_skb_load_bytes(skb, l3, &vihl, 1) < 0)
            return TCX_NEXT;
        if ((vihl >> 4) != 4)
            return TCX_NEXT;
        __u32 ihl = (vihl & 0x0f) * 4;
        if (ihl < 20)
            return TCX_NEXT;
        if (bpf_skb_load_bytes(skb, l3 + 9, &proto, 1) < 0)
            return TCX_NEXT;
        if (proto != IPPROTO_TCP)
            return TCX_NEXT;
        l4 = l3 + ihl;
    } else {
        __u8 nexthdr = 0;
        if (bpf_skb_load_bytes(skb, l3 + 6, &nexthdr, 1) < 0)
            return TCX_NEXT;
        if (nexthdr != IPPROTO_TCP)          /* skip ext-header chains / non-TCP */
            return TCX_NEXT;
        l4 = l3 + 40;                        /* fixed IPv6 header */
    }

    __u16 sport = 0, dport = 0;
    __u32 seq = 0;
    __u8  doffb = 0;
    bpf_skb_load_bytes(skb, l4,      &sport, 2);
    bpf_skb_load_bytes(skb, l4 + 2,  &dport, 2);
    bpf_skb_load_bytes(skb, l4 + 4,  &seq,   4);
    if (bpf_skb_load_bytes(skb, l4 + 12, &doffb, 1) < 0)
        return TCX_NEXT;
    __u32 doff = (doffb >> 4) * 4;
    if (doff < 20)
        return TCX_NEXT;

    /* skb->len is the frag-safe total; using it sidesteps GSO (ip_tot==0). */
    __u32 poff = l4 + doff;
    if (skb->len <= poff)
        return TCX_NEXT;                     /* no payload (pure ACK/SYN) */
    __u32 plen = skb->len - poff;
    __u32 seq_h = bpf_ntohl(seq);

    /* Cheap in-kernel HTTP detection on the first 8 payload bytes. Too short to
       hold a start line? It can still be a body continuation — fall through. */
    __u8 kind = KIND_BODY;
    if (plen >= MIN_REQ) {
        __u8 m[8] = {};
        if (bpf_skb_load_bytes(skb, poff, m, sizeof(m)) < 0)
            return TCX_NEXT;
        if (is_http_request(m))       kind = KIND_REQUEST;
        else if (is_http_response(m)) kind = KIND_RESPONSE;
    }

    struct flow_key fk = { .sport = sport, .dport = dport, .family = family };

    /* Requests carry the line + Host header (parsed in JS), so cap them short
       to spare ringbuf bandwidth unless request bodies were asked for.
       A continuation only rides along while its message's budget lasts and it
       picks up exactly where the last captured segment ended — a retransmit or
       reorder fails that check and is dropped rather than mis-stitched. */
    struct body_state *st = NULL;
    __u32 limit;
    if (kind == KIND_REQUEST) {
        limit = req_cap;
    } else if (kind == KIND_RESPONSE) {
        limit = resp_cap;
    } else {
        st = bpf_map_lookup_elem(&body_win, &fk);
        if (!st)                             /* not HTTP, and no body expected */
            return TCX_NEXT;
        if (st->next_seq != seq_h)
            return TCX_NEXT;
        limit = st->remaining;
    }

    __u32 want = plen < limit ? plen : limit;
    if (want == 0)
        return TCX_NEXT;

    /* Meter the body portion up front rather than per chunk, so that running out
       stops on a boundary we can *flag* — a truncation the reader is told about,
       instead of a body that quietly ends early. The first chunk of a request or
       response is exempt: the endpoint table is made of start lines, and a flood
       must cost bodies, not the dashboard. */
    if (kind == KIND_BODY) {
        if (!take_budget(want)) {
            bpf_map_delete_elem(&body_win, &fk);
            return TCX_NEXT;
        }
    } else if (want > CHUNK_MAX && !take_budget(want - CHUNK_MAX)) {
        want = CHUNK_MAX;
    }

    /* Ship `want` bytes as up to SEG_CHUNKS records. A record's `seq` is the
       sequence number of its own first byte, so sibling chunks stay distinct for
       the JS-side loopback dedup and stitch back in wire order. `want` is
       already metered, so the planned last record carries F_TRUNC when the
       segment ran past it; a ringbuf that fills mid-loop is the one stop we
       can't flag, and the window logic below at least refuses to stitch the
       next segment across the hole it leaves.

       The first record is emitted *outside* the loop. It's the one that carries
       the start line and pays for the header scan, and leaving that scan inside
       the loop costs twice: LLVM won't unroll a loop containing another loop, and
       the verifier then re-walks the 1KB scan for every iteration state it
       explores — measured at 1000001 insns / 32682 states, over the 1M ceiling.
       Hoisted, the scan is verified once and the loop body is straight-line. */
    __u32 status = 0;
    __u32 rem = want;                        /* umin 1: `want == 0` returned above */
    __u32 n0 = rem < CHUNK_MAX ? rem : CHUNK_MAX;
    rem -= n0;

    if (emit_chunk(skb, poff, 0, n0, plen, seq_h, sport, dport, family, dir,
                   kind, rem == 0 && n0 < plen, kind != KIND_BODY, &status) < 0)
        return TCX_NEXT;
    __u32 off = n0;

    /* Loop on the remaining-bytes counter rather than on `off < want`. Comparing
       two opaque scalars tells the verifier nothing about their difference, so
       `want - off` reads as [0, 4G] and the load inside is rejected as a possible
       zero-sized read. Testing the single scalar `rem` refines it to umin 1 in
       the body, which makes n provably [1, CHUNK_MAX] — and needs no barrier_var,
       which matters because inline asm would block the unrolling too. */
    /* The remaining records, unrolled *by hand*.

       This has to be straight-line code, and neither `#pragma unroll` nor
       `#pragma clang loop unroll(full)` will do it — LLVM declines and warns
       ("loop not unrolled"). A rolled loop here doesn't merely cost more, it
       fails to load: bpf_ringbuf_reserve returns a *reference*, the verifier
       gives every state a fresh reference id, and an outstanding reference
       disables state pruning entirely. Each iteration therefore forks states
       that never merge back — the reference counter reached 43944 and the
       program blew the 1M instruction ceiling. Unrolled, each reserve is its own
       static instruction, verified once, and the cost is linear.

       Same reason the header scan that used to live in emit_chunk is gone: it
       ran on the record's bytes, i.e. while holding that reference, so its
       1024-iteration loop couldn't be pruned either. Content-Length is parsed in
       JS off the captured head instead, which is where the truncation report is
       produced anyway. */
    CHUNK_AFTER_FIRST;  /*  2 */ CHUNK_AFTER_FIRST;  /*  3 */
    CHUNK_AFTER_FIRST;  /*  4 */ CHUNK_AFTER_FIRST;  /*  5 */
    CHUNK_AFTER_FIRST;  /*  6 */ CHUNK_AFTER_FIRST;  /*  7 */
    CHUNK_AFTER_FIRST;  /*  8 */ CHUNK_AFTER_FIRST;  /*  9 */
    CHUNK_AFTER_FIRST;  /* 10 */ CHUNK_AFTER_FIRST;  /* 11 */
    CHUNK_AFTER_FIRST;  /* 12 */ CHUNK_AFTER_FIRST;  /* 13 */
    CHUNK_AFTER_FIRST;  /* 14 */ CHUNK_AFTER_FIRST;  /* 15 */
    CHUNK_AFTER_FIRST;  /* 16 */

    /* Continuations: advance the window only over a segment we took whole.
       Anything less means a hole, and a stitched body with a hole in it is worse
       than a short one — so the window closes instead. */
    if (kind == KIND_BODY) {
        if (off == plen && st->remaining > off) {
            st->next_seq = seq_h + plen;
            st->remaining -= off;
        } else {
            bpf_map_delete_elem(&body_win, &fk);
        }
        return TCX_NEXT;
    }

    /* Arm the continuation window for the rest of this message's body.
       `next_seq` is where the byte after this whole segment lands, so a body
       split across segments stitches back together in order, and the entry is
       dropped once its budget is spent. Requests and responses travel opposite
       directions, so their windows are separate entries and one map serves both.
       Always re-decided here — a message that wants no continuation *deletes*
       whatever the previous one on this flow left behind, or a 101 upgrade would
       inherit a window and slurp the protocol that follows as "body". */
    __u32 budget = 0;
    if (off == plen) {
        if (kind == KIND_REQUEST)
            budget = req_extra;
        else if (status != 101)              /* not HTTP any more after an upgrade */
            budget = status >= 400 ? resp_extra_err : resp_extra;
    }
    if (budget) {
        struct body_state ns = { .next_seq = seq_h + plen, .remaining = budget };
        bpf_map_update_elem(&body_win, &fk, &ns, BPF_ANY);
    } else {
        bpf_map_delete_elem(&body_win, &fk);
    }
    return TCX_NEXT;
}

SEC("tcx/ingress")
int on_ingress(struct __sk_buff *skb) { return handle(skb, DIR_INGRESS); }

SEC("tcx/egress")
int on_egress(struct __sk_buff *skb)  { return handle(skb, DIR_EGRESS); }

char LICENSE[] SEC("license") = "GPL";
