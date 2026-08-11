"""
Neutralisation: strip market beta and sector out of the raw forecast.

## Why this is not optional

A forecasting model applied to 190 names on the same day sees the same market.
If it is mildly bullish on the index, it is mildly bullish on nearly everything,
and the resulting "ranking" is mostly an ordering of *beta* -- high-beta names
at the top on up-forecasts, at the bottom on down-forecasts. That is not a stock
selection signal, it is a leveraged index bet wearing one's costume. The same
argument applies one level down: if the model likes IT this month, an
un-neutralised ranking is a sector bet.

Neither shows up as an error. The ranking looks fine, the IC may even look good
(because beta and sector genuinely predict returns in a trending market), and
the thing you are actually trading is not what the scorecard claims.

## Order, and why

1. **Cross-sectional demean** -- removes the common component outright.
2. **Beta-neutralise** -- OLS residual against each name's beta. Applied after
   demeaning so the regression is about dispersion, not level.
3. **Sector-neutralise** -- residual against sector dummies, i.e. demean within
   each sector. Last, so it cleans up whatever beta-neutralisation left behind
   (sector and beta are correlated -- banks are high beta -- and doing sector
   first would let beta creep back in through the sector means).

`diagnostics()` measures the correlation with beta and the sector R^2 *before
and after*. Those two numbers are the check on this whole file: if they have not
fallen, the neutralisation did not work and the ranking is still beta in
disguise. `check()` turns that into a pass/fail the pipeline surfaces rather
than a metric nobody reads.
"""

from __future__ import annotations

import numpy as np

from . import config as C
from .ranking import rank_correlation


def compute_betas(returns: np.ndarray, clip: tuple[float, float] = C.BETA_CLIP) -> np.ndarray:
    """Beta of each name against the equal-weight universe return.

    `returns` is (n_names, n_days) of simple daily returns; NaNs allowed for
    names with short history. The equal-weight cross-sectional mean stands in
    for the market: it needs no index data, it is exactly the thing the
    demeaning step removes, and for an F&O universe it tracks a broad index
    closely enough for this purpose.

    Betas are winsorised into `clip` because one wild estimate from a thin or
    newly-listed name distorts the whole cross-sectional regression.
    """
    returns = np.asarray(returns, dtype=float)
    if returns.ndim != 2 or returns.shape[1] < 2:
        return np.full(returns.shape[0] if returns.ndim == 2 else 0, np.nan)

    market = np.nanmean(returns, axis=0)
    betas = np.full(returns.shape[0], np.nan)
    for i in range(returns.shape[0]):
        r = returns[i]
        mask = np.isfinite(r) & np.isfinite(market)
        if mask.sum() < 60:  # too little overlap for a usable beta
            continue
        x, y = market[mask], r[mask]
        vx = float(((x - x.mean()) ** 2).sum())
        if vx <= 0:
            continue
        betas[i] = float(((x - x.mean()) * (y - y.mean())).sum() / vx)

    finite = np.isfinite(betas)
    if finite.any():
        # Missing betas become the universe median: dropping the name would cost
        # breadth, and the median is the least-opinionated stand-in.
        betas[~finite] = float(np.median(betas[finite]))
        betas = np.clip(betas, clip[0], clip[1])
    return betas


def demean(scores: np.ndarray) -> np.ndarray:
    scores = np.asarray(scores, dtype=float)
    mask = np.isfinite(scores)
    if not mask.any():
        return scores
    out = scores.copy()
    out[mask] = scores[mask] - scores[mask].mean()
    return out


