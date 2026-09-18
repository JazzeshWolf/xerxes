# NSE F&O ranker — measured skill

_Engine_: **momentum** (`block-bootstrap`)  
_Generated_: 2026-09-12T22:00:32.000Z  
_Horizon_: 21 trading days, rebalanced every 21

## Verdict

**NOT VALIDATED.** UNVALIDATED -- ICIR 0.27 is below the 0.30 bar

| | |
|---|---|
| **ICIR** (the number that matters) | **0.266** |
| Bar it must clear | 0.300 |
| 12-1 momentum ICIR | 0.265 |
| Random-null ICIR | 0.109 |
| **Edge over the random null** | **0.157** |
| Mean IC | 0.028 |
| IC std | 0.103 |
| t-stat | 2.025 |
| Rebalances | 58 |
| Hit rate | 65.52% |

ICIR is mean IC divided by its standard deviation across rebalances. Mean IC on its own says nothing: the same average from a signal that works every month and one that swings wildly are different products, and only the ratio distinguishes them.

**Why it did not validate:**

- ICIR 0.27 is below the 0.30 bar

## Against the benchmarks

| Arm | ICIR | Mean IC | t-stat | Gross spread / rebalance | Net of costs |
|---|---|---|---|---|---|
| **engine (under test)** | 0.266 | 0.028 | 2.025 | 0.74% | 0.62% |
| momentum_12_1 | 0.265 | 0.027 | 2.015 | 0.73% | 0.62% |
| reversal_5d | 0.013 | 0.001 | 0.099 | -0.24% | -0.61% |
| random | 0.109 | 0.007 | 0.832 | 0.22% | -0.16% |

`random` is the true null — it establishes what this harness reports when there is provably no signal. `momentum_12_1` is the one that matters commercially: it is free, and a model that cannot beat it is not earning its compute.

> **Read this first.** The engine IS the 12-1 momentum benchmark, so 'edge over momentum' is 0.00 by construction and the gate compares against the random null instead. Read the result knowing this factor was SELECTED because it scored best on the history available -- forward performance, on rebalances it was not chosen on, is the real test.

## Decile spread and costs

- Mean turnover per rebalance: **27.68%**
- Cost drag per rebalance: **0.12%**
- Gross annualised: **8.85%**
- Net annualised (impact 20.0 bps): **7.45%**
- Round-trip cost assumption: **42.22 bps**

Impact cost is a prior, not a measurement, and it is usually the largest single term. The result at each assumption:

| Impact (bps) | Round trip (bps) | Net / rebalance | Net annualised |
|---|---|---|---|
| 10.0 | 32.22 | 0.65% | 7.78% |
| 20.0 | 42.22 | 0.62% | 7.45% |
| 30.0 | 52.22 | 0.59% | 7.12% |

> The decile spread is a **measure of ranking skill**, not a strategy this repo proposes trading. The short leg is not shortable in Indian equity delivery, so a real implementation would use single-stock futures with a different cost stack. The product here is the lean — which side of the chain to sell.

## Neutralisation

| | Beta rank corr | Sector R² |
|---|---|---|
| Before | 0.129 | 0.278 |
| After | -0.080 | 0.000 |
| Bar | ≤ 0.2 | ≤ 0.15 |

Neutralisation is working: post-neutralisation beta correlation and sector R^2 are both inside their bars.

If the *after* row had not fallen, the ranking would be market beta or a sector bet wearing a stock-selection costume — and it would still look like a working model.

## Corporate actions

- Detected: **1** across 1 names (0.48 per 100 symbols)
- Large moves examined and kept as real returns: 11

1 action(s) across 1 name(s) -- far below what an unadjusted feed would show. The feed is likely adjusted and these are probably genuine large moves that resembled split ratios. Inspect them before trusting the affected names.

## Data depth (measured, not assumed)

- Oldest bar: **2020-09-14**
- Newest bar: **2026-09-11**
- Trading days: **1489** (~5.96 years, requested 6)

Measured from what Upstox actually returned, not assumed. If approxYears is well below requestedYears, the API's depth -- not the request -- is the binding constraint.

## Survivorship bias

- Rebalances on point-in-time membership: **0** of 58
- Rebalances using today's list for a past date: **58**

`fallback` dates used the current F&O list for a past date and therefore carry survivorship bias. Snapshots only accumulate going forward, so early runs are expected to be all fallback.

