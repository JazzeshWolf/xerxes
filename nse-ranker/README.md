# NSE F&O cross-sectional ranker (Kronos)

Ranks the ~190-name NSE F&O single-stock universe each day by forecast forward
return, into deciles. Top decile → lean bullish → prefer selling puts. Bottom
decile → lean bearish → prefer selling calls.

**The ranking is the product.** No single name's forecast is meant to carry a
position. The reason is the Fundamental Law of Active Management,
`IR ≈ IC × √breadth`: an information coefficient of 0.03 on one stock is noise,
and the same IC across 190 stocks simultaneously is a strategy. That is why the
universe is never trimmed to save compute, and why the fallback ladder for a
runner-budget problem is *reduce sample_count → drop to Kronos-mini → shard the
job*, never *rank fewer names*.

---

## Read this first: what was and was not measured

This service was built in a sandbox whose egress policy **blocks
huggingface.co** (a 403 on CONNECT, logged proxy-side — a policy denial, not a
transient failure) and which **cannot reach `api.upstox.com` or
`assets.upstox.com`** at all. That has concrete consequences, and pretending
otherwise would make every number below meaningless.

| Question | Status |
|---|---|
| Does the Kronos engine work? | **Unknown — never executed.** Written against the documented API. First real run is CI. |
| Is Kronos's ICIR above the bar? | **Not measured.** No weights, no data, no walk-forward result. |
| Does it beat 12-1 momentum? | **Not measured.** |
| How far back do Upstox daily candles go? | **Not measured here — measured at run time** and written into `skill.json → dataDepth`. |
| Are Upstox candles corporate-action adjusted? | **Yes — measured on the first live run.** 1 detection across 206 names; an unadjusted feed would show dozens. The detector stays on as a regression guard. |
| Does the pipeline work end to end? | **Yes**, verified on synthetic data (`python -m ranker.cli demo`). |
| Does the validation harness measure skill correctly? | **Yes**, and this is tested directly — see below. |

Because of this, **the Kronos tab ships gated shut.** Its default state is
"skill not yet measured", the lean column renders muted, and every implication
is prefixed *Unproven*. It only unlocks when a real `skill.json` reports an ICIR
clearing `config.MIN_ICIR` **and** beating momentum by `MIN_ICIR_EDGE_OVER_MOMENTUM`.
There is no way to make the page look confident without producing the number
that justifies it.

### What *is* verified

`74 pytest + 32 vitest` tests, all green. The ones that matter most are in
`tests/test_backtest.py`, which validates the validator against data whose answer
is known by construction:

- given a planted, provably predictive signal, the harness reports IC > 0.10;
- given pure noise, it reports |mean IC| < 0.05 — **a harness that finds skill in
  random input would validate anything**, so this is the load-bearing test;
- the panel accessors are checked structurally to never return a bar later than
  the decision date.

---

## Layout

```
nse-ranker/
  ranker/
    config.py        every hand-set constant, each with a reason
    universe.py      F&O membership from the instrument master + per-date snapshots
    upstox.py        daily OHLCV client (stdlib only)
    corpactions.py   split/bonus detection and back-adjustment
    panel.py         the aligned price matrix; the only lookahead-safe accessors
    neutralize.py    demean → beta-neutralise → sector-neutralise
    ranking.py       ranks, percentiles, deciles
    ic.py            IC, ICIR, t-stat
    costs.py         Indian retail costs incl. impact; turnover
    benchmarks.py    momentum 12-1, 5-day reversal, random
    backtest.py      walk-forward + the pass/fail verdict
    engines/         bootstrap (baseline) and kronos, same interface
    pipeline.py      daily run and validation run
    report.py        the readable report
    cli.py           probe | daily | validate | demo
```

`numpy` is the only third-party dependency of everything except `engines/kronos.py`.
torch enters through exactly one lazy import (`engines.get_engine("kronos")`), and
a test asserts that `import ranker` never pulls it in.

## Running it

```bash
cd nse-ranker
pip install -r requirements.txt
python -m pytest                      # 74 tests, no network, no weights

python -m ranker.cli demo             # synthetic end-to-end, writes a full payload
UPSTOX_ACCESS_TOKEN=… python -m ranker.cli probe      # measure Upstox history depth
UPSTOX_ACCESS_TOKEN=… python -m ranker.cli daily --engine bootstrap
UPSTOX_ACCESS_TOKEN=… python -m ranker.cli validate --engine kronos
```

`demo` output is stamped `"demo": true` and the UI refuses to present it as a
real ranking — a fixture that can masquerade as a live signal is worse than no
fixture.

## Workflows

| Workflow | Cadence | Writes |
|---|---|---|
| `ranker.yml` | daily, 16:00 IST (30 min after close) | `index.json` + per-name detail |
| `ranker-validate.yml` | weekly, Sat | `skill.json` + `REPORT.md` |

Both publish to the force-pushed **`ranker-data`** branch, mirroring what
`stocks.yml` does with `stocks-data`: an orphan commit each run, so a full
payload rewrite never grows history. Neither touches `data.yml`, `stocks.yml`,
`build-data.mjs`, `build-stocks.mjs`, or `public/data/*.json`.

Validation is separate because it is 30–60× the cost of a daily run: it
re-forecasts the whole universe at every historical rebalance date.

