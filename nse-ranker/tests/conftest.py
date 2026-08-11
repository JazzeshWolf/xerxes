"""Shared synthetic fixtures.

The panels built here are the only way this service can be tested end to end: a
sandbox with no route to Upstox and no model weights cannot use real data, so
the harness is validated against data whose answer is known by construction.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest

from ranker.panel import build_panel
from ranker.upstox import Bar


def make_bars(closes: np.ndarray, start: str = "2021-01-04") -> list[Bar]:
    """Weekday-dated bars from a close series, with a plausible intraday range."""
    d = dt.date.fromisoformat(start)
    out: list[Bar] = []
    for c in closes:
        while d.weekday() >= 5:
            d += dt.timedelta(days=1)
        c = float(c)
        out.append(Bar(t=d.isoformat(), o=c * 0.999, h=c * 1.004, l=c * 0.996, c=c, v=250_000.0))
        d += dt.timedelta(days=1)
    return out


@pytest.fixture(scope="module")
def planted_panel():
    """A panel with a KNOWN, persistent predictable component.

    Each name carries a slowly-varying drift (AR(1), phi=0.99) buried in daily
    noise. Because the drift persists, a name's trailing return genuinely
    predicts its forward return -- so a forecaster that measures trailing return
    should score a high IC, and one that guesses should score zero.

    This is what makes the harness itself testable: if it cannot find a signal
    that is provably there, it is broken; if it finds one in random data, it is
    worse than broken.
    """
    rng = np.random.default_rng(42)
    n_symbols, n_days = 80, 1000

    drift = np.zeros((n_symbols, n_days))
    drift[:, 0] = rng.standard_normal(n_symbols) * 0.002
    for t in range(1, n_days):
        drift[:, t] = 0.99 * drift[:, t - 1] + rng.standard_normal(n_symbols) * 0.0003

    # A common market factor, so beta-neutralisation has something real to strip.
    market = rng.standard_normal(n_days) * 0.009
    betas = rng.uniform(0.5, 1.8, n_symbols)

    rets = drift + betas[:, None] * market[None, :] + rng.standard_normal((n_symbols, n_days)) * 0.008
    prices = 100.0 * np.exp(np.cumsum(rets, axis=1))

    symbols = [f"SYM{i:03d}" for i in range(n_symbols)]
    sectors = ["IT", "Banks", "Pharma", "Auto", "FMCG"] * (n_symbols // 5)
    bars = {s: make_bars(prices[i]) for i, s in enumerate(symbols)}

    return {
        "panel": build_panel(bars),
        "sector_of": dict(zip(symbols, sectors)),
        "symbols": symbols,
    }