def _ols_residual(y: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Residual of y on X (intercept added), NaN-safe, rank-deficiency-safe."""
    y = np.asarray(y, dtype=float)
    mask = np.isfinite(y) & np.isfinite(X).all(axis=1)
    out = y.copy()
    if mask.sum() <= X.shape[1] + 1:
        return out  # not enough rows to identify the fit; leave untouched
    Xm = np.column_stack([np.ones(mask.sum()), X[mask]])
    coef, *_ = np.linalg.lstsq(Xm, y[mask], rcond=None)
    out[mask] = y[mask] - Xm @ coef
    return out


def beta_neutralize(scores: np.ndarray, betas: np.ndarray) -> np.ndarray:
    """Residual of the score on beta -- the part not explained by market exposure."""
    betas = np.asarray(betas, dtype=float)
    if betas.size != np.asarray(scores).size:
        return np.asarray(scores, dtype=float)
    return _ols_residual(np.asarray(scores, dtype=float), betas.reshape(-1, 1))


def _sector_groups(sectors: list[str], min_size: int = C.MIN_SECTOR_SIZE) -> dict[str, list[int]]:
    """Index groups per sector, pooling anything below `min_size` into OTHER.

    Regressing on a one-name sector would set that name's residual to exactly
    zero -- deleting its signal rather than neutralising it. Pooling the small
    sectors keeps those names in the ranking.
    """
    groups: dict[str, list[int]] = {}
    for i, s in enumerate(sectors):
        groups.setdefault(s or "UNMAPPED", []).append(i)
    pooled: dict[str, list[int]] = {}
    other: list[int] = []
    for s, idx in groups.items():
        if len(idx) >= min_size:
            pooled[s] = idx
        else:
            other.extend(idx)
    if other:
        pooled.setdefault("OTHER", []).extend(other)
    return pooled


def sector_neutralize(scores: np.ndarray, sectors: list[str]) -> np.ndarray:
    """Demean within sector -- equivalent to a regression on sector dummies."""
    scores = np.asarray(scores, dtype=float)
    out = scores.copy()
    for _, idx in _sector_groups(sectors).items():
        sel = np.array(idx, dtype=int)
        vals = scores[sel]
        mask = np.isfinite(vals)
        if mask.sum() < 2:
            continue
        out[sel[mask]] = vals[mask] - vals[mask].mean()
    return out


def sector_r2(scores: np.ndarray, sectors: list[str]) -> float:
    """One-way ANOVA R^2: the share of score variance explained by sector alone."""
    scores = np.asarray(scores, dtype=float)
    mask = np.isfinite(scores)
    if mask.sum() < 3:
        return float("nan")
    total = float(((scores[mask] - scores[mask].mean()) ** 2).sum())
    if total <= 0:
        return 0.0
    between = 0.0
    grand = scores[mask].mean()
    for _, idx in _sector_groups(sectors).items():
        sel = np.array(idx, dtype=int)
        vals = scores[sel]
        m = np.isfinite(vals)
        if m.sum() == 0:
            continue
        between += m.sum() * (vals[m].mean() - grand) ** 2
    return float(between / total)


def diagnostics(scores: np.ndarray, betas: np.ndarray, sectors: list[str]) -> dict:
    """The two numbers that say whether a ranking is really a beta/sector bet."""
    return {
        "betaRankCorr": _round(rank_correlation(scores, betas)),
        "sectorR2": _round(sector_r2(scores, sectors)),
    }


def _round(x: float) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), 4)


def neutralize(
    raw: np.ndarray, betas: np.ndarray, sectors: list[str]
) -> tuple[np.ndarray, dict]:
    """Full pipeline: demean -> beta-neutralise -> sector-neutralise.

    Returns the neutralised scores and a before/after diagnostic block. The
    caller is expected to publish that block; a ranking whose beta correlation
    did not fall is not usable, and hiding the number would be the whole bug.
    """
    raw = np.asarray(raw, dtype=float)
    before = diagnostics(raw, betas, sectors)

    step1 = demean(raw)
    step2 = beta_neutralize(step1, betas)
    step3 = sector_neutralize(step2, sectors)

    after = diagnostics(step3, betas, sectors)
    return step3, {
        "before": before,
        "after": after,
        "passed": check(after),
        "thresholds": {
            "maxBetaRankCorr": C.MAX_BETA_CORR_AFTER,
            "maxSectorR2": C.MAX_SECTOR_R2_AFTER,
        },
    }


def check(after: dict) -> bool:
    """Did neutralisation actually work? False means the ranking is compromised."""
    b, s = after.get("betaRankCorr"), after.get("sectorR2")
    if b is not None and abs(b) > C.MAX_BETA_CORR_AFTER:
        return False
    if s is not None and s > C.MAX_SECTOR_R2_AFTER:
        return False
    return True
