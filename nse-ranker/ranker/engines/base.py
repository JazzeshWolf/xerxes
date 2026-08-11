"""
The forecast-engine interface.

Both engines -- the block-bootstrap baseline and Kronos -- take the same input
and return the same output, so the pipeline, the backtest and the report cannot
tell them apart. That is the point: swapping the engine has to be the *only*
difference between a Kronos result and its baseline, or the comparison is not
apples-to-apples and the scorecard means nothing.

Nothing in this module imports torch, pandas or numpy-heavy machinery beyond
numpy itself, so the interface (and the bootstrap engine built on it) stays
importable and testable with no model weights present.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .. import config as C
from ..upstox import Bar

#: Quantiles retained per name. Enough to draw a cone with a 50% and a 90% band.
QUANTILES = (0.05, 0.25, 0.50, 0.75, 0.95)


@dataclass
class Forecast:
    """One name's forecast over the horizon.

    `median_return` is the terminal simple return over `pred_len` trading days
    and is the ONLY field the ranking consumes. Everything else exists for the
    UI's detail view, and for the honesty of showing the spread around a number
    that would otherwise look far more precise than it is.
    """

    symbol: str
    median_return: float
    last_close: float
    quantiles: dict[str, float] = field(default_factory=dict)   # terminal returns
    paths: list[list[float]] = field(default_factory=list)      # illustrative draws
    #: Per-step price bands ("lo"/"mid"/"hi") computed from EVERY sample, not
    #: from the handful of paths kept for display. Without this the chart's
    #: median line is the median of 8 random draws while the headline forecast
    #: is the median of 400 -- and the two visibly disagree.
    band: dict[str, list[float]] = field(default_factory=dict)
    n_samples: int = 0
    engine: str = ""

    def as_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "medianReturn": _r(self.median_return),
            "lastClose": _r(self.last_close, 4),
            "quantiles": {k: _r(v) for k, v in self.quantiles.items()},
            "paths": [[_r(p, 4) for p in path] for path in self.paths],
            "band": {k: [_r(x, 4) for x in v] for k, v in self.band.items()},
            "nSamples": self.n_samples,
            "engine": self.engine,
        }


class Engine:
    """Base class. Subclasses implement `forecast`."""

    name = "base"

    def forecast(self, series: dict[str, list[Bar]], pred_len: int) -> dict[str, Forecast]:
        raise NotImplementedError

    # -- shared helpers -----------------------------------------------------

    @staticmethod
    def _terminal_stats(
        symbol: str,
        terminal_returns: np.ndarray,
        last_close: float,
        paths: list[list[float]],
        engine: str,
        all_paths: np.ndarray | None = None,
    ) -> Forecast:
        """Collapse a sample of terminal returns into the published shape.

        `paths` are the few draws kept for display; `all_paths` (optional,
        shape (n_samples, horizon)) is the full sample the per-step band is
        computed from. Pass it whenever the engine has it -- the band drawn from
        8 draws does not agree with a median taken over 400.
        """
        arr = np.asarray(terminal_returns, dtype=float)
        arr = arr[np.isfinite(arr)]
        if arr.size == 0:
            return Forecast(symbol=symbol, median_return=float("nan"),
                            last_close=last_close, engine=engine)
        qs = {f"q{int(q * 100):02d}": float(np.quantile(arr, q)) for q in QUANTILES}
        return Forecast(
            symbol=symbol,
            median_return=float(np.median(arr)),
            last_close=last_close,
            quantiles=qs,
            paths=paths[: C.KEEP_SAMPLE_PATHS],
            band=band_from_paths(all_paths) if all_paths is not None else {},
            n_samples=int(arr.size),
            engine=engine,
        )


    @staticmethod
    def _closes(bars: list[Bar]) -> np.ndarray:
        return np.array([b.c for b in bars], dtype=float)

    @staticmethod
    def _log_returns(bars: list[Bar]) -> np.ndarray:
        c = Engine._closes(bars)
        if c.size < 2:
            return np.empty(0, dtype=float)
        return np.diff(np.log(c))


def band_from_paths(all_paths: np.ndarray, lo_q: float = 0.10, hi_q: float = 0.90) -> dict:
    """Per-step 10th/50th/90th percentile price band across every sample path.

    Computed per step rather than interpolated back from the terminal quantiles,
    so the band shows how the model's uncertainty actually opens up over the
    horizon instead of a tidy wedge no sample supports.
    """
    arr = np.asarray(all_paths, dtype=float)
    if arr.ndim != 2 or arr.shape[0] < 2 or arr.shape[1] < 2:
        return {}
    return {
        "lo": np.quantile(arr, lo_q, axis=0).tolist(),
        "mid": np.quantile(arr, 0.50, axis=0).tolist(),
        "hi": np.quantile(arr, hi_q, axis=0).tolist(),
    }


def _r(x, nd: int = 6) -> float | None:
    if x is None:
        return None
    x = float(x)
    if not np.isfinite(x):
        return None
    return round(x, nd)
