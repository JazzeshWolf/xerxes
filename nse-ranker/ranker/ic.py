"""
Information Coefficient and its dispersion.

## Why ICIR, not IC

Mean IC alone is close to meaningless. A signal averaging IC 0.04 with a
standard deviation of 0.04 across rebalances is a strategy; the same mean IC
with a standard deviation of 0.20 is noise that happened to average out over the
sample. The ratio is what survives contact with a live account, so this module
treats **ICIR = mean(IC) / sd(IC)** as the headline and mean IC as supporting
detail.

The Fundamental Law of Active Management is the reason breadth matters here:
``IR ~= IC * sqrt(breadth)``. An IC of 0.03 on one name is nothing; the same IC
across 190 names simultaneously is a real edge. This is why the universe is
never cut to save compute -- breadth *is* the edge.

## The t-stat and its honest caveat

``t = mean / (sd / sqrt(n)) = ICIR * sqrt(n)``, testing mean IC != 0 across
rebalance dates. It assumes the IC series is independent across dates, which
holds only if the forecast horizon does not exceed the rebalance spacing. The
backtest sets ``REBALANCE_EVERY == PRED_LEN`` for exactly this reason:
overlapping windows autocorrelate the IC series and inflate both ICIR and t.
`summarize()` carries a `overlapping` flag so a caller that breaks that rule
cannot quietly publish an inflated number.
"""

from __future__ import annotations

import math

import numpy as np

from .ranking import rank_correlation


def information_coefficient(predicted: np.ndarray, realized: np.ndarray) -> float:
    """Spearman rank correlation of predicted vs realised forward return.

    Rank correlation rather than Pearson because the product is a *ranking*: we
    care whether the order was right, not whether the magnitudes were calibrated
    (they are not, and the neutralisation step makes them even less so).
    """
    return rank_correlation(predicted, realized)


def summarize(ics: list[float], overlapping: bool = False) -> dict:
    """Turn a per-rebalance IC series into the scorecard numbers.

    Uses the sample standard deviation (ddof=1): with 30-60 rebalances the
    population form would flatter ICIR by a few percent for no good reason.
    """
    arr = np.asarray([x for x in ics if x is not None and np.isfinite(x)], dtype=float)
    n = int(arr.size)
    if n < 2:
        return {
            "n": n,
            "meanIC": _r(float(arr[0])) if n == 1 else None,
            "stdIC": None,
            "icir": None,
            "tStat": None,
            "hitRate": None,
            "overlapping": overlapping,
            "note": "too few rebalances to say anything about skill",
        }

    mean = float(arr.mean())
    std = float(arr.std(ddof=1))
    icir = mean / std if std > 0 else None
    t = (icir * math.sqrt(n)) if icir is not None else None
    return {
        "n": n,
        "meanIC": _r(mean),
        "stdIC": _r(std),
        "icir": _r(icir),
        "tStat": _r(t),
        # Share of rebalances with a positive IC -- a consistency read that is
        # harder to fool with one huge month than the mean is.
        "hitRate": _r(float((arr > 0).mean())),
        "overlapping": overlapping,
        "note": (
            "IC windows overlap the rebalance spacing -- ICIR and t are inflated "
            "and must not be compared against the bar."
            if overlapping
            else "non-overlapping rebalances; t assumes independence across dates"
        ),
    }


def _r(x) -> float | None:
    if x is None or not np.isfinite(x):
        return None
    return round(float(x), 4)
