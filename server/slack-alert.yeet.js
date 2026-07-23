// One-shot alert sender — a yeet script, run by the node server, never imported.
//
//   yeet run server/slack-alert.yeet.js -- --channel '#alerts' \
//     --icon '🚨' --color '#c0392b' --condition 'any 5xx' \
//     --scope 'GET shop.internal /api/orders' --matched 3 --endpoints 2 \
//     --hits '[["GET shop.internal /api/orders",2],["GET shop.internal /api/cart",1]]' \
//     --codes '[[500,2],[503,1]]' \
//     --iface lo --cooldown 30 --at '2026-07-28T14:02:11.000Z' --at-unix 1785247331
//
// `yeet.alert` is only available *inside* a yeet isolate — there is no CLI or
// HTTP equivalent — and the dashboard's rules live in the node server, which
// can't be pushed into the long-running exporter (no control channel into a
// running isolate, and restarting it would reset every counter). So the server
// keeps the rules and spawns this script per notification. Alerts are throttled
// server-side and are rare, so a process per alert is the cheap end of the
// trade: it buys runtime-editable rules with no probe restart.
//
// This script owns the *layout* only: the server passes the alert's parts
// separately (condition, scope, counts, per-endpoint hits, body, link, footer
// facts) and everything here is about assembling them into Block Kit. Keeping
// the split there means the message can be restyled without touching detection.
//
// Success/failure is reported by printing a marker, NOT by an exit code:
// `yeet.exit()` takes no status argument, so the process exit code says nothing
// about whether the alert landed. The server matches these markers in the
// script's output and records the reason on the rule, so a misconfigured Slack
// integration shows up in the UI instead of silently dropping alerts.
const OK = "ALERT-OK";
const ERR = "ALERT-ERR";

/* Block Kit's own caps. Slack rejects the whole message (invalid_blocks) if any
 * one of these is exceeded, so every string is clamped on the way in rather
 * than trusting the server to have done it. */
const HEADER_MAX = 150;     // header block, plain_text
const SECTION_MAX = 3000;   // section text
const LIST_ITEMS_MAX = 10;  // endpoints named individually (the server caps too)

const args = yeet.args;
const str = (v) => String(v ?? "").trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const trunc = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const channel = str(args.channel);
const icon = str(args.icon);
const color = str(args.color);
const condition = str(args.condition) || "alert";
const scope = str(args.scope);
const matched = num(args.matched);
const endpoints = num(args.endpoints);
const link = str(args.link);
const iface = str(args.iface);
const cooldown = str(args.cooldown);
const at = str(args.at);
const atUnix = num(args["at-unix"]);
// A response body, when the rule asked to include one, plus a note when there
// wasn't one to include (or it arrived truncated/compressed).
const body = String(args.body ?? "");
const bodyNote = str(args["body-note"]);

/* Two lists, JSON because there's one flag per argument: which endpoints the
 * matches came from ([[key, count], …]) and which status codes they were
 * ([[code, count], …]), both worst-first. Bad JSON must not cost the whole alert
 * — the breakdowns are detail, the notification is the point. */
function parseList(raw, what) {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (Array.isArray(parsed)) return parsed.filter((e) => Array.isArray(e) && e.length === 2);
  } catch {
    console.error(`${what} was not valid JSON — sending the alert without that breakdown`);
  }
  return [];
}
const hits = parseList(args.hits, "hits");
const codes = parseList(args.codes, "codes");
// How many endpoints the server left out of `hits` (it caps the list).
const hitsMore = num(args["hits-more"]);

// The title, as one plain_text header. Headers don't render mrkdwn, so this is
// deliberately plain — the emphasis comes from the block type, not from markup.
const title = [icon, `${condition}${scope ? ` on ${scope}` : ""}`].filter(Boolean).join(" ");

/** Literal text as a rich_text run — `code: true` for anything copied off the
 *  wire, so a path with markdown characters in it renders as written. */
const run = (text, style) => ({ type: "text", text, ...(style ? { style } : {}) });

/* Whether this URL can be a *button*. Slack validates a button's `url` when the
 * message is posted and rejects the whole message if it doesn't like it — and a
 * hostname with no dot is the usual reason: `http://localhost:3000`,
 * `http://httpwatch:3000`, a bare container or LAN name. Which is exactly what
 * this dashboard's link is by default, since it's learned from the Host header
 * unless PUBLIC_URL says otherwise.
 *
 * An mrkdwn link is not validated the same way, so a URL that can't be a button
 * can still be a working link — Slack opens either one in the reader's own
 * browser and never fetches it itself, so an internal address is fine to point
 * at. Requiring a dotted host (which allows IPs) or a bracketed IPv6 literal is
 * the conservative read of what Slack accepts. */
