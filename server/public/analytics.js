// Product analytics (PostHog), loaded only when the server hands the page a key.
//
// Two things make this different from a normal web-app install:
//
//  * The library comes from the yeet PostHog proxy (https://ph.yeet.cx by
//    default, POSTHOG_HOST to change it), so the browser never talks to
//    us.posthog.com directly and the script survives an ad blocker's host list.
//
//  * This dashboard's URLs and its data are the *user's* captured traffic —
//    `/?endpoint=api.internal:80 GET /v1/orders` names a host and a route we
//    have no business shipping anywhere. So every property that could carry one
//    is scrubbed on the way out (sanitizeUrl below), and the events raised from
//    app.js deliberately describe the interaction rather than the row it
//    happened on. Keep it that way when adding events.
//
// Exposes `window.hwTrack(event, props)` and `window.hwIdentify(id)`, both safe
// to call before the library loads (queued) and when analytics is off (no-ops).

(() => {
  const cfg = (window.__BOOT__ && window.__BOOT__.config && window.__BOOT__.config.analytics) || null;

  // Calls made before array.js finishes loading; replayed in order after init.
  let queue = [];
  const flushTo = (fn) => { const q = queue; queue = []; for (const args of q) fn(args); };

  if (!cfg || !cfg.key) {
    window.hwTrack = () => {};
    window.hwIdentify = () => {};
    return;
  }

  window.hwTrack = (event, props) => {
    if (window.posthog && window.posthog.__loaded) window.posthog.capture(event, props);
    else queue.push(["capture", event, props]);
  };
  window.hwIdentify = (id, props) => {
    if (!id) return;
    if (window.posthog && window.posthog.__loaded) window.posthog.identify(id, props);
    else queue.push(["identify", id, props]);
  };

  /** A dashboard URL with the endpoint key (host + path of captured traffic)
   *  removed. The pathname is ours — `/` or `/detail` — and stays. */
  function sanitizeUrl(value) {
    if (typeof value !== "string") return value;
    try {
      const u = new URL(value, window.location.origin);
      // Not a rewrite of one param: anything in the query string here derives
      // from captured traffic, so the whole thing goes.
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      return value.split("?")[0];
    }
  }

  const URL_PROPS = ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer", "$pathname"];

  const script = document.createElement("script");
  script.src = `${cfg.host}/static/array.js`;
  script.async = true;
  script.onload = () => {
    if (!window.posthog || !window.posthog.init) return;
    window.posthog.init(cfg.key, {
      api_host: cfg.host,
      // Pageviews on history changes too: opening an endpoint pushes /detail
      // and back/forward navigate between those states.
      capture_pageview: "history_change",
      capture_pageleave: true,
      // Exception autocapture is off for the same reason as autocapture: an
      // error message here can quote the data. `JSON.parse` on a captured
      // response throws with a snippet of that response in the message, and the
      // page parses captured bodies to pretty-print them.
      capture_exceptions: false,
      // Session recording and autocapture would both read the endpoint table —
      // the user's traffic — as DOM text. Off, not sampled.
      disable_session_recording: true,
      autocapture: false,
      debug: !!cfg.debug,
      sanitize_properties: (props) => {
        for (const k of URL_PROPS) if (k in props) props[k] = sanitizeUrl(props[k]);
        return props;
      },
    });
    flushTo(([kind, a, b]) => {
      if (kind === "identify") window.posthog.identify(a, b);
      else window.posthog.capture(a, b);
    });
  };
  // No network (this dashboard often runs on a host with none) or a blocked
  // request: drop what queued rather than growing it for the page's lifetime.
  script.onerror = () => {
    queue = [];
    window.hwTrack = () => {};
    window.hwIdentify = () => {};
  };
  document.head.appendChild(script);
})();
