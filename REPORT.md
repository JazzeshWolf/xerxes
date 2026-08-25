# NSE F&O ranker — measured skill

_Engine_: **bootstrap** (`block-bootstrap`)  
_Generated_: 2026-08-25T08:14:09.000Z  
_Horizon_: 21 trading days, rebalanced every 21

## Verdict

**NOT VALIDATED.** UNVALIDATED -- ICIR beats 12-1 momentum by only -0.05 (need +0.05) -- momentum is free, so this model is not earning its compute

| | |
|---|---|
| **ICIR** (the number that matters) | **0.302** |
| Bar it must clear | 0.300 |
| 12-1 momentum ICIR | 0.353 |
| **Edge over momentum** | **-0.051** |
| Mean IC | 0.030 |
| IC std | 0.100 |
| t-stat | 2.303 |
| Rebalances | 58 |
| Hit rate | 62.07% |

ICIR is mean IC divided by its standard deviation across rebalances. Mean IC on its own says nothing: the same average from a signal that works every month and one that swings wildly are different products, and only the ratio distinguishes them.

**Why it did not validate:**

- ICIR beats 12-1 momentum by only -0.05 (need +0.05) -- momentum is free, so this model is not earning its compute

## Against the benchmarks

| Arm | ICIR | Mean IC | t-stat | Gross spread / rebalance | Net of costs |
|---|---|---|---|---|---|
| **Kronos/engine** | 0.302 | 0.030 | 2.303 | 0.54% | 0.39% |
| momentum_12_1 | 0.353 | 0.036 | 2.689 | 1.28% | 1.16% |
| reversal_5d | 0.203 | 0.016 | 1.547 | 0.59% | 0.22% |
| random | 0.206 | 0.014 | 1.566 | 0.36% | -0.01% |

`random` is the true null — it establishes what this harness reports when there is provably no signal. `momentum_12_1` is the one that matters commercially: it is free, and a model that cannot beat it is not earning its compute.

## Decile spread and costs

- Mean turnover per rebalance: **35.64%**
- Cost drag per rebalance: **0.15%**
- Gross annualised: **6.45%**
- Net annualised (impact 20.0 bps): **4.65%**
- Round-trip cost assumption: **42.22 bps**

Impact cost is a prior, not a measurement, and it is usually the largest single term. The result at each assumption:

| Impact (bps) | Round trip (bps) | Net / rebalance | Net annualised |
|---|---|---|---|
| 10.0 | 32.22 | 0.42% | 5.08% |
| 20.0 | 42.22 | 0.39% | 4.65% |
| 30.0 | 52.22 | 0.35% | 4.22% |

> The decile spread is a **measure of ranking skill**, not a strategy this repo proposes trading. The short leg is not shortable in Indian equity delivery, so a real implementation would use single-stock futures with a different cost stack. The product here is the lean — which side of the chain to sell.

## Neutralisation

| | Beta rank corr | Sector R² |
|---|---|---|
| Before | 0.228 | 0.300 |
| After | -0.014 | 0.000 |
| Bar | ≤ 0.2 | ≤ 0.15 |

Neutralisation is working: post-neutralisation beta correlation and sector R^2 are both inside their bars.

If the *after* row had not fallen, the ranking would be market beta or a sector bet wearing a stock-selection costume — and it would still look like a working model.

## Corporate actions

- Detected: **1** across 1 names (0.48 per 100 symbols)
- Large moves examined and kept as real returns: 12

1 action(s) across 1 name(s) -- far below what an unadjusted feed would show. The feed is likely adjusted and these are probably genuine large moves that resembled split ratios. Inspect them before trusting the affected names.

## Data depth (measured, not assumed)

- Oldest bar: **2020-08-25**
- Newest bar: **2026-08-24**
- Trading days: **1489** (~5.96 years, requested 6)

Measured from what Upstox actually returned, not assumed. If approxYears is well below requestedYears, the API's depth -- not the request -- is the binding constraint.

## Survivorship bias

- Rebalances on point-in-time membership: **0** of 58
- Rebalances using today's list for a past date: **58**

`fallback` dates used the current F&O list for a past date and therefore carry survivorship bias. Snapshots only accumulate going forward, so early runs are expected to be all fallback.