**The seed step is load-bearing.** `ranker-data` is republished as an orphan
commit, so seeding from it is the only thing carrying `universe-snapshots/`
(the point-in-time membership record, the sole defence against survivorship
bias) and `skill.json` forward. Break that step and survivorship bias silently
returns. This is the same trap `stocks.yml` documents for `ivHistory`.

---

## Design decisions worth knowing

### Neutralisation is not optional

A model applied to 190 names on one day sees one market. If it likes the index it
likes nearly everything, and the resulting "ranking" is an ordering of **beta** —
a leveraged index bet in costume. Same one level down for sectors.

Neither failure looks like an error. The ranking looks fine and the IC may even
look good, because beta and sector genuinely predict returns in a trending
market. So the pipeline reports `betaRankCorr` and `sectorR2` **before and after**
neutralisation, and the tab shows both. If the *after* row has not fallen inside
its bar, the ranking is not stock selection and the page says so.

### Corporate actions are the most likely silent failure

On an unadjusted feed a 2:1 split prints a clean −50% day. In a cross-sectional
ranker that does not add noise — it adds a large fake negative return that lands
the name in the bottom decile with total confidence.

Close-to-close alone cannot separate a 2:3 split from a real −33% session, so
detection uses three pieces of evidence: proximity to a round ratio, **whole-bar
repricing** (on a split the day's high is also at the new level; in a crash it is
still near the prior close — this does most of the work), and volume expansion.
Ratios a real move could imitate additionally require corroboration. Every
decision, accepted *and rejected*, is published.

If the feed turns out to be already adjusted, detection finds ~nothing, and that
near-zero count is itself the answer — `audit()` says so in words.

### The bootstrap baseline is not a null

Resampling a name's own history gives a terminal median near
`mean(daily return) × horizon`, which is a long-horizon **drift/momentum** signal.
It is a real (weak) baseline, not "random". The true null is the `random`
benchmark. Both are reported, because "beats the bootstrap" and "better than
nothing" are different claims.

### Rebalance spacing equals the forecast horizon

`REBALANCE_EVERY == PRED_LEN` so the IC series does not overlap. Overlapping
windows autocorrelate the ICs and inflate ICIR and the t-stat — the two numbers
this exercise exists to measure honestly. If the spacing is ever set below the
horizon, `summarize()` is told and labels the result inflated, and `verdict()`
refuses to validate it.

### Impact cost is modelled, and stressed

Brokerage, STT, exchange charges, GST and stamp duty are published numbers.
Impact is not, is usually the largest single term for retail size in a mid-cap,
and is the one most often omitted — which is the standard way a losing backtest
becomes a winning one. It is a **prior**, so the report shows the net result at
10/20/30 bps rather than one unstressed guess.

### The decile spread is a skill measure, not a strategy

The short leg is not shortable in Indian equity delivery; a real implementation
would be single-stock futures with a different cost stack. The spread exists to
say whether the ranking underneath the lean is worth anything. The product is the
lean.

### Today's close comes from the quote, not the candle

Upstox's historical-candle endpoint **excludes the running session**. The first
live run exposed this: it published a 2026-08-10 ranking at 21:52 IST on 08-11 —
forty minutes *after* the index pipeline had already recorded an 08-11 bar. A job
scheduled for "16:00 IST, after the close" was ranking the previous day.

`build-data.mjs` already solves this by merging the live quote into its spot
history, and `append_todays_close` does the same. Two guards on it:

* **A clock gate.** Before 15:40 IST the "close" would be an intraday print, so
  nothing is appended and the ranking is honestly T-1.
* **A universe-level movement check.** The quote endpoint answers on holidays
  too, echoing yesterday's price. Appending that would put a fabricated flat bar
  on ~200 names and corrupt every return series — silently, and looking exactly
  like data. So a session is only believed when at least
  `MIN_MOVED_FRACTION` of the universe has moved off its last close.

### Kronos's `sample_count` averages

`predict(..., sample_count=N)` averages its N sampled paths and returns one
series — it does not hand back the distribution. Averaging is the right
low-variance estimator for *ranking*, so it stays the signal; the cone's spread
comes from a small number of extra single-sample passes, run only in the daily
job. The published per-step band is computed from every sample, so the chart's
median line and the headline forecast cannot disagree.

---

## Known gaps

- **The sector map needs refreshing when NSE revises the F&O list.** The first
  live run derived 206 underlyings and found 51 with no sector — a quarter of
  the universe pooled into one `OTHER` bucket, which is not sector-neutralisation
  in any useful sense. Those are now mapped (coverage 206/206), but the same drift
  will recur: check `sector == "UNMAPPED"` in `index.json` after any F&O revision.
- **Survivorship bias is present on early runs.** `universe-snapshots/` can only
  accumulate going forward, so until it has history the backtest uses today's
  F&O list for past dates. The report counts point-in-time vs fallback dates
  rather than hiding it.
- **Kronos runtime on a 2-core runner is unmeasured.** If 190 names × 21 steps ×
  30 samples does not fit, cut `SAMPLE_COUNT`, then switch to `KRONOS_MINI_MODEL`.
  Do not cut the universe.
- **`predict_batch`'s exact signature is unverified.** The engine falls back to a
  `predict()` loop with a loud warning if it does not match.
- Weights (`MIN_ICIR`, the cost priors, the neutralisation bars) are hand-set
  priors, not fitted — the same caveat this repo already applies to
  `sellConviction`.
