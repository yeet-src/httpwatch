// Per-endpoint alert rules, evaluated here in the server and delivered through
// a one-shot yeet script (see slack-alert.yeet.js for why delivery works that way).
//
// Detection reads each snapshot's `endpoints[].status` tallies rather than the
// streamed `recent` rows. That matters: rows are subject to the exporter's
// per-frame row budget and can be dropped under load, while the status
// tallies are cumulative aggregates that never lose a response. Diffing two
// consecutive snapshots therefore gives the exact number of new responses per
// code, even on a busy host.
//
// Rules are matched on the endpoint key (`METHOD host path`), the same key the
// table and detail panel use — or on `"*"`, which watches every endpoint. A
// catchall keeps one cooldown for the whole rule rather than one per endpoint,
// so a bad deploy across fifty routes is one Slack message that names the worst
// offenders, not fifty messages.

import { spawn } from "node:child_process";
import { chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { captured, decodeCaptured } from "./decode.js";

/* Bodies for `includeBody` rules come from the snapshot's streamed rows, not
 * from the status tallies detection uses — the tallies are counts, they carry no
 * payload. Kept per endpoint, newest first, and only while some rule actually
 * wants one, so the common case costs nothing. */
const BODIES_PER_ENDPOINT = 2;
const BODY_ENDPOINTS_MAX = 400;
/* What goes in a Slack message. Slack's own limit is 3000 chars per section, and
 * an alert is a pointer to the dashboard, not a log viewer. */
const BODY_SNIPPET_MAX = 1200;
/* How many endpoints an alert names individually before the rest become a count.
 * Ten is about as long a list as anyone reads in a channel, and a catchall over
 * a broken deploy can name hundreds. */
const HITS_SHOWN = 10;

/** Conditions a rule can watch. Each maps a status code to yes/no. */
const CONDITIONS = {
  "5xx": { label: "any 5xx", test: (c) => c >= 500 && c <= 599 },
  "4xx": { label: "any 4xx", test: (c) => c >= 400 && c <= 499 },
  error: { label: "any 4xx or 5xx", test: (c) => c >= 400 },
  code: { label: "a specific code", test: (c, rule) => c === rule.code },
};

/* How an alert presents itself, by condition: the emoji on its header and the
 * colour of the bar down its left edge. Both exist for the same reason — telling
 * a server-error alert from a client-error one while scrolling a channel, before
 * reading a word of it. Colours are muted on purpose; they sit next to a wall of
 * ordinary messages and shouldn't read as a UI. */
const SEVERITY = {
  "5xx":  { icon: "🚨", color: "#c0392b" },
  error:  { icon: "🚨", color: "#c0392b" },
  "4xx":  { icon: "⚠️", color: "#d9822b" },
  code:   { icon: "🔔", color: "#4a7ba7" },
};

/** A rule keyed to this instead of an endpoint watches every endpoint. */
export const ANY_ENDPOINT = "*";

/* Two files, on purpose:
 *
 *   alerts.json        rules — configuration, hand-editable, the input
 *   alerts.state.json  runtime — when each rule last fired, machine-owned
 *
 * Keeping them apart is what lets the rules file stay short enough to read and
 * safe to edit, and it's also what lets cooldowns survive a restart: without
 * persisted state, restarting 10s after an alert would fire the next match
 * immediately, and a container in a restart loop would spam the channel.
 *
 * State is keyed by what a rule *is* (endpoint + condition), not by its id, so
 * hand-editing the rules file — reordering it, dropping ids, letting them get
 * reassigned — doesn't misapply someone else's timing to your rule. */
const STATE_README = "Runtime state written by httpwatch (alert timing). Not meant " +
  "for editing — delete it to clear cooldowns and fired counts. Rules live in the other file.";

/* Written at the top of the rules file. It's a config file people edit by hand,
 * so it explains itself; anything unrecognized at the top level is ignored. */
const FILE_README =
  "httpwatch alert rules — safe to edit by hand while the container is stopped; " +
  "they load on start. key: \"METHOD host path\" exactly as shown in the dashboard, " +
  "or \"*\" for every endpoint. when: \"5xx\" | \"4xx\" | \"error\" (4xx+5xx) | " +
  "\"code\" (then set code: 503). cooldownSec: minimum seconds between alerts for " +
  "this rule; matches during the quiet period are counted and reported in the next one. " +
  "includeBody: true also posts the matching response body into the channel. " +
  "id may be omitted and one will be assigned. A rule that fails to validate is skipped. " +
  "Alert timing lives in the .state.json file beside this one — this file is only configuration.";

export const CONDITION_KEYS = Object.keys(CONDITIONS);

const DEFAULT_COOLDOWN_SEC = 300;
const MIN_COOLDOWN_SEC = 10;
const MAX_RULES = 100;

/**
 * @param {object} opts
 * @param {string} opts.yeetBin
 * @param {string} opts.scriptPath   path to slack-alert.yeet.js
 * @param {string} [opts.socket]
 * @param {string} [opts.userSocket]
 * @param {string} [opts.defaultChannel]
 * @param {string} [opts.file]       where to persist rules (best effort)
 * @param {() => boolean} [opts.isLoggedIn]  yeet.alert needs a logged-in host
 * @param {() => string|null} [opts.ifaceLabel]  for alert context
 */
export function createAlerts(opts) {
  const {
    yeetBin, scriptPath, socket, userSocket,
    defaultChannel = "#alerts", file,
    // Runtime state sits beside the rules, named after them, so a custom
    // ALERTS_FILE keeps its pair together: foo.json → foo.state.json.
    stateFile = file ? `${file.replace(/\.json$/i, "")}.state.json` : null,
    isLoggedIn = () => true,
    ifaceLabel = () => null,
    slackConnected = () => null,
    // Builds a dashboard URL for an endpoint, when the server knows its own
    // address. Absent (or returning null) simply means no link in the alert.
    linkFor = null,
    // Reads one exchange out of the captured-body store (bodies.js), by the id
    // its snapshot row carries. Only `includeBody` rules ever call it.
    bodyOf = () => null,
  } = opts;

  /** id -> rule. A rule is {id, key, when, code, channel, cooldownSec, …state} */
  const rules = new Map();
  /** endpoint key -> { code: count } from the previous snapshot */
  let prevStatus = new Map();
  let nextId = 1;
  let saveWarned = false;
  let stateWarned = false;
  let seeded = false;   // has a baseline snapshot been taken? (see evaluate)
  // Who should own the persisted file (see save()). Absent → leave it alone.
  const stateUid = /^\d+$/.test(process.env.STATE_UID || "") ? Number(process.env.STATE_UID) : null;
  const stateGid = /^\d+$/.test(process.env.STATE_GID || "") ? Number(process.env.STATE_GID) : stateUid;

  load();
  loadState();

  /** What a rule *is*, for matching persisted state to it across id changes.
   *  A function declaration, not a const: loadState() above runs before a
   *  const would be initialized. */
  function identityOf(r) { return `${r.key} ${r.when} ${r.code ?? ""}`; }

  // ── bodies for includeBody rules ──────────────────────────────────────────
  /** endpoint key -> [{ ts, code, id }] newest first. Only the *reference* is
   *  kept here: the payload itself lives in the body store (bodies.js), which
   *  the snapshot rows point at by id. Holding a second copy of every failing
   *  body just so a rule might use one would double the memory for nothing. */
  const bodyRefs = new Map();

  const wantsBodies = () => {
    for (const r of rules.values()) if (r.includeBody) return true;
    return false;
  };

  /** Note which exchanges this snapshot's rows point at, per endpoint. */
  function rememberBodies(snapshot) {
    for (const row of snapshot?.recent || []) {
      if (row.id === undefined || row.rs === undefined) continue; // no response body captured
      let list = bodyRefs.get(row.key);
      if (!list) { list = []; bodyRefs.set(row.key, list); }
      list.unshift({ ts: row.ts, code: row.code, id: row.id });
      if (list.length > BODIES_PER_ENDPOINT) list.length = BODIES_PER_ENDPOINT;
    }
    // Bound the map: drop whatever hasn't been seen for longest.
    while (bodyRefs.size > BODY_ENDPOINTS_MAX) bodyRefs.delete(bodyRefs.keys().next().value);
  }

  /** The newest remembered response for `keys` that this rule would match. */
  function bodyFor(rule, keys) {
    const cond = CONDITIONS[rule.when];
    let best = null;
    for (const key of keys) {
      for (const b of bodyRefs.get(key) || []) {
        if (!cond.test(b.code, rule)) continue;
        if (!best || b.ts > best.ts) best = { ...b, key };
      }
    }
    return best;
  }

  /** Pull a remembered exchange's response out of the body store, as bytes.
   *  It may be gone — the store is bounded and a busy host recycles it — which
   *  is a different thing from "there was no body", so it's a distinct answer. */
  function resolveBody(ref) {
    return captured(ref && bodyOf(ref.id)?.res);
  }

  function load() {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const r of saved.rules || []) {
        // Re-validate on load: the file is editable, and a bad rule shouldn't
        // take the server down or alert on something unintended.
        const v = validate(r);
        if (v.error) continue;
        // Assign the id BEFORE keying the map. Hand-written rules routinely have
        // no id, and keying on the validated (empty) one collapsed every such
        // rule onto the same entry — so only the last survived, and it couldn't
        // be deleted. Duplicated ids in the file get renumbered for the same
        // reason.
        const id = r.id != null && String(r.id) !== "" && !rules.has(String(r.id))
          ? String(r.id)
          : String(nextId++);
        rules.set(id, { ...v.rule, id });
        nextId = Math.max(nextId, Number(id) + 1 || nextId);
      }
      if (rules.size) console.log(`[alerts] loaded ${rules.size} rule(s) from ${file}`);
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`[alerts] could not read ${file}: ${err.message}`);
    }
  }

  /* Restore alert timing so a restart doesn't reset every cooldown. Note what is
   * deliberately NOT restored: the count of matches suppressed during a quiet
   * period, and the per-endpoint baseline. Both describe the *previous* probe's
   * counters, which restart at zero, so carrying them over would misreport. */
  function loadState() {
    if (!stateFile) return;
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      let restored = 0;
      for (const rule of rules.values()) {
        const st = (saved.rules || {})[identityOf(rule)];
        if (!st) continue;
        if (Number.isFinite(st.lastFiredAt)) rule.lastFiredAt = st.lastFiredAt;
        if (Number.isFinite(st.firedCount)) rule.firedCount = st.firedCount;
        if (typeof st.lastError === "string") rule.lastError = st.lastError;
        restored++;
      }
      if (restored) console.log(`[alerts] restored timing for ${restored} rule(s) from ${stateFile}`);
    } catch (err) {
      // A missing or corrupt state file is not a problem worth failing over:
      // the rules still work, they just start with their cooldowns clear.
      if (err.code !== "ENOENT") console.error(`[alerts] ignoring unreadable ${stateFile}: ${err.message}`);
    }
  }

  /* Written when a rule fires or a delivery resolves — at most once per cooldown
   * per rule, so this stays quiet even with a hundred rules. */
  function saveState() {
    if (!stateFile) return;
    try {
      const byRule = {};
      for (const rule of rules.values()) {
        if (rule.lastFiredAt == null && !rule.lastError) continue; // nothing to say yet
        byRule[identityOf(rule)] = {
          lastFiredAt: rule.lastFiredAt,
          firedCount: rule.firedCount,
          ...(rule.lastError ? { lastError: rule.lastError } : {}),
        };
      }
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ _readme: STATE_README, rules: byRule }, null, 2) + "\n");
      if (stateUid !== null) {
        try { chownSync(stateFile, stateUid, stateGid); } catch { /* not root, or a docker volume */ }
      }
    } catch (err) {
      if (!stateWarned) {
        stateWarned = true;
        console.error(`[alerts] could not write ${stateFile}: ${err.message}`);
        console.error("[alerts] cooldowns will reset on restart (rules themselves are unaffected)");
      }
    }
  }

  /* What actually goes in the file: the rule's configuration, nothing else.
   * Runtime state (fired counts, cooldown timing, last error) is deliberately
   * left out — it's reset on load anyway, and a config file people edit by hand
   * shouldn't be cluttered with fields that get ignored. */
  function configOf(r) {
    const out = { id: r.id, key: r.key, when: r.when };
    if (r.when === "code") out.code = r.code;
    out.channel = r.channel;
    out.cooldownSec = r.cooldownSec;
    if (r.includeBody) out.includeBody = true;
    out.createdAt = r.createdAt;
    return out;
  }

  function save() {
    if (!file) return;
    try {
      // The usual home for this is a freshly-mounted volume, so the directory
      // may not exist yet on the first write.
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({
        _readme: FILE_README,
        rules: [...rules.values()].map(configOf),
      }, null, 2) + "\n");
      // The container runs as root (BPF requires it), which would leave this
      // root-owned on a bind mount — readable but not editable by the person who
      // started it. STATE_UID/GID (set by the Makefile) hand it back to them.
      if (stateUid !== null) {
        try { chownSync(file, stateUid, stateGid); } catch { /* not root, or a docker volume */ }
      }
    } catch (err) {
      // Not fatal — rules keep working for this process's lifetime, they just
      // won't come back after a restart. Say so once, loudly.
      if (!saveWarned) {
        saveWarned = true;
        console.error(`[alerts] could not write ${file}: ${err.message}`);
        console.error("[alerts] rules will be lost when this process exits — mount a writable /data or set ALERTS_FILE");
      }
    }
  }

  /** Normalize + check an incoming rule. Returns {rule} or {error}. */
  function validate(input) {
    const key = String(input?.key ?? "").trim();
    if (!key) return { error: "key is required" };
    if (key.length > 500) return { error: "key is too long" };

    const when = String(input?.when ?? "").toLowerCase();
    if (!CONDITIONS[when]) return { error: `when must be one of: ${CONDITION_KEYS.join(", ")}` };

    let code = null;
    if (when === "code") {
      code = Number(input?.code);
      if (!Number.isInteger(code) || code < 100 || code > 599) return { error: "code must be a status code (100–599)" };
    }

    const channel = String(input?.channel ?? defaultChannel).trim() || defaultChannel;
    if (!/^[#@]?[\w #@.-]{1,80}$/.test(channel)) return { error: "channel looks invalid" };

    // Opt-in: an alert that carries a payload puts it in a Slack channel, so it
    // is never on by default.
    const includeBody = input?.includeBody === true || input?.includeBody === "true";

    let cooldownSec = input?.cooldownSec == null ? DEFAULT_COOLDOWN_SEC : Number(input.cooldownSec);
    if (!Number.isFinite(cooldownSec)) cooldownSec = DEFAULT_COOLDOWN_SEC;
    cooldownSec = Math.max(MIN_COOLDOWN_SEC, Math.min(86400, Math.round(cooldownSec)));

    return {
      rule: {
        id: String(input?.id ?? ""), key, when, code, channel, cooldownSec, includeBody,
        createdAt: input?.createdAt ?? Date.now(),
        // Runtime state, kept on the rule so the UI can show what happened.
        // `pending` maps endpoint key → matches seen during the quiet period, so
        // the next alert can say where they happened, not just how many.
        // `pendingCodes` is the same window pooled by status code, so the alert
        // can name the codes and not just the count.
        lastFiredAt: null, firedCount: 0, matchedSinceFire: 0,
        pending: new Map(), pendingCodes: new Map(), lastError: null,
      },
    };
  }

  function describe(rule) {
    return rule.when === "code" ? `status ${rule.code}` : CONDITIONS[rule.when].label;
  }

  /** Where a rule applies, for logs and alert titles. */
  const scopeOf = (rule) => (rule.key === ANY_ENDPOINT ? "any endpoint" : rule.key);

  /** Public shape for the browser — no internals, and the label it should show. */
  function publicRule(r) {
    return {
      id: r.id, key: r.key, when: r.when, code: r.code, channel: r.channel,
      cooldownSec: r.cooldownSec, includeBody: !!r.includeBody, createdAt: r.createdAt,
      lastFiredAt: r.lastFiredAt, firedCount: r.firedCount, lastError: r.lastError,
      label: describe(r),
      // So the UI can mark a catchall rule as covering everything, not just the
      // endpoint whose panel it happens to be shown on.
      global: r.key === ANY_ENDPOINT,
      scope: scopeOf(r),
    };
  }

  function list(key) {
    const all = [...rules.values()].filter((r) => !key || r.key === key);
    return all.sort((a, b) => a.createdAt - b.createdAt).map(publicRule);
  }

  function add(input) {
    if (rules.size >= MAX_RULES) return { error: `too many rules (max ${MAX_RULES})` };
    const v = validate(input);
    if (v.error) return v;
    // Same endpoint + same condition twice is a no-op, not a second alert.
    for (const r of rules.values()) {
      if (r.key === v.rule.key && r.when === v.rule.when && r.code === v.rule.code) {
        return { rule: publicRule(r), existing: true };
      }
    }
    const rule = { ...v.rule, id: String(nextId++) };
    rules.set(rule.id, rule);
    save();
    console.log(`[alerts] added: ${describe(rule)} on ${scopeOf(rule)} → ${rule.channel}`);
    return { rule: publicRule(rule) };
  }

  /**
   * Change a rule in place, keeping its id (so the UI's row stays put).
   *
   * Timing follows identity: edit only the channel or the quiet period and the
   * cooldown carries over, because it's still the same rule watching the same
   * thing. Change *what* it watches and it starts clean — otherwise a rule
   * repointed at a new endpoint would inherit a quiet period it never earned.
   */
  function update(id, patch) {
    const rule = rules.get(String(id));
    if (!rule) return { error: "no such rule" };

    const merged = {
      ...configOf(rule),
      // Only these are editable; id and createdAt are not up for negotiation.
      ...(patch.key === undefined ? {} : { key: patch.key }),
      ...(patch.when === undefined ? {} : { when: patch.when }),
      ...(patch.code === undefined ? {} : { code: patch.code }),
      ...(patch.channel === undefined ? {} : { channel: patch.channel }),
      ...(patch.cooldownSec === undefined ? {} : { cooldownSec: patch.cooldownSec }),
      ...(patch.includeBody === undefined ? {} : { includeBody: patch.includeBody }),
    };
    const v = validate(merged);
    if (v.error) return v;

    // Would this collide with a different rule that already exists?
    for (const other of rules.values()) {
      if (other.id !== rule.id && other.key === v.rule.key && other.when === v.rule.when && other.code === v.rule.code) {
        return { error: "another rule already watches that" };
      }
    }

    const sameThing = identityOf(rule) === identityOf(v.rule);
    const next = {
      ...v.rule,
      id: rule.id,
      createdAt: rule.createdAt,
      lastFiredAt: sameThing ? rule.lastFiredAt : null,
      firedCount: sameThing ? rule.firedCount : 0,
      pending: sameThing ? rule.pending : new Map(),
      pendingCodes: sameThing ? rule.pendingCodes : new Map(),
      matchedSinceFire: sameThing ? rule.matchedSinceFire : 0,
      lastError: sameThing ? rule.lastError : null,
    };
    rules.set(rule.id, next);
    save();
    saveState();   // rewrites under the new identity, pruning the old entry
    console.log(`[alerts] updated: ${describe(next)} on ${scopeOf(next)} → ${next.channel}` +
      `${sameThing ? "" : " (timing reset — it watches something different now)"}`);
    return { rule: publicRule(next) };
  }

  function remove(id) {
    const rule = rules.get(String(id));
    if (!rule) return { error: "no such rule" };
    rules.delete(String(id));
    save();
    saveState();   // prunes the removed rule's timing
    console.log(`[alerts] removed: ${describe(rule)} on ${scopeOf(rule)}`);
    return { ok: true };
  }

  /**
   * New matching responses between two per-code tallies of one endpoint, broken
   * down by status code — `{ n, codes: Map<code, count> }`.
   *
   * Per code rather than per total, because the codes are what a rule throws
   * away otherwise: an `any 5xx` alert that can say "500 ×2 · 503 ×1" tells you
   * whether one thing is broken or two, and that distinction only exists here,
   * before the tallies are summed.
   *
   * `restarted` reports a code whose count went *down*, which only happens when
   * the probe restarted and its counters reset. The caller re-baselines that
   * endpoint rather than reading the reset as a flood.
   */
  function matchDeltas(cur, prev, rule) {
    const cond = CONDITIONS[rule.when];
    const codes = new Map();
    let n = 0;
    for (const [codeStr, count] of Object.entries(cur)) {
      const code = Number(codeStr);
      if (!cond.test(code, rule)) continue;
      const before = prev ? (prev[codeStr] || 0) : 0;
      if (count < before) return { n: 0, codes, restarted: true };
      const delta = count - before;
      if (delta <= 0) continue;
      n += delta;
      codes.set(code, delta);
    }
    return { n, codes, restarted: false };
  }

  /**
   * Diff this snapshot against the previous one and fire whatever is due.
   * Called once per snapshot; cheap (a few map lookups per rule).
   */
  function evaluate(snapshot) {
    const now = Date.now();
    const status = new Map();
    for (const ep of snapshot?.endpoints || []) status.set(ep.key, ep.status || {});

    // The very first snapshot (and the first after a probe restart) is the
    // baseline: every endpoint's tally is historical, and alerting on it would
    // fire on a backlog. From then on an endpoint we haven't seen before is
    // genuinely new, so its whole tally counts as fresh.
    if (!seeded) {
      prevStatus = status;
      seeded = true;
      return;
    }
    if (rules.size === 0) { prevStatus = status; return; }
    if (wantsBodies()) rememberBodies(snapshot);

    for (const rule of rules.values()) {
      // A catchall rule watches everything in this snapshot; otherwise just the
      // one endpoint it names.
      const keys = rule.key === ANY_ENDPOINT ? status.keys() : [rule.key];

      let fresh = 0;
      for (const key of keys) {
        const cur = status.get(key);
        if (!cur) continue; // endpoint not in this snapshot
        const { n: delta, codes, restarted } = matchDeltas(cur, prevStatus.get(key), rule);
        if (restarted || delta <= 0) continue;
        fresh += delta;
        rule.pending.set(key, (rule.pending.get(key) || 0) + delta);
        // Codes are pooled across endpoints, not kept per endpoint: "which codes
        // am I seeing" is a question about the rule, and a per-endpoint
        // breakdown of both at once is more than a notification should carry.
        for (const [code, n] of codes) rule.pendingCodes.set(code, (rule.pendingCodes.get(code) || 0) + n);
      }
      if (fresh <= 0) continue;

      rule.matchedSinceFire += fresh;
      const cooledDown = rule.lastFiredAt == null || now - rule.lastFiredAt >= rule.cooldownSec * 1000;
      if (!cooledDown) continue; // still in the quiet period; keep counting

      fire(rule, rule.matchedSinceFire, rule.pending, rule.pendingCodes, now);
      rule.matchedSinceFire = 0;
      rule.pending = new Map();
      rule.pendingCodes = new Map();
    }

    prevStatus = status;
  }

  /** Spawn the one-shot yeet script that actually calls yeet.alert.
   *  `where` is endpoint key → matches since the last alert, `codes` is the same
   *  window pooled by status code. */
  function fire(rule, matched, where, codes, now) {
    rule.lastFiredAt = now;
    rule.firedCount++;
    saveState();   // before delivery: the cooldown starts now, restart or not

    if (!isLoggedIn()) {
      rule.lastError = "not logged in — alerts need `yeet login`";
      console.error(`[alerts] ${scopeOf(rule)}: ${rule.lastError}`);
      saveState();
      return;
    }
    // A definite "no Slack integration" can't succeed, so don't spend a process
    // finding out — but only skip when we actually know (see slackConnected).
    if (slackConnected() === false) {
      rule.lastError = "Slack isn't connected — add the integration at yeet.cx/settings";
      console.error(`[alerts] ${scopeOf(rule)}: ${rule.lastError}`);
      saveState();
      return;
    }

    // Where they happened, worst first — for a catchall this is the whole point,
    // and for a single endpoint it's just that endpoint. Capped so a bad minute
    // across hundreds of routes doesn't produce an unreadable message; the
    // remainder is counted rather than dropped silently.
    const hits = [...where.entries()].sort((a, b) => b[1] - a[1]);
    const shownHits = hits.slice(0, HITS_SHOWN);
    const hitsMore = hits.length - shownHits.length;
    // Which codes, worst first — ordered by count, then by code so a tie reads
    // predictably rather than in whatever order they were first seen.
    const codeHits = [...codes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);

    // The payload of one matching response, if this rule asked for it. Picked
    // from the endpoints that actually contributed, so a catchall shows a body
    // from a route that really failed.
    let bodyArg = null;
    let bodyNote = "";
    if (rule.includeBody) {
      const ref = bodyFor(rule, hits.map(([key]) => key));
      const held = resolveBody(ref);
      if (!ref) {
        bodyNote = "no response body was captured for this one — body capture may be off, " +
          "or the body budget dropped it";
      } else if (!held) {
        bodyNote = "the matching response's body is no longer held — it was evicted before this alert fired";
      } else {
        const { text, note } = decodeCaptured(held, { max: BODY_SNIPPET_MAX });
        if (text) bodyArg = text;
        bodyNote = note || "";
        if (!text && !bodyNote) bodyNote = "the captured response had an empty body";
      }
    }

    const iface = ifaceLabel();
    const args = [];
    if (socket) args.push("--socket", socket);
    if (userSocket) args.push("--user-socket", userSocket);
    /* The alert's parts, passed separately: the script assembles the Block Kit
     * message (header, per-endpoint fields, body, button, footer) and this side
     * stays out of layout. Pre-joined strings would force the two to agree on
     * formatting, which is exactly what made the message hard to restyle. */
    args.push("run", scriptPath, "--",
      "--channel", rule.channel,
      "--icon", (SEVERITY[rule.when] || SEVERITY.code).icon,
      "--color", (SEVERITY[rule.when] || SEVERITY.code).color,
      "--condition", describe(rule),
      "--scope", scopeOf(rule),
      "--matched", String(matched),
      "--endpoints", String(hits.length),
      "--hits", JSON.stringify(shownHits),
      ...(hitsMore > 0 ? ["--hits-more", String(hitsMore)] : []),
      ...(codeHits.length ? ["--codes", JSON.stringify(codeHits)] : []),
      ...(bodyArg ? ["--body", bodyArg] : []),
      ...(bodyNote ? ["--body-note", bodyNote] : []),
      ...(linkFor ? (() => {
        // Deep link straight to the endpoint's detail panel. For a catchall, the
        // worst offender is the useful landing place.
        const url = linkFor(hits.length ? hits[0][0] : rule.key);
        return url ? ["--link", url] : [];
      })() : []),
      ...(iface ? ["--iface", iface] : []),
      "--cooldown", String(rule.cooldownSec),
      // Both forms: Slack renders a unix timestamp in each reader's own
      // timezone, and the ISO string is what it falls back to (and what a
      // plain-text delivery shows).
      "--at", new Date(now).toISOString(),
      "--at-unix", String(Math.floor(now / 1000)));

    // Outcome comes from the script's output, not its exit status: `yeet.exit()`
    // takes no code, so the process always exits 0 and an exit-code check would
    // report every failed alert as delivered.
    const child = spawn(yeetBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => {
      rule.lastError = `could not run yeet: ${e.message}`;
      console.error(`[alerts] ${scopeOf(rule)}: ${rule.lastError}`);
      saveState();
    });
    child.on("close", () => {
      const bad = /ALERT-ERR\s*(.*)/.exec(out);
      if (bad) rule.lastError = bad[1].trim() || "alert failed";
      else if (/ALERT-OK/.test(out)) rule.lastError = null;
      // Neither marker: the script may have delivered the alert and lost its
      // output, or never loaded at all. Both are possible, so don't claim it
      // failed — say the outcome is unknown, which is the true statement.
      else rule.lastError = `delivery status unknown${out.trim() ? `: ${out.trim().split("\n").filter(Boolean).pop()}` : " — no result from the alert script"}`;

      if (rule.lastError) console.error(`[alerts] ${scopeOf(rule)}: ${rule.lastError}`);
      else console.log(`[alerts] fired: ${describe(rule)} on ${scopeOf(rule)} (${matched} matched) → ${rule.channel}`);
      saveState();
    });
  }

  /**
   * Drop the baseline — after a probe restart, counts start from zero, and the
   * next snapshot must be treated as a new baseline rather than a flood.
   * Deliberately leaves `lastFiredAt` alone: cooldowns are about not spamming
   * Slack, so restarting the probe must not be a way to bypass the throttle.
   */
  function reset() {
    prevStatus = new Map();
    seeded = false;
    // Exchange ids restart with the probe, so a remembered id would resolve to
    // a *different* exchange's body once the store refills. Forget them.
    bodyRefs.clear();
    for (const r of rules.values()) {
      r.matchedSinceFire = 0;
      r.pending = new Map();
      r.pendingCodes = new Map();
    }
  }

  return { list, add, update, remove, evaluate, reset, conditions: CONDITION_KEYS, defaultChannel };
}
