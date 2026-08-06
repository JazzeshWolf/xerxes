# Xerxes stock-refresh Worker

A tiny Cloudflare Worker (free tier) that powers the **on-demand per-stock
refresh** in the app. The site is static and the Upstox token lives only in
GitHub Actions, so the browser can't recompute a chain itself. This Worker is the
one small piece of glue:

- `POST /refresh?symbol=INDIGO` — fires the `stocks.yml` workflow to rebuild just
  that symbol (~30–60 s).
- `GET /data?file=INDIGO` — returns that stock's freshly-published JSON via the
  GitHub Contents API (authenticated + fresh; bypasses raw.githubusercontent's
  ~5-min CDN cache). Used by the app to poll for the rebuilt snapshot.

The app works **without** this Worker — the stock Refresh simply re-pulls the last
published snapshot. Deploy it only when you want true on-demand refresh.

## One-time setup (~5 min, all free)

1. **Create a fine-grained GitHub PAT** — github.com → Settings → Developer
   settings → Fine-grained tokens → *Generate new token*:
   - **Repository access:** only `JazzeshWolf/xerxes`.
   - **Permissions:** *Actions* → **Read and write** (to dispatch the workflow),
     *Contents* → **Read-only** (to read the `stocks-data` files).
   - Copy the token (starts with `github_pat_…`).

2. **Deploy the Worker:**
   ```bash
   cd worker
   npm i -g wrangler          # if you don't have it
   wrangler login             # opens a browser once
   wrangler secret put GH_PAT # paste the PAT from step 1
   wrangler deploy
   ```
   Deploy prints your Worker URL, e.g.
   `https://xerxes-stock-refresh.<your-subdomain>.workers.dev`.

3. **Point the app at it** — add a repository **variable** named
   `STOCK_REFRESH_URL` (Settings → Secrets and variables → Actions → *Variables*)
   set to that Worker URL. The next Pages deploy bakes it in
   (`VITE_STOCK_REFRESH_URL`); until then the app falls back to re-pull.

## Config

Non-secret settings are in `wrangler.toml` `[vars]` — `REPO`, `CODE_BRANCH`
(the branch whose `stocks.yml` runs), `DATA_BRANCH` (`stocks-data`), and
`ALLOW_ORIGIN` (your Pages origin, for CORS). Change these if you fork the repo or
serve from a custom domain. `GH_PAT` is a secret — set via `wrangler secret put`,
never in the file.

## Notes

- Free tier is 100k requests/day — far beyond what manual refreshes need.
- The PAT is scoped to this one repo (Actions RW + Contents R). Rotate it on your
  own cadence; note it alongside the Upstox-token rotation reminder.

## Reliable market-hours refresh (bypass GitHub's flaky scheduler)

GitHub `schedule:` triggers are best-effort — in practice GitHub drops most of
them and delays the rest 20–40 min, so the stock data can sit hours stale during
market hours even though the workflow itself is fine. The robust fix is to fire
the rebuild from an **external** cron. Unlike `schedule`, a `workflow_dispatch`
sent via the API runs **immediately**, so an outside pinger gives dependable
freshness. (Leave the in-repo `schedule:` as a backup — it still fires sometimes.)

Easiest option — **cron-job.org** (free), calling GitHub directly with the same
fine-grained PAT you made above (needs *Actions: Read and write*):

- **URL:** `https://api.github.com/repos/JazzeshWolf/xerxes/actions/workflows/stocks.yml/dispatches`
- **Method:** `POST`
- **Request headers:**
  - `Authorization: Bearer github_pat_…`
  - `Accept: application/vnd.github+json`
  - `Content-Type: application/json`
  - `User-Agent: xerxes-cron`   (GitHub rejects requests with no UA)
- **Body:** `{"ref":"claude/nifty-option-screener-93xv0y","inputs":{"symbol":""}}`
  (empty symbol = full-universe rebuild)
- **Schedule (set the account timezone to IST):** every ~20 min, ~09:20–15:40,
  Mon–Fri. That's the whole session plus a post-close snapshot.

Each ping triggers a fresh full run (~30–60 s) and the screener updates. The
`concurrency: refresh-stocks` group means overlapping pings just queue, never
collide. To also keep the **indices** fresh, add a second cron-job.org job with
the same headers but URL `.../workflows/data.yml/dispatches` and body
`{"ref":"claude/nifty-option-screener-93xv0y"}`, every ~10 min in market hours.
