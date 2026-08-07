# Xerxes — working notes

Operator + agent handoff doc. `README.md` covers the original index screener
(architecture, data sources, analytics, deploy). **This file covers everything
added since, plus the operational knowledge that isn't obvious from the code.**

Branch: `claude/nifty-option-screener-93xv0y` (this is the de-facto main branch —
Pages deploys and data commits both target it).

---

## The three moving parts

1. **Indices** (NIFTY / BANKNIFTY / SENSEX) — `scripts/build-data.mjs` →
   `public/data/{nifty,banknifty,sensex,market}.json`, committed to the code
   branch by `.github/workflows/data.yml`.
2. **Stocks** (~157 NSE F&O names) — `scripts/build-stocks.mjs` →
   published to the **`stocks-data` branch** (NOT the code branch) by
   `.github/workflows/stocks.yml`.
3. **Frontend** — Preact/Vite, deployed to `gh-pages` by `deploy.yml`, reads data
   from raw.githubusercontent (per-branch) with a Pages copy as fallback.

### Why stocks data lives on its own branch
~157 per-stock JSONs get rewritten every run. Committing those to the code branch
added ~7 MB of git objects per run. `stocks.yml` publishes them to `stocks-data`
with `peaceiris force_orphan: true` → **the branch is replaced by a single commit
each run, so history never grows**. `public/data/stocks/` is gitignored so it can
never re-enter code-branch history.

---

## ⚠️ Scheduling: GitHub's cron is NOT reliable — external cron does the work

GitHub `schedule:` triggers are best-effort. In practice GitHub **dropped most
runs and delayed the rest 20–40 min**, leaving data hours stale during market
hours. The in-repo `schedule:` blocks are kept only as a weak backup.

**The real scheduler is cron-job.org** (free), owned by the user, firing
`workflow_dispatch` via the GitHub API — which runs *immediately*, unbypassed by
throttling. Two jobs exist:

| Job | Workflow | Cadence (IST, Mon–Fri) |
|---|---|---|
| `xerxes stocks` | `stocks.yml` | every 20 min, 9–15 |
| `xerxes indices` | `data.yml` | every 10 min, 9–15 |

Both POST to
`https://api.github.com/repos/jazzeshwolf/xerxes/actions/workflows/<file>/dispatches`
with headers `Authorization: Bearer <PAT>`, `Accept: application/vnd.github+json`,
`Content-Type: application/json`, `User-Agent: xerxes-cron`.
Body: stocks `{"ref":"claude/nifty-option-screener-93xv0y","inputs":{"symbol":""}}`,
indices `{"ref":"claude/nifty-option-screener-93xv0y"}` (no `inputs`).
Setup steps are documented in `worker/README.md`.

**If data goes stale during market hours, check in this order:**
1. cron-job.org dashboard — are both jobs **enabled** with a *Next execution*?
   (A "test run" does NOT save a job — a classic trap.)
2. Recent `workflow_dispatch` runs in Actions — firing? succeeding?
3. The PAT — expired/revoked → every cron 401s.
4. The Upstox token — expired → runs "succeed" but preserve stale data (fail-soft).

**Stale data outside market hours is normal and correct** — NSE/BSE are closed, so
the last post-close snapshot is final until the next open. Don't debug that.

---

## 🔑 Credentials & expiry (the things that will silently break this)

| Secret | Where | Expires | Symptom when dead |
|---|---|---|---|
| `UPSTOX_ACCESS_TOKEN` | repo secret (Actions) | ~1 yr from issue | runs succeed, data frozen/`stale:true` |
| GitHub PAT `xerxes-cron` | cron-job.org headers | **2027-08-05** | crons 401, data stops refreshing |
| `STOCK_REFRESH_URL` (optional) | repo *variable* | n/a | in-app Refresh falls back to re-pull |

---

## Frontend notes

### Theming (dark / light / system)

