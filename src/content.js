(() => {
  "use strict";

  // Reddit Stats Restored — v1, display-only, in-page only.
  //
  // What it shows, and where each number comes from:
  //  - Subscribers:    GET https://www.reddit.com/r/<sub>/about.json -> data.subscribers
  //                     (Reddit removed it from the page on 2025-09-09, but the API still returns it.)
  //  - Weekly visitors: Reddit's own 7-day Visitors number. Not in about.json.
  //                     Read from the loaded page first (the `weekly-active-users`
  //                     attribute on the community header, and the visible "Visitors"
  //                     text), falling back to fetching the www.reddit.com HTML and
  //                     parsing the same attribute / embedded JSON from there.
  //  - Contributions:   Reddit's own 7-day Contributions number (posts + comments),
  //                     read the same way as Weekly visitors.
  //
  // Deliberately NOT shown: "online now" / current visitors. Reddit stopped
  // publishing active_user_count (null since at least July 2026), so there is
  // no honest source for it. This extension never invents a number.
  //
  // Privacy: no data leaves the browser except the two fetches above, both to
  // reddit.com, for the subreddit you are already viewing. No tracking, no
  // analytics, no login, no storage of history. Cache is in-memory only, 5 min.

  const CACHE_TTL_MS = 5 * 60 * 1000;
  const cache = new Map(); // sub -> { data, fetchedAt }
  let currentSub = null;
  let currentRenderKey = "";
  let inFlight = null;

  function getSubreddit() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/);
    return m ? m[1] : null;
  }

  function isOldReddit() {
    return location.hostname.startsWith("old.");
  }

  function parseCompactNumber(text) {
    if (text == null) return null;
    const raw = String(text).trim().replace(/,/g, "");
    const m = raw.match(/^([\d.]+)\s*([kKmM])?$/);
    if (!m) {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    let n = parseFloat(m[1]);
    if (m[2]) {
      const u = m[2].toLowerCase();
      if (u === "k") n *= 1e3;
      if (u === "m") n *= 1e6;
    }
    return Math.round(n);
  }

  function formatNumber(n) {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US").format(n);
  }

  function formatCompact(n) {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }

  // --- DOM scraping: weekly visitors / contributions from the loaded page ---

  function scanAttributesForStats(root) {
    const out = {};
    const els = root.querySelectorAll("*");
    for (const el of els) {
      for (const attr of el.attributes || []) {
        const name = attr.name.toLowerCase();
        const val = parseCompactNumber(attr.value);
        if (val == null) continue;
        if (name.includes("weekly") && (name.includes("visitor") || name.includes("active"))) {
          if (out.weeklyVisitors == null) out.weeklyVisitors = val;
        }
        if (name.includes("contribution")) {
          if (out.contributions == null) out.contributions = val;
        }
        // Embedded-data attributes Reddit has used in the past.
        if (name === "data-weekly-visitors") out.weeklyVisitors ??= val;
        if (name === "data-weekly-contributions") out.contributions ??= val;
      }
      // data-* via dataset as a second pass for hyphenated names.
      if (el.dataset) {
        if (el.dataset.weeklyActiveUsers != null) {
          out.weeklyVisitors ??= parseCompactNumber(el.dataset.weeklyActiveUsers);
        }
        if (el.dataset.weeklyVisitors != null) {
          out.weeklyVisitors ??= parseCompactNumber(el.dataset.weeklyVisitors);
        }
      }
    }
    return out;
  }

  function scanTextForStats(root) {
    const out = {};
    // Only look in the header / sidebar region when we can find it, to avoid
    // matching a random post that mentions "visitors".
    const text = root.innerText || "";
    const visit = text.match(/([\d.,]+[kKmM]?)\s*\n?\s*Visitors/i);
    if (visit) out.weeklyVisitors ??= parseCompactNumber(visit[1]);
    const contrib = text.match(/([\d.,]+[kKmM]?)\s*\n?\s*Contributions/i);
    if (contrib) out.contributions ??= parseCompactNumber(contrib[1]);
    return out;
  }

  function scanHtmlForStats(html) {
    const out = {};
    let m;
    // weekly-active-users="123456" (exact integer, per Reddit's header markup)
    m = html.match(/weekly-active-users=["']([\d,]+)["']/i);
    if (m) out.weeklyVisitors = parseCompactNumber(m[1]);
    // Embedded JSON variants seen in Reddit's page payloads.
    if (out.weeklyVisitors == null) {
      m = html.match(/"weeklyVisitors"\s*:\s*(\d+)/i)
        || html.match(/"weekly_active_users"\s*:\s*(\d+)/i)
        || html.match(/weeklyVisitors["']?\s*[:=]\s*["']?([\d,]+)/i);
      if (m) out.weeklyVisitors = parseCompactNumber(m[1]);
    }
    if (out.contributions == null) {
      m = html.match(/weekly-contributions=["']([\d,]+)["']/i)
        || html.match(/"weeklyContributions"\s*:\s*(\d+)/i)
        || html.match(/"contributions"\s*:\s*(\d+)/i);
      if (m) out.contributions = parseCompactNumber(m[1]);
    }
    // Visible-text fallback in the HTML itself.
    if (out.weeklyVisitors == null) {
      m = html.match(/([\d.,]+[kKmM]?)\s*<[^>]*>\s*Visitors/i)
        || html.match(/([\d.,]+[kKmM]?)\s+Visitors/i);
      if (m) out.weeklyVisitors = parseCompactNumber(m[1]);
    }
    if (out.contributions == null) {
      m = html.match(/([\d.,]+[kKmM]?)\s*<[^>]*>\s*Contributions/i)
        || html.match(/([\d.,]+[kKmM]?)\s+Contributions/i);
      if (m) out.contributions = parseCompactNumber(m[1]);
    }
    return out;
  }

  async function fetchSubscribers(sub) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/about.json`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { subscribers: null, error: `about.json HTTP ${res.status}` };
      const json = await res.json();
      const subs = json && json.data ? json.data.subscribers : null;
      return { subscribers: typeof subs === "number" ? subs : null, error: null };
    } catch (e) {
      return { subscribers: null, error: String(e && e.message ? e.message : e) };
    }
  }

  async function fetchWeeklyFromHtml(sub) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/`, {
        credentials: "include",
        headers: { Accept: "text/html" },
      });
      if (!res.ok) return {};
      const html = await res.text();
      return scanHtmlForStats(html);
    } catch {
      return {};
    }
  }

  async function loadStats(sub, { force = false } = {}) {
    const cached = cache.get(sub);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      // 1. What the loaded page already shows (www.reddit only; old.reddit
      //    does not render Visitors/Contributions).
      let fromDom = {};
      try {
        fromDom = {
          ...scanAttributesForStats(document),
          ...scanTextForStats(document),
        };
        // Attribute scan wins over text scan when both exist.
        const attrs = scanAttributesForStats(document);
        fromDom = { ...fromDom, ...attrs };
      } catch { /* keep going — HTML fetch is the fallback */ }

      // 2. Subscribers from about.json, in parallel with the HTML fallback
      //    for weekly visitors / contributions when the DOM did not have them.
      const needHtml =
        fromDom.weeklyVisitors == null || fromDom.contributions == null;
      const [subsResult, htmlStats] = await Promise.all([
        fetchSubscribers(sub),
        needHtml ? fetchWeeklyFromHtml(sub) : Promise.resolve({}),
      ]);

      const data = {
        subreddit: sub,
        subscribers: subsResult.subscribers,
        weeklyVisitors: fromDom.weeklyVisitors ?? htmlStats.weeklyVisitors ?? null,
        contributions: fromDom.contributions ?? htmlStats.contributions ?? null,
        errors: [subsResult.error].filter(Boolean),
        fetchedAt: Date.now(),
      };
      cache.set(sub, { data, fetchedAt: Date.now() });
      return data;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  // --- Rendering ---

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function statCell(label, value, title, opts = {}) {
    const cell = el("div", "rsr-cell");
    const num = el("div", "rsr-num", opts.compact ? formatCompact(value) : formatNumber(value));
    num.title = value != null ? formatNumber(value) : "Not available";
    const lab = el("div", "rsr-label", label);
    if (title) cell.title = title;
    cell.append(num, lab);
    return cell;
  }

  function buildCard(data, state) {
    const card = el("section", "rsr-card");
    card.id = "reddit-stats-restored";
    card.setAttribute("aria-label", "Subreddit stats");

    const head = el("div", "rsr-head");
    head.append(el("span", "rsr-title", "Community stats"));
    const refresh = el("button", "rsr-refresh", "↻ Refresh");
    refresh.type = "button";
    refresh.title = "Refresh stats now";
    refresh.addEventListener("click", async (e) => {
      e.preventDefault();
      refresh.disabled = true;
      refresh.textContent = "Refreshing…";
      const fresh = await loadStats(data.subreddit, { force: true });
      render(fresh, "ready");
    });
    head.append(refresh);
    card.append(head);

    const grid = el("div", "rsr-grid");
    if (state === "loading") {
      grid.append(
        statCell("Subscribers", null, "Loading…"),
        statCell("Weekly visitors", null, "Loading…"),
        statCell("Contributions", null, "Loading…"),
      );
    } else {
      grid.append(
        statCell(
          "Subscribers",
          data.subscribers,
          data.subscribers != null
            ? "Total members, from Reddit's about API. Reddit removed this from the page on Sept 9, 2025."
            : "Reddit did not return a subscriber count for this community.",
          { compact: true },
        ),
        statCell(
          "Weekly visitors",
          data.weeklyVisitors,
          data.weeklyVisitors != null
            ? "Unique visitors in the past 7 days, as shown by Reddit."
            : "Reddit did not expose a weekly visitor count on this page.",
          { compact: true },
        ),
        statCell(
          "Contributions",
          data.contributions,
          data.contributions != null
            ? "Posts + comments in the past 7 days, as shown by Reddit."
            : "Reddit did not expose a weekly contribution count on this page.",
          { compact: true },
        ),
      );
    }
    card.append(grid);

    const foot = el("div", "rsr-foot");
    const when = state === "ready"
      ? `Updated ${new Date(data.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Loading stats…";
    foot.append(el("span", "rsr-updated", when));
    foot.append(el("span", "rsr-note", "Online now is no longer published by Reddit, so it is not shown."));
    card.append(foot);
    return card;
  }

  function findInsertTarget() {
    if (isOldReddit()) {
      // Old reddit sidebar: .side > .titlebox is the community box.
      return (
        document.querySelector(".side .titlebox") ||
        document.querySelector(".side") ||
        document.querySelector("#header") ||
        null
      );
    }
    // New reddit: prefer the right-hand sidebar / community panel, then the
    // header area, then the main feed container.
    const candidates = [
      // Community info / about panel containers (selectors shift; try several).
      '[data-testid="subreddit-sidebar"]',
      'aside [data-testid="community-about"]',
      "#right-sidebar-container",
      "aside",
      '[data-testid="search-results"]',
      "main",
    ];
    for (const sel of candidates) {
      const n = document.querySelector(sel);
      if (n) return n;
    }
    return document.body;
  }

  function render(data, state) {
    const sub = data ? data.subreddit : getSubreddit();
    if (!sub) return;
    const key = `${sub}:${state}:${data ? data.fetchedAt : 0}`;
    // Avoid rebuilding the card on every MutationObserver tick.
    if (state === "ready" && currentRenderKey === key) return;
    const existing = document.getElementById("reddit-stats-restored");
    const card = buildCard(data || { subreddit: sub, fetchedAt: Date.now() }, state);
    if (existing) {
      existing.replaceWith(card);
    } else {
      const target = findInsertTarget();
      if (!target) return;
      if (isOldReddit() && target.classList.contains("titlebox")) {
        target.after(card);
      } else if (target.tagName === "ASIDE" || target.id === "right-sidebar-container") {
        target.prepend(card);
      } else {
        target.prepend(card);
      }
    }
    if (state === "ready") currentRenderKey = key;
  }

  async function run() {
    const sub = getSubreddit();
    if (!sub) return;
    if (sub !== currentSub) {
      currentSub = sub;
      currentRenderKey = "";
      const old = document.getElementById("reddit-stats-restored");
      if (old) old.remove();
    }
    // Show the card immediately with loading placeholders, then fill it in.
    render({ subreddit: sub, fetchedAt: Date.now() }, "loading");
    const data = await loadStats(sub);
    // Only render if we are still on the same subreddit (SPA navigation).
    if (getSubreddit() === sub) render(data, "ready");
  }

  // Reddit is a SPA: URL changes without a reload. Watch for them.
  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Give Reddit a beat to render the new page, then re-run.
      setTimeout(run, 400);
    }
  }
  setInterval(checkUrlChange, 1000);

  const observer = new MutationObserver(() => {
    // If Reddit re-rendered and dropped our card, put it back.
    if (getSubreddit() && !document.getElementById("reddit-stats-restored")) {
      run();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial run, plus a delayed retry — new reddit renders the sidebar late.
  run();
  setTimeout(run, 1500);
  setTimeout(run, 4000);
})();
