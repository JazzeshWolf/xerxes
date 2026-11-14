# Flip test — buy the opposite ATM on each sell alert

Generated 2026-11-14T07:10:38.652Z. 455 NEW stock alerts → **319 trades simulated**, 136 skipped. Target +5% of premium paid, intraday (square-off 15:15), entry at the open of the next 5-min candle. Net = after 1-tick slippage and charges.

| stop | trades | hit +5% | stopped | 15:15 exit | net > 0 | mean net | median net | worst | total ₹ (1 lot each) | baseline hit +5% | baseline mean net |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 5% | 319 | 44.5% | 45.8% | 9.7% | 45.8% | -1.27% | -2.28% | -15.24% | ₹-98,050 | 42.2% | -1.23% |
| 10% | 319 | 56.1% | 27.6% | 16.3% | 57.4% | -1.32% | +3.95% | -19.90% | ₹-99,520 | 49.8% | -1.49% |
| 20% | 319 | 62.1% | 14.1% | 23.8% | 63.3% | -1.59% | +4.15% | -31.31% | ₹-1,13,358 | 54.3% | -1.47% |
| none | 319 | 63.3% | 0.0% | 36.7% | 64.6% | -2.05% | +4.18% | -62.13% | ₹-1,50,292 | 55.3% | -1.49% |

Baseline = the same rules entered at every 5-min candle of the same contract on the same day, averaged per trade. The alert adds something only if it beats the baseline.

## By feed (stop 10%)

| Feed | trades | hit +5% | net > 0 | mean net | baseline mean net |
|---|---|---|---|---|---|
| premium (also stocks) | 9 | 55.6% | 77.8% | +1.31% | -0.15% |
| stocks only | 310 | 56.1% | 56.8% | -1.40% | -1.52% |

## By bought (stop 10%)

| Bought | trades | hit +5% | net > 0 | mean net | baseline mean net |
|---|---|---|---|---|---|
| CE | 85 | 54.1% | 54.1% | -1.47% | -1.44% |
| PE | 234 | 56.8% | 58.5% | -1.27% | -1.50% |

## By entry hour (ist) (stop 10%)

| Entry hour (IST) | trades | hit +5% | net > 0 | mean net | baseline mean net |
|---|---|---|---|---|---|
| 09:00 | 120 | 61.7% | 61.7% | -1.49% | -1.75% |
| 10:00 | 41 | 63.4% | 65.9% | -0.52% | -0.96% |
| 11:00 | 40 | 72.5% | 72.5% | +0.13% | -1.11% |
| 12:00 | 42 | 52.4% | 52.4% | -2.47% | -1.91% |
| 13:00 | 35 | 57.1% | 57.1% | -0.57% | -0.57% |
| 14:00 | 33 | 21.2% | 30.3% | -2.17% | -1.47% |
| 15:00 | 8 | 12.5% | 12.5% | -3.84% | -3.87% |

## By expiry (stop 10%)

| Expiry | trades | hit +5% | net > 0 | mean net | baseline mean net |
|---|---|---|---|---|---|
| 2026-10-27 | 91 | 60.4% | 60.4% | -1.66% | -1.76% |
| 2026-11-23 | 216 | 54.6% | 56.5% | -1.17% | -1.37% |
| 2026-12-29 | 12 | 50.0% | 50.0% | -1.45% | -1.48% |

## Skipped

Expired-contract API: ok.

- 42 × no candles that day
- 48 × duplicate of another alert in the same run
- 13 × illiquid (first trade N min after the alert)
- 26 × alert too late for an intraday trade
- 7 × no candle after the alert