const BUTTON_URL = /^https?:\/\/(\[[0-9a-fA-F:]+\]|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]|$)/;
const canButton = BUTTON_URL.test(link);

// One exit, at the very end. `yeet.exit()` is NOT a return — code after it keeps
// running (verified) — so an early `yeet.exit()` in a guard would fall straight
// through into the alert call. Branch instead, and let every path converge on
// the flush-then-exit below so exactly one marker is printed, always flushed.
if (!channel) {
  console.error(`${ERR} --channel is required`);
} else {
  /* `button: false` renders the link as mrkdwn instead of as a button. Two
   * callers want that: a URL Slack won't accept as a button target (see
   * BUTTON_URL), and the retry ladder after Slack has rejected one anyway. */
  const buildBlocks = ({ button }) => {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: trunc(title, HEADER_MAX), emoji: true } },
  ];

  /* The count, with the button hung off it as an accessory rather than sitting in
   * an actions block of its own: there's exactly one action here, and this puts
   * it on the same line as the thing it acts on instead of spending a whole row
   * of the message on it. */
  const summary = `*${matched} matching response${matched === 1 ? "" : "s"}* since the last alert` +
    (endpoints > 1 ? `, across *${endpoints}* endpoints` : "");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: trunc(summary, SECTION_MAX) },
    ...(link && button ? {
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Open in httpwatch", emoji: false },
        url: link,
        style: "primary",
      },
    } : {}),
  });
  // The same action as plain markup when it can't be a button. Its own section so
  // it still reads as the message's call to action rather than a footnote.
  if (link && !button) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `<${link}|Open in httpwatch →>` } });
  }

  // Which codes, small: for a rule watching a *class* of status (any 5xx, 4xx +
  // 5xx) this is the difference between "one thing is broken" and "two are", and
  // it's the one fact the endpoint counts can't imply.
  if (codes.length) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: codes.map(([code, n]) => `\`${str(code)}\` ×${num(n)}`).join("  ·  "),
      }],
    });
  }

  /* Where they happened, as a bulleted rich_text list. A list rather than a
   * two-column fields section: endpoint keys are long ("GET shop.internal
   * /api/orders"), and in two columns they wrap mid-key on anything narrower
   * than a wide desktop window. Full width reads cleanly at every size.
   *
   * Skipped when it would only repeat the header — a single-endpoint rule names
   * its endpoint up there already, and a list of one is noise. */
  const worthListing = hits.length > 1 || (hits.length === 1 && str(hits[0][0]) !== scope);
  if (worthListing) {
    blocks.push({
      type: "rich_text",
      elements: [{
        type: "rich_text_list",
        style: "bullet",
        elements: hits.slice(0, LIST_ITEMS_MAX).map(([key, n]) => ({
          type: "rich_text_section",
          elements: [run(`×${num(n)}  `, { bold: true }), run(str(key), { code: true })],
        })),
      }],
    });
  }
  if (hitsMore > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${hitsMore} more endpoint${hitsMore === 1 ? "" : "s"}` }],
    });
  }

  /* Slack has no spoiler markup — nothing hides content behind a click the way
   * Discord's ||…|| does. A preformatted rich_text block is the most contained
   * thing available: visually separated, monospaced, and collapsed behind
   * Slack's own "Show more" when long. So the real control is length (the server
   * truncates) and the choice to send a link instead of a payload.
   *
   * rich_text carries the body as literal text rather than as mrkdwn, so unlike
   * a ``` fence there is nothing in a payload that can break out of the block —
   * no escaping needed, and no chance of a body being reinterpreted as markup. */
  if (body) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "rich_text",
      elements: [{
        type: "rich_text_preformatted",
        elements: [run(trunc(body, SECTION_MAX))],
      }],
    });
  }
  if (bodyNote) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: bodyNote }] });

  /* Footer facts, smallest type on the message: what produced it, where it was
   * watching, how often it can repeat, and when it fired. The time goes through
   * Slack's date markup so it renders in each reader's own timezone — an ISO
   * string in UTC is the sort of thing that makes people mis-read an incident by
   * an hour. The text after `|` is what Slack shows if it can't render it. */
  const when = atUnix ? `<!date^${atUnix}^{date_short_pretty} at {time}|${at}>` : at;
  const footer = [
    "httpwatch",
    iface ? `iface ${iface}` : null,
    cooldown ? `at most once per ${cooldown}s` : null,
    when,
  ].filter(Boolean).join("  ·  ");
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
  return blocks;
  };

  // A button only when Slack will take the URL as one; otherwise it's a link
  // from the start, and the ladder below never has to find that out the hard way.
  if (link && !canButton) {
    console.error(`link ${link} has no dotted host — Slack rejects that as a button URL, ` +
      "sending it as an mrkdwn link instead (set PUBLIC_URL to a routable name to get the button back)");
  }

  /* `text` is the notification fallback — the push notification, the sidebar
   * preview, and what a client that can't render blocks shows instead. So it has
   * to stand on its own: title, count, and the link. */
  const plain = `${matched} matching response${matched === 1 ? "" : "s"}` +
    (endpoints > 1 ? ` across ${endpoints} endpoints` : "") +
    (codes.length ? ` (${codes.map(([code, n]) => `${str(code)} ×${num(n)}`).join(", ")})` : "");
  const fallback = [title, plain, link].filter(Boolean).join(" — ");

  /* Ways to send the same alert, best first. Slack validates presentation as a
   * whole and rejects it as a whole: one URL it dislikes in the button, one block
   * type the platform won't forward, and the notification is lost rather than
   * merely plain. So each rung gives up the most fragile thing the last one
   * tried, and the last rung is text that cannot fail to render.
   *
   * Order matters: the button goes before the colour does. A rejected button URL
   * is the likeliest rejection there is (Slack is strict about them, and this
   * dashboard's URL is whatever the Host header said), and losing the whole
   * layout over it — colour, codes, endpoint list — would be a bad trade for a
   * link that renders perfectly well as mrkdwn.
   *
   * The colour bar is why the top rung exists. Blocks have no colour of their own
   * — an attachment wrapper is the only way to get the coloured left edge that
   * makes an alert legible at a glance in a busy channel — and `yeet.alert`
   * forwards this object to the platform, which is what decides whether
   * `attachments` reaches Slack at all. */
  const withButton = canButton ? buildBlocks({ button: true }) : null;
  const withLink = buildBlocks({ button: false });
  const rung = (how, blocks, colored) => ({
    how,
    payload: {
      method: "slack", channel, text: fallback,
      ...(colored ? { attachments: [{ color, blocks }] } : { blocks }),
    },
  });
  const attempts = [
    ...(withButton && color ? [rung("coloured, with a button", withButton, true)] : []),
    ...(color ? [rung("coloured, with a link", withLink, true)] : []),
    ...(withButton ? [rung("blocks with a button", withButton, false)] : []),
    rung("blocks with a link", withLink, false),
    { how: "plain text", payload: { method: "slack", channel, text: fallback } },
  ];

  /* Failures worth giving up on immediately: not being logged in and being rate
   * limited are properties of the host or the workspace, not of the message, so
   * a simpler message would fail the same way. Retrying one would only delay the
   * report — and yeet.alert does not retry a 429 itself. */
  const FATAL = /not_?authed|invalid_auth|token|unauthor|forbidden|401|403|429|rate.?limit|channel_not_found/i;

  let sent = false;
  let lastErr = "";
  for (const [i, attempt] of attempts.entries()) {
    try {
      await yeet.alert(attempt.payload);
      // Only interesting when it wasn't the first choice: a downgrade is how
      // someone finds out their alerts are plainer than the code intends.
      if (i > 0) console.error(`delivered as ${attempt.how} — richer formatting was rejected (${lastErr})`);
      console.log(OK);
      sent = true;
      break;
    } catch (err) {
      lastErr = str(err?.message ?? err) || "alert failed";
      if (FATAL.test(lastErr)) break;
    }
  }
  // Nothing rethrows: a failed alert is reported, never fatal. This isolate is
  // its own short-lived process, so it can't disturb the probe or the server
  // either way.
  if (!sent) console.error(`${ERR} ${lastErr || "alert failed"}`);
}

// Give the console a beat to reach the CLI before tearing the isolate down.
// Measured: exiting immediately after logging loses the output entirely on
// roughly a third of runs, which would leave the server unable to tell whether
// the alert landed. With this pause, 20/20 runs reported.
await new Promise((r) => setTimeout(r, 200));
yeet.exit();
