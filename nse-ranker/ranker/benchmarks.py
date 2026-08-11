"""
Benchmarks the Kronos ranking has to beat.

Three of them, chosen because each rules out a different way of being fooled:

* **random** -- the true null. Establishes what ICIR the harness reports when
  there is provably no signal, which is the only way to know the harness itself
  is not manufacturing skill. (The bootstrap engine is *not* this; resampling a
  name's own history produces a drift signal. See engines/bootstrap.py.)
* **12-1 momentum** -- the one that matters commercially. It is free, needs no
  model, no GPU and no 12B-parameter pre-training. If a transformer cannot beat
  twelve months of past return, it is not worth the compute, and the report says
  so in those words rather than burying it under a chart.
* **5-day reversal** -- short-horizon mean reversion. Included because it is the
  factor most likely to be *accidentally* rediscovered by a model fed recent
  candles: a strong negative loading on last week's return would show up as
  apparent skill that is really a known, cheap effect.

All three produce a score per symbol on the same cross-section the engine scores,
so they run through the identical neutralisation, ranking and costing path. A
benchmark scored differently from the strategy is not a benchmark.
"""

from __future__ import annotations

import numpy as np

from . import config as C
from .panel import Panel


def momentum_12_1(
    panel: Panel,
    i: int,
    lookback: int = C.MOMENTUM_LOOKBACK,
    skip: int = C.MOMENTUM_SKIP,
) -> np.ndarray:
    """Jegadeesh-Titman 12-1: return over `lookback`, skipping the last `skip`.

    The skip month is not decoration. Short-horizon reversal runs the opposite
    way to momentum, so a 12-month window that includes the most recent month
    mixes two effects and understates both.
    """
    start = i - lookback
    end = i - skip
    if start < 0 or end <= start:
        return np.full(len(panel.symbols), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        return panel.closes[:, end] / panel.closes[:, start] - 1.0


def reversal_5d(panel: Panel, i: int, lookback: int = C.REVERSAL_LOOKBACK) -> np.ndarray:
    """Short-term reversal: NEGATIVE of the last `lookback` days' return.

    Negated so that, like every other score here, larger means more bullish.
    """
    start = i - lookback
    if start < 0:
        return np.full(len(panel.symbols), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        return -(panel.closes[:, i] / panel.closes[:, start] - 1.0)


def random_scores(n: int, seed: int) -> np.ndarray:
    """The true null. Seeded per rebalance so the whole backtest is reproducible."""
    return np.random.default_rng(seed).standard_normal(n)


#: name -> callable(panel, i, seed) -> scores. `seed` is ignored by the
#: deterministic factors; it exists so the dispatch table stays uniform.
BENCHMARKS = {
    "momentum_12_1": lambda panel, i, seed: momentum_12_1(panel, i),
    "reversal_5d": lambda panel, i, seed: reversal_5d(panel, i),
    "random": lambda panel, i, seed: random_scores(len(panel.symbols), seed),
}
