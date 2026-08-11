"""
Block-bootstrap forecast engine -- the baseline.

Filtered historical simulation, the same construction `scripts/analytics.mjs`
already uses for `terminalSample`: take the name's own daily log returns,
resample them in contiguous blocks, and sum to the horizon. Blocks rather than
i.i.d. draws because contiguous stretches preserve volatility clustering, which
widens the terminal distribution -- the conservative direction when the thing
you are going to do with the forecast is sell options.

## What this baseline actually is (read before comparing anything to it)

It is **not a null**. Resampling a name's own history gives a terminal median of
roughly `mean(daily return) x horizon`, so the ranking it produces is close to a
long-horizon *drift* (momentum) signal. That makes it a genuine, if weak,
baseline -- which is useful -- but it is emphatically not "random".

The true null is the `random` benchmark in `benchmarks.py`. Any claim of the
form "Kronos beats the bootstrap" is a claim about beating a drift signal, and
any claim of the form "this is better than nothing" needs the random benchmark.
The report keeps both for that reason.

Its real job is structural: it makes the whole pipeline -- universe, cleaning,
neutralisation, ranking, backtest, JSON output -- runnable and testable with no
model weights, no torch, and no network. Every part of this service except
`kronos.py` is exercised by it.
"""

from __future__ import annotations

import numpy as np

from .. import config as C
from ..upstox import Bar
from .base import Engine, Forecast


def block_length(pred_len: int) -> int:
    """Horizon/3, bounded -- mirrors the repo's existing terminalSample choice."""
    lo, hi = C.BOOTSTRAP_BLOCK_BOUNDS
    return int(max(lo, min(hi, max(1, pred_len // C.BOOTSTRAP_BLOCK_DIVISOR))))


class BootstrapEngine(Engine):
    name = "bootstrap"

    def __init__(self, paths: int = C.BOOTSTRAP_PATHS, seed: int = C.BOOTSTRAP_SEED):
        self.paths = paths
        self.seed = seed

    def forecast(self, series: dict[str, list[Bar]], pred_len: int) -> dict[str, Forecast]:
        out: dict[str, Forecast] = {}
        for i, (symbol, bars) in enumerate(sorted(series.items())):
            # Per-symbol seed derived from the run seed: reproducible, but not
            # the same path draw for every name (which would inject a spurious
            # common factor straight into a cross-sectional ranking).
            rng = np.random.default_rng(self.seed + i)
            out[symbol] = self._one(symbol, bars, pred_len, rng)
        return out

    def _one(self, symbol: str, bars: list[Bar], pred_len: int, rng) -> Forecast:
        rets = self._log_returns(bars)
        last_close = float(bars[-1].c) if bars else float("nan")
        if rets.size < 30:
            return Forecast(symbol=symbol, median_return=float("nan"),
                            last_close=last_close, engine=self.name)

        bl = block_length(pred_len)
        n_blocks = int(np.ceil(pred_len / bl))
        max_start = rets.size - bl
        if max_start < 1:
            bl, n_blocks, max_start = 1, pred_len, rets.size - 1

        # Draw all block starts at once: (paths, n_blocks).
        starts = rng.integers(0, max_start + 1, size=(self.paths, n_blocks))
        # Gather each block and concatenate along the horizon, then trim.
        idx = starts[:, :, None] + np.arange(bl)[None, None, :]
        drawn = rets[idx].reshape(self.paths, -1)[:, :pred_len]

        cum = np.cumsum(drawn, axis=1)
        terminal = np.exp(cum[:, -1]) - 1.0

        # Every path, for the band; the first few also go out as illustrative
        # draws. The band must come from the full sample or its median line
        # disagrees with the published median return.
        price_paths = last_close * np.exp(cum)
        keep = min(C.KEEP_SAMPLE_PATHS, self.paths)

        return self._terminal_stats(
            symbol, terminal, last_close, price_paths[:keep].tolist(), self.name,
            all_paths=price_paths,
        )
