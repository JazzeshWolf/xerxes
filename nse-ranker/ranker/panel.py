"""
The aligned price panel -- the backbone of every point-in-time operation.

A panel holds one row per symbol and one column per trading date, with NaN where
a name has no bar. Everything downstream (betas, benchmarks, forward returns,
the engine's input window) slices it by *integer date index*, never by "the last
N rows of whatever this symbol happens to have".

## Why alignment is a correctness issue, not a convenience

Names list, delist, and halt. If each symbol carried its own ragged history,
"the previous 252 bars" would mean a different calendar span per name, and a
cross-sectional beta or forward return computed across them would silently
compare mismatched periods. Aligning on a common date axis makes every
cross-section a genuine snapshot of one moment.

The related trap is lookahead. `window` and `forward_return` are the only two
ways to read the panel, and they are deliberately asymmetric: `window` returns
data strictly up to and including index `i`, `forward_return` strictly after it.
No caller ever gets to touch a bar the trader would not have had.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .upstox import Bar


@dataclass
class Panel:
    dates: list[str]                 # ascending trading dates
    symbols: list[str]
    closes: np.ndarray               # (n_symbols, n_dates), NaN where missing
    bars: dict[str, list[Bar]]       # adjusted bars, per symbol, oldest-first

    @property
    def n_dates(self) -> int:
        return len(self.dates)

    def index_of(self, date_iso: str) -> int:
        """Index of the last trading date at or before `date_iso` (-1 if none)."""
        lo, hi, found = 0, len(self.dates) - 1, -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if self.dates[mid] <= date_iso:
                found, lo = mid, mid + 1
            else:
                hi = mid - 1
        return found

    def window(self, i: int, length: int) -> np.ndarray:
        """Closes over the `length` dates ending at index `i`, inclusive.

        Strictly historical: index `i` is the most recent bar a decision made on
        that date could legitimately see.
        """
        start = max(0, i - length + 1)
        return self.closes[:, start: i + 1]

    def daily_returns(self, i: int, length: int) -> np.ndarray:
        """Simple daily returns over the window ending at `i`. (n_symbols, k-1)."""
        w = self.window(i, length + 1)
        if w.shape[1] < 2:
            return np.empty((w.shape[0], 0))
        with np.errstate(invalid="ignore", divide="ignore"):
            return w[:, 1:] / w[:, :-1] - 1.0

    def forward_return(self, i: int, horizon: int) -> np.ndarray:
        """Realised return from index `i` to `i + horizon`.

        NaN where either endpoint is missing, so a name that stopped trading
        contributes nothing rather than a fabricated zero.
        """
        j = i + horizon
        if j >= self.n_dates:
            return np.full(len(self.symbols), np.nan)
        with np.errstate(invalid="ignore", divide="ignore"):
            return self.closes[:, j] / self.closes[:, i] - 1.0

    def bars_upto(self, symbol: str, i: int, lookback: int) -> list[Bar]:
        """The engine's input window: `lookback` bars ending on date index `i`.

        Filtered by date rather than by count so a symbol with gaps cannot reach
        past `dates[i]` and see the future.
        """
        cutoff = self.dates[i]
        seq = [b for b in self.bars.get(symbol, []) if b.t <= cutoff]
        return seq[-lookback:]

    def valid_mask(self, i: int, min_history: int) -> np.ndarray:
        """Which symbols have a price at `i` and enough history behind it."""
        have_now = np.isfinite(self.closes[:, i])
        w = self.window(i, min_history)
        enough = np.isfinite(w).sum(axis=1) >= min_history * 0.8
        return have_now & enough


def build_panel(bars_by_symbol: dict[str, list[Bar]]) -> Panel:
    """Align ragged per-symbol series onto one date axis.

    The axis is the union of every symbol's dates, so a name that halted for a
    week shows NaN there rather than shifting its later bars earlier -- which is
    the subtle version of lookahead that ragged data invites.
    """
    symbols = sorted(bars_by_symbol)
    all_dates = sorted({b.t for bars in bars_by_symbol.values() for b in bars})
    pos = {d: k for k, d in enumerate(all_dates)}

    closes = np.full((len(symbols), len(all_dates)), np.nan)
    for r, sym in enumerate(symbols):
        for b in bars_by_symbol[sym]:
            closes[r, pos[b.t]] = b.c

    return Panel(dates=all_dates, symbols=symbols, closes=closes, bars=dict(bars_by_symbol))
