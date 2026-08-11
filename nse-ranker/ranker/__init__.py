"""
NSE F&O cross-sectional ranker.

Ranks the NSE F&O single-stock universe by forecast forward return so the
operator can decide which side of each name's option chain to sell: top decile
-> lean bullish -> sell puts; bottom decile -> lean bearish -> sell calls.

The product is the **ranking**, never a single name's point forecast. The
Fundamental Law of Active Management is the reason: ``IR ~= IC x sqrt(breadth)``.
An IC of 0.03 on one stock is noise; the same IC across ~190 stocks at once is a
strategy. Nothing in this package is allowed to depend on any individual
forecast being right, and the universe is never trimmed to save compute.

Importing this package pulls in numpy and the standard library only. torch
arrives exclusively via `engines.get_engine("kronos")`, so the pure-math modules
-- neutralisation, ranking, IC, costs, backtest -- stay testable with no model
weights present.
"""

from __future__ import annotations

__all__ = ["config"]

from . import config  # noqa: F401
