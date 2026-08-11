"""
Cross-sectional ranking: ranks, percentiles, deciles.

Pure numpy. Imports nothing heavier than `config`, so it is testable without
torch, without weights, and without a network.
"""

from __future__ import annotations

import numpy as np

from . import config as C


def rankdata(x: np.ndarray) -> np.ndarray:
    """Average ranks, 1-based -- scipy's `rankdata` without the scipy dependency.

    Ties take the mean of the ranks they span, which is what makes the Spearman
    coefficient built on top of this correct when several names share a score
    (common once scores are winsorised or a factor saturates).
    """
    x = np.asarray(x, dtype=float)
    n = x.size
    if n == 0:
        return np.empty(0, dtype=float)
    order = np.argsort(x, kind="mergesort")
    ranks = np.empty(n, dtype=float)
    sorted_x = x[order]
    i = 0
    while i < n:
        j = i
        while j + 1 < n and sorted_x[j + 1] == sorted_x[i]:
            j += 1
        ranks[order[i: j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return ranks


def winsorize(x: np.ndarray, bounds: tuple[float, float] = C.SCORE_WINSOR) -> np.ndarray:
    """Clip to cross-sectional quantiles.

    Ranking is already robust to outliers; this exists because the *scores* are
    displayed, and one absurd value would flatten the entire colour scale.
    """
    x = np.asarray(x, dtype=float)
    finite = x[np.isfinite(x)]
    if finite.size < 3:
        return x
    lo, hi = np.quantile(finite, bounds[0]), np.quantile(finite, bounds[1])
    return np.clip(x, lo, hi)


def percentiles(scores: np.ndarray) -> np.ndarray:
    """Map scores to [0, 1] by rank. 1.0 = most bullish.

    Rank-based rather than value-based on purpose: the forecast values are not
    calibrated to anything, so their *spacing* carries no meaning worth showing.
    Only the ordering does.
    """
    scores = np.asarray(scores, dtype=float)
    n = scores.size
    if n == 0:
        return np.empty(0, dtype=float)
    if n == 1:
        return np.array([0.5])
    return (rankdata(scores) - 1.0) / (n - 1.0)


def deciles(scores: np.ndarray, n_buckets: int = C.DECILES) -> np.ndarray:
    """Bucket by rank into 1..n_buckets, where n_buckets is the most bullish.

    Rank-based bucketing keeps the buckets equal-sized, which is what makes a
    top-minus-bottom spread a fair comparison. Value-based bucketing would let a
    single cluster of similar forecasts fill one decile and empty another.
    """
    scores = np.asarray(scores, dtype=float)
    n = scores.size
    if n == 0:
        return np.empty(0, dtype=int)
    k = max(1, min(n_buckets, n))
    r = rankdata(scores)
    # (r-1)/n * k lands in [0, k); +1 shifts to 1..k.
    return np.minimum(k, np.floor((r - 1.0) / n * k).astype(int) + 1)


def rank_correlation(a: np.ndarray, b: np.ndarray) -> float:
    """Spearman rank correlation, NaN-safe on the pairwise-complete overlap."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    mask = np.isfinite(a) & np.isfinite(b)
    if mask.sum() < 3:
        return float("nan")
    ra, rb = rankdata(a[mask]), rankdata(b[mask])
    ra = ra - ra.mean()
    rb = rb - rb.mean()
    denom = np.sqrt((ra * ra).sum() * (rb * rb).sum())
    if denom == 0:
        return float("nan")
    return float((ra * rb).sum() / denom)
