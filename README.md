# ⚔️ Xerxes — Index Option Screener

**Live:** https://jazzeshwolf.github.io/xerxes/

A free, mobile-first, **static** screener for selling **NIFTY / BANKNIFTY / SENSEX index options**.
It answers three questions at a glance:

1. **Which way is the index leaning?** — a multi-factor direction engine (price trend, OI flow,
   PCR, max-pain gravity, IV skew, VIX, futures basis) that resolves to a **verdict**
   (BULLISH / BEARISH / NEUTRAL) with a confidence score and the structure to sell.
2. **Where are the walls?** — the full OI profile by strike: put/call walls, max pain, ranked
   supports & resistances, today's OI build-up, and a GEX pinning read.
3. **Which strikes are worth selling?** — ranked OTM candidates with premium, delta, P(OTM),
   probability-of-touch, and cushion in units of the expected move.

> **It is a decision aid, not a signal.** The directional weights are hand-set priors, **not
> backtested**. Index option selling has unlimited tail risk — always define risk.

**Current coverage:** NIFTY (weekly, Tuesday expiry). BANKNIFTY (monthly, last Tuesday) and
SENSEX (weekly, Thursday, BSE) are next passes — the pipeline is already multi-index shaped.

## Architecture ($0)

```
GitHub Actions cron ─(every 10m, market hours)─► scripts/build-data.mjs
     │                                                    │
     │  Upstox API v2 (primary): option chain w/ OI,      ▼
     │  prev-day OI, IV, greeks · spot · VIX · history   public/data/nifty.json (committed)
     │  NSE public API (fallback, token-less)             │ reads
     │  Yahoo Finance (history fallback)                  ▼
     └────────────────────────────────────────► Preact SPA ─► GitHub Pages
```

- **No backend.** A GitHub Actions cron acts as a serverless data builder during NSE market
  hours and commits the computed snapshot. Data is ~10 min delayed — fine for a premium seller.
- Every fetch **fails soft**: on error the builder falls back down the source chain and, as a
  last resort, keeps the previous snapshot flagged `stale` — never fabricated numbers.

## Data sources

| Source | What | Auth |
|---|---|---|
| Upstox API v2 | Option chain (OI, prev OI, IV, greeks, volume), spot, India VIX, daily candles | `UPSTOX_ACCESS_TOKEN` repo secret (free 1-year read-only "Analytics" token) |
| NSE public API | Option chain + VIX (token-less; bot-protected, works intermittently from runners) | none |
| Yahoo Finance | Daily ^NSEI / ^INDIAVIX history fallback | none |

**Setup:** add your Upstox Analytics token as the `UPSTOX_ACCESS_TOKEN` repo secret
(Settings → Secrets and variables → Actions). Without it the builder still runs on the free
NSE path, just less reliably.

## What gets computed (`scripts/analytics.mjs`, unit-tested)

- **Chain aggregates:** PCR (OI + volume), max pain, put/call walls, ranked S/R, per-side
  OI build-up (needs prev OI), ATM strike/IV, ATM straddle, IV skew (±2.5% OTM), GEX regime.
- **Vol:** expected move to expiry (ATM straddle preferred, `F·σ·√t` fallback), realized vol,
  IV rank/percentile once ≥20 days of real ATM-IV history accumulate.
- **Direction engine:** 8 factors, each a signal in [−1, +1]; missing factors are dropped and
  their weight redistributed (never a silent 0). Confidence = completeness × agreement.
  Score → verdict → structure (sell puts / sell calls / iron condor / no trade).
- **Sell candidates:** OTM strikes with |Δ| ≤ 0.25 and a real premium, ranked by delta, with
  P(OTM) ≈ 1−|Δ|, probability-of-touch, and cushion in σ (expected-move units).

Options math is Black-Scholes with r≈0 (fine at weekly tenors): IV bisection solver, delta,
prob-of-touch.

## Develop

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests (options math, chain aggregates, direction engine)
npm run build      # type-check + production build to dist/
npm run build:data # run the data builder locally
# offline/dev: XERXES_FIXTURE=path/to/source.json npm run build:data
```

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on push (Pages is enabled
by the workflow itself). `.github/workflows/data.yml` is the data cron. If your repo isn't
named `xerxes`, the Pages sub-path is handled automatically via `BASE_PATH`.

## Expiry calendar (hardwired knowledge, verified Jul 2026)

| Index | Cycle | Day |
|---|---|---|
| NIFTY | weekly | Tuesday (monthly: last Tuesday) |
| BANKNIFTY | monthly only | last Tuesday |
| SENSEX (BSE) | weekly | Thursday |

The pipeline never hardcodes dates — expiries are discovered from the live instrument master.