`src/lib/theme.ts` owns the mode (`system | light | dark`, persisted at
`xerxes.theme`); `ThemeToggle` cycles it and sits in all four top-level headers.
The resolved value is stamped as `data-theme` on `<html>` — also by a blocking
script in `index.html`, so there's no dark flash before the bundle loads. There
is **no `prefers-color-scheme` CSS block**: `system` is resolved in JS so
`data-theme` stays the single source of truth.

How one attribute repaints everything: the UI is written almost entirely in
alpha-white utilities (`text-white/50`, `bg-white/[0.04]`), and Tailwind v4
compiles those to `color-mix(… var(--color-white) …)`. `style.css` re-points
`--color-white` at an ink token via `@theme inline`, so light mode is the same
design with the ink inverted rather than a second stylesheet. The accent ramps
are remapped the same way (300/400 shades wash out on white → light uses the
600/700 steps).

Two traps if you touch this:
- **Dark mode must stay pixel-identical.** The dark ramp restates Tailwind's
  *oklch* defaults verbatim. Substituting the sRGB hexes (`#34d399` etc.) looks
  equivalent but renders a step less saturated and silently restyles the app.
- **SVG charts can't use `var()` in presentation attributes.** They go through
  `style={{ fill: … }}` reading `src/lib/palette.ts`, which points at the
  `--x-c-*` chart tokens. Those hold the *sRGB literals* the charts always used
  — deliberately not aliased to the oklch ramp, for the reason above.

Verified by screenshot-diffing dark against the pre-theme build: identical
outside the header band where the toggle was added.

- **Indices**: tabs Verdict / Chain / Holistic / Outlook / News / Position.
- **Stocks**: `StockScreenerView` (search + liquidity/structure list + top
  premium-selling candidates) → `StockDashboard` (reuses the index tab components;
  tabs Verdict / Chain / Holistic / Position — no macro Outlook/News per stock).
- The index `Dashboard` and its tabs are **deliberately untouched** by stock work —
  the user was emphatic about this. Stock UI duplicates the shell rather than
  parameterising the index one.
- `Snapshot.index` is `string` (IndexKey for indices, NSE symbol for stocks). Only
  `PositionTab` reads it (localStorage key); nothing does `INDEX_META[snap.index]`.
- Screener rows **emphasise whichever field is being sorted** and dim the rest —
  added because a bold LIQUIDITY badge made conviction-sorted lists look wrong.
  Note the sort field named `conviction` is now the **sell**-conviction score;
  the old meaning (|direction score|) survives as `signal`.
- The candidates card has a **Current / Next expiry** switch fed by
  `candidates.json → expiries[]`. Each block is gated on **its own** liquidity
  cohort, so a short or empty next-expiry list is correct, not a bug — far-month
  NSE single-stock chains really are thin. `thin: true` renders the warning.
- Candidate rows expand into their factor breakdown; `VolPremiumCard` (stock-only)
  carries the IV-vs-forecast-RV case on the stock dashboard.
- Refresh buttons: if `VITE_STOCK_REFRESH_URL` is set they trigger a real rebuild
  and poll; otherwise they just re-pull the last published snapshot.

## Analytics (`scripts/analytics.mjs`, unit-tested — keep tests passing)

Beyond the README's list: `futuresStructure` (price×OI quadrants),
`liquidityScore` + `liquidityBucket` (cross-universe percentile → High…None).
Verdicts are computed **per expiry** (`directionScore` per block) so the read
follows the selected horizon; `snap.horizons` maps 1W/1M/2M → nearest expiry with
a `fallback` flag (BANKNIFTY/stocks have no weeklies).

Position analyzer (`src/lib/position.ts`): multi-leg payoff, breakevens,
POP + expected P&L (lognormal), net delta/theta, and a rule-based fit assessment.

### The predictive layer (stock selling candidates)

