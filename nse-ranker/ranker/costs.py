"""
Indian retail trading costs, and the turnover that drives them.

## Why impact cost is modelled explicitly

Brokerage, STT, exchange charges, GST and stamp duty are all published numbers
that a spreadsheet can total. Impact -- the spread you cross and the price you
push -- is not published, is usually the largest single term for a retail-size
order in a mid-cap, and is the one most often left out of a backtest. A decile
strategy rebalancing monthly across 190 names does a lot of trading, so a
20 bps round-trip impact assumption is worth roughly as much as every statutory
charge combined. Leaving it out is the standard way a backtest turns a losing
strategy into a winning one.

Because it is a *prior* rather than a measurement, `spread_returns` reports the
result at several impact assumptions instead of one, so the headline is never a
single un-stressed guess.

## What the decile spread is, and is not

It is a **measure of ranking skill**, expressed in the units a trader thinks in.
It is not a strategy this repo proposes trading: the short leg is not shortable
in Indian equity delivery, so a real implementation would use single-stock
futures with a different cost stack. The actual product here is the lean --
which side of the option chain to sell -- and the spread exists to tell you
whether the ranking underneath that lean is worth anything.
"""

from __future__ import annotations

import numpy as np

from . import config as C
from .config import CostModel


def turnover(prev: dict[str, float], new: dict[str, float]) -> float:
    """One-way turnover between two weight books, as a fraction of gross book.

    Sum of |weight change| over 2: the conventional definition, where replacing
    the entire book scores 1.0. Names in one book and not the other count their
    full weight, which is what makes an entering/exiting decile expensive.
    """
    keys = set(prev) | set(new)
    if not keys:
        return 0.0
    gross = sum(abs(v) for v in new.values())
    if gross <= 0:
        return 0.0
    delta = sum(abs(new.get(k, 0.0) - prev.get(k, 0.0)) for k in keys)
    return float(delta / 2.0 / gross)


def cost_drag(one_way_turnover: float, costs: CostModel = C.COSTS) -> float:
    """Return drag for a rebalance, as a decimal (not bps).

    `round_trip_bps` prices a complete in-and-out. Turnover of 1.0 means the
    whole book was replaced, which is one round trip for the leaving position
    and one entry for the arriving one -- i.e. exactly one round trip of cost.
    """
    return float(one_way_turnover * costs.round_trip_bps() / 10_000.0)


def decile_weights(deciles: np.ndarray, symbols: list[str], n_buckets: int = C.DECILES) -> dict[str, float]:
    """Equal-weight long the top bucket, short the bottom. Gross book = 1.0.

    Each leg carries 0.5 of the gross, so the spread return is the plain
    difference of the two legs' mean returns.
    """
    deciles = np.asarray(deciles, dtype=int)
    top = [s for s, d in zip(symbols, deciles) if d == n_buckets]
    bot = [s for s, d in zip(symbols, deciles) if d == 1]
    out: dict[str, float] = {}
    if top:
        for s in top:
            out[s] = 0.5 / len(top)
    if bot:
        for s in bot:
            out[s] = -0.5 / len(bot)
    return out


def spread_returns(
    legs: list[dict],
    costs: CostModel = C.COSTS,
    impacts_bps: tuple[float, ...] = C.IMPACT_SENSITIVITY_BPS,
) -> dict:
    """Aggregate per-rebalance decile spreads into gross/net performance.

    `legs` is one dict per rebalance:
        {"date", "topReturn", "bottomReturn", "turnover"}

    Returns totals plus the same net figure recomputed at each impact
    assumption, because the impact prior is the softest input in the model and
    the reader deserves to see how much the conclusion leans on it.
    """
    if not legs:
        return {"n": 0, "note": "no rebalances"}

    gross = np.array(
        [float(x["topReturn"]) - float(x["bottomReturn"]) for x in legs], dtype=float
    )
    turn = np.array([float(x.get("turnover", 1.0)) for x in legs], dtype=float)
    per_year = 252.0 / max(1, C.REBALANCE_EVERY)

    def net_at(impact: float) -> dict:
        model = CostModel(
            brokerage_bps=costs.brokerage_bps,
            stt_bps=costs.stt_bps,
            exchange_bps=costs.exchange_bps,
            sebi_bps=costs.sebi_bps,
            stamp_bps=costs.stamp_bps,
            gst_rate=costs.gst_rate,
            impact_bps=impact,
        )
        drag = np.array([cost_drag(t, model) for t in turn], dtype=float)
        net = gross - drag
        sd = float(net.std(ddof=1)) if net.size > 1 else 0.0
        return {
            "impactBps": impact,
            "roundTripBps": round(model.round_trip_bps(), 2),
            "meanNetPerRebalance": _r(float(net.mean())),
            "annualisedNet": _r(float(net.mean() * per_year)),
            "sharpeNet": _r(float(net.mean() / sd * np.sqrt(per_year))) if sd > 0 else None,
            "winRate": _r(float((net > 0).mean())),
        }

    base = net_at(costs.impact_bps)
    base_drag = float(np.mean([cost_drag(t, costs) for t in turn]))
    return {
        "n": int(gross.size),
        "meanGrossPerRebalance": _r(float(gross.mean())),
        "annualisedGross": _r(float(gross.mean() * per_year)),
        "meanTurnover": _r(float(turn.mean())),
        "costDragPerRebalance": _r(base_drag),
        "net": base,
        "impactSensitivity": [net_at(i) for i in impacts_bps],
        "rebalancesPerYear": round(per_year, 1),
    }


def _r(x) -> float | None:
    if x is None or isinstance(x, bool) or not np.isfinite(x):
        return None
    return round(float(x), 6)
