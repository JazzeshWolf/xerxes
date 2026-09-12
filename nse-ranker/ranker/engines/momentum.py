"""
12-1 momentum as a ranking engine.

This is not a forecast. It is the Jegadeesh-Titman cross-sectional factor --
return over the last 12 months skipping the most recent one -- used directly as
the ranking score. It earns the job on measurement rather than sophistication:
over the 58-rebalance walk-forward it scored ICIR 0.35 against the bootstrap
baseline's 0.30 and Kronos-mini's -0.33, while costing milliseconds instead of
the ~4 CPU-hours a Kronos daily run took.

**Why this delegates instead of reimplementing.** The backtest scores the engine
against a `momentum_12_1` *benchmark* arm. If this engine computed momentum its
own way the two could disagree, and then the measured ICIR would not describe
what the daily job actually ships. So `forecast_panel` calls the benchmark
function itself -- they are the same number by construction, not by a test that
could drift.

**Why it needs the panel rather than bars.** `Panel.bars_upto` filters by date
and then slices, while the panel's date axis is the union of every symbol's
dates. For any name that halted for a session, `bars[-22]` is NOT
`panel.closes[:, i - 21]`. Computing the factor from `list[Bar]` would therefore
be quietly wrong for exactly the gappy names, which is why `uses_panel` exists.
"""

from __future__ import annotations

import numpy as np

from ..benchmarks import momentum_12_1
from ..panel import Panel
from ..upstox import Bar
from .base import Engine, Forecast


class MomentumEngine(Engine):
    """Ranks on 12-1 momentum, scored from the panel."""

    name = "momentum_12_1"

    #: Tells `walk_forward` and `run_daily` to call `forecast_panel` instead of
    #: `forecast`. An attribute rather than a `hasattr` probe or an
    #: `engine_name == "..."` test, so adding a factor engine never means
    #: editing a string comparison in two pipelines.
    uses_panel = True

    #: What the published number MEANS. A trailing factor has no forecast
    #: horizon, so the UI must not label it as a return forecast.
    signal_kind = "factor"
    signal_label = "12-1 momentum"
    signal_window = "trailing 252 sessions, skipping the most recent 21"

    def forecast_panel(self, panel: Panel, i: int, pred_len: int) -> dict[str, Forecast]:
        scores = momentum_12_1(panel, i)
        out: dict[str, Forecast] = {}
        for k, sym in enumerate(panel.symbols):
            score = float(scores[k])
            last = float(panel.closes[k, i])
            # `_write` serialises with allow_nan=False, so a non-finite close
            # would raise only after the whole run had completed. Drop the name
            # here instead; the ranking already tolerates a missing symbol.
            if not np.isfinite(score) or not np.isfinite(last) or last <= 0:
                continue
            out[sym] = Forecast(
                symbol=sym,
                median_return=score,
                last_close=last,
                engine=self.name,
            )
        return out

    def forecast(self, series: dict[str, list[Bar]], pred_len: int) -> dict[str, Forecast]:
        raise NotImplementedError(
            "MomentumEngine scores from the Panel, not from bars -- see the "
            "module docstring on why a bar-indexed 12-1 diverges for names with "
            "trading gaps. Callers must honour `uses_panel`."
        )