Everything above answers *what does the chain look like now*. The section at the
bottom of `analytics.mjs` answers the different question *is selling this strike
into this expiry likely to pay*, and it is what the stock candidate list ranks by.

**The load-bearing idea**: the market prices the option at its implied vol; we
value it at our forecast of realized vol plus a small drift. The gap between the
premium collected and that fair value is the expected edge (`candidateEdge`),
normalised by a margin proxy so a ₹200 and a ₹4,000 stock compete fairly.

Why it must be measured per name rather than assumed: **Driessen, Maenhout &
Vilkov (2009, J. Finance)** found individual-equity variance risk is essentially
*not* priced — the index variance premium comes from correlation risk. "Sell
premium because premium is rich" is simply false for single stocks.

What replaced what:

| Old | Why it was wrong | New |
|---|---|---|
| `ltp` (raw ₹) | favours expensive stocks, not good trades | `edgePct` on a margin proxy |
| `probProfit = 1−\|Δ\|` | risk-neutral ⇒ fair by construction, zero information | `pMeasureProb` at forecast vol + drift |
| `cushionSigma` ÷ straddle | circular: high IV ⇒ looks "safe" | `cushionSigmaF` ÷ **forecast** σ |
| direction ignored | "Sell CE" on a long-buildup name | `direction` factor, 0.15 weight |

Pieces, all pure and unit-tested:
- `yangZhangVol` — gap-aware OHLC realized vol (~14× more efficient than
  close-to-close). `upstox.dailyCandles` now returns `ohlc` for this; `history`
  stays close-only so the index pipeline is untouched.
- `gapProfile` / `forecastVol` — share of variance arriving overnight, and the
  horizon-matched vol forecast (inflated for gappy names).
- `termStructure`, `cpIvSpread` (Cremers-Weinbaum), `putSmirk` (Xing et al.).
- `sellConviction` — the blended 0-100 score. **Same contract as `directionScore`**:
  components emit s ∈ [0,1], missing ones drop and redistribute pro-rata. Weights
  are hand-set priors, not backtested — same honesty caveat as the direction engine.
- Only the **gap-risk haircut** is aggressive (a multiplier, plus a note). Term
  structure, smirk and direction are scoring components; physical-settlement risk
  (`deliveryRisk`) is a **badge, never a filter** — NSE stock options settle
  physically and ITM shorts face ~40%-of-contract-value margin near expiry.

**IV rank needs history and history needs the seed step.** `stocks.yml` seeds
`public/data/stocks` from the `stocks-data` branch on **every** run (not just
single-symbol) — since that branch is republished as an orphan commit each time,
seeding is the only thing carrying each stock's `ivHistory` forward. Break that
step and IV rank silently never accrues. `ivRank`/`ivPercentile` stay `null` below
20 points and their weight redistributes; `vrp` (IV ÷ forecast RV) carries the same
information from the first run, which is why the feature shipped useful on day one.

The cross-universe list caps **2 strikes per symbol** — without it one rich name's
strike ladder fills the whole list with near-identical trades.

---

## Gotchas learned the hard way

- **Sandbox can't reach Upstox/Google News/raw.githubusercontent** — always verify
  data changes by triggering the real workflow, not locally.
- **Never commit `public/data/*.json`** from a local/fixture run — `git checkout`
  them before committing; the runner regenerates real data.
- Playwright screenshots: abort `**raw.githubusercontent.com**` so the Pages
  fallback loads immediately, else the page sits in a loading state.
- `pkill -f "vite preview"` matches its own shell → exit 144; harmless but noisy.
- Browser caching hides deploys — verify with a private tab / check the build id
  in the header before concluding a change didn't ship.

## Backlog (not started)

- Chain tab: tap-a-strike tooltip + IV-smile overlay.
- Build-time warning when the Upstox token is near expiry.
- Optional: deploy the Cloudflare Worker (`worker/`) to enable true on-demand
  in-app refresh (steps in `worker/README.md`).
