# Reddit Stats Restored

A Chrome / Chromium extension that puts subreddit stats back in-page on reddit.com.

Reddit removed the public Member count from every subreddit page on **Sept 9, 2025**, replacing it with Visitors and Contributions. This extension restores the numbers where they used to be — in the subreddit page itself, no popup, no toolbar click needed.

## What it shows

| Stat | Source |
| --- | --- |
| **Subscribers** | `https://www.reddit.com/r/<sub>/about.json` → `data.subscribers`. Reddit removed it from the page, but the API still returns it. |
| **Weekly visitors** | Reddit's own 7-day Visitors number. Not in `about.json` — read from the loaded page (`weekly-active-users` attribute / visible "Visitors" text), falling back to fetching the www.reddit.com HTML and parsing the same value. |
| **Contributions** | Reddit's own 7-day Contributions number (posts + comments in the past 7 days), read the same way as Weekly visitors. |

**Deliberately not shown: "online now" / current visitors.** Reddit stopped publishing `active_user_count` — it has been null since at least July 2026 — so there is no honest source for it. This extension never invents a number. The card says so in its footer.

## Where it shows

- **In-page only.** A "Community stats" card is injected into the subreddit page:
  - New reddit (`www.reddit.com/r/...`): at the top of the right-hand sidebar / community panel.
  - Old reddit (`old.reddit.com/r/...`): under the titlebox in the left sidebar.
- No popup, no background page, no badge. Reddit is a single-page app, so the extension watches for navigation between subreddits and re-renders the card.
- A ↻ Refresh button on the card bypasses the 5-minute in-memory cache.

## Install (load unpacked)

Works in Chrome, and in Chromium browsers that support MV3 extensions (Vivaldi, Brave, Edge).

1. Download / clone this repo.
2. Open `chrome://extensions` (in Vivaldi: `vivaldi://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this repo folder.
5. Open any subreddit, e.g. `https://www.reddit.com/r/AskReddit/` — the "Community stats" card should appear in the sidebar.

To update after pulling new code: click the reload icon on the extension card in `chrome://extensions`, then reload the Reddit tab.

## Privacy

- No data leaves your browser except two fetches to `reddit.com`, both for the subreddit you are already viewing: `about.json` and (only if the page didn't already contain them) the subreddit HTML.
- No tracking, no analytics, no login, no account, no history stored. Cache is in-memory only and lasts 5 minutes.
- No permissions beyond `reddit.com` host access for the content script.

## Limitations (honest ones)

- **Reddit blocks automated browsers.** My own cloud browser was blocked by Reddit's network-security page when I tried to verify the live DOM — Reddit said it does not allow unauthorized agents. The DOM selectors in v1 are therefore built from published sources (the `weekly-active-users` attribute, Reddit's own Visitors/Contributions labels) and from `about.json`, not from a live-verified page load. If Reddit changes its markup, the Weekly visitors / Contributions fields will show "—" instead of a wrong number, and the card will still show Subscribers from the API. Please report a broken layout with the subreddit URL and what you see.
- Subscribers can be `—` if Reddit returns an error for `about.json` (rate-limit / logged-out block). Reloading the tab usually fixes it.
- Private, quarantined, and banned subreddits return no public stats.

## Development

No build step. Edit `src/content.js` / `src/content.css`, reload the extension in `chrome://extensions`, reload the Reddit tab.

- `manifest.json` — MV3 manifest, content script on `www.reddit.com/r/*` and `old.reddit.com/r/*`.
- `src/content.js` — subreddit detection, fetching, DOM/HTML parsing, rendering, SPA navigation handling.
- `src/content.css` — card styling, light/dark aware.
- `icons/` — extension icons (16/32/48/128).

## License

MIT — see `LICENSE`.
