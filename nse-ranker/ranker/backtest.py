"""
Walk-forward validation. Strictly point-in-time, no lookahead.

## The discipline this file enforces

At each rebalance date `i` the harness may touch **only** `panel[:, :i+1]`. The
forecast is built from that window, beta is estimated from that window, the
universe is the membership snapshot recorded at or before that date, and the
realised return used to score it comes from `i -> i + pred_len`, which the
forecast never saw. Every one of those is a place a backtest normally leaks, so
they all funnel through `Panel.window` / `Panel.forward_return`, which are
asymmetric by construction.

Rebalances are spaced `REBALANCE_EVERY == PRED_LEN` apart so the IC series does
not overlap. Overlapping windows autocorrelate the ICs and inflate ICIR and the
t-stat -- the two numbers this whole exercise exists to measure honestly. If the
spacing is ever set below the horizon, `summarize` is told, and it labels the
result as inflated rather than letting it be read as skill.

## What the benchmarks share

Every benchmark runs through the *same* neutralisation, ranking, decile and cost
path as the engine. A momentum benchmark scored on raw returns while the model
is scored on neutralised ones would be a rigged comparison; here the only thing
that differs between arms is where the score came from.
"""

from __future__ import annotations

import numpy as np

from . import config as C
from . import costs as K
from .benchmarks import BENCHMARKS
from .engines.base import Engine
from .ic import information_coefficient, summarize
from .neutralize import compute_betas, neutralize
from .panel import Panel
from .ranking import deciles


def rebalance_dates(panel: Panel, pred_len: int, every: int, min_history: int) -> list[int]:
    """Date indices with enough history behind and a full horizon ahead."""
    first = max(min_history, C.BETA_WINDOW)
    last = panel.n_dates - pred_len - 1
    return list(range(first, last + 1, every)) if last >= first else []


def _score_arm(
    raw: np.ndarray,
    betas: np.ndarray,
    sectors: list[str],
    symbols: list[str],
    fwd: np.ndarray,
    prev_weights: dict[str, float],
) -> dict:
    """Neutralise -> rank -> decile -> IC and leg returns, for one arm."""
    scores, diag = neutralize(raw, betas, sectors)
    ic = information_coefficient(scores, fwd)
    dec = deciles(scores)

    weights = K.decile_weights(dec, symbols)
    turn = K.turnover(prev_weights, weights)

    top = np.array([fwd[i] for i, d in enumerate(dec) if d == C.DECILES], dtype=float)
    bot = np.array([fwd[i] for i, d in enumerate(dec) if d == 1], dtype=float)
    top = top[np.isfinite(top)]
    bot = bot[np.isfinite(bot)]

    return {
        "ic": ic,
        "scores": scores,
        "deciles": dec,
        "weights": weights,
        "turnover": turn,
        "topReturn": float(top.mean()) if top.size else float("nan"),
        "bottomReturn": float(bot.mean()) if bot.size else float("nan"),
        "diagnostics": diag,
    }


def walk_forward(
    panel: Panel,
    sector_of: dict[str, str],
    engine: Engine,
    pred_len: int = C.PRED_LEN,
    lookback: int = C.LOOKBACK_BARS,
    every: int = C.REBALANCE_EVERY,
    membership: dict[str, set[str]] | None = None,
    seed: int = C.BOOTSTRAP_SEED,
    progress: bool = True,
) -> dict:
    """Run the walk-forward and return everything the report needs.

    `membership` maps date -> symbol set for point-in-time universe. When a date
    has no snapshot the full panel is used and the shortfall is counted, so
    survivorship bias is reported rather than hidden.
    """
    idxs = rebalance_dates(panel, pred_len, every, C.MIN_BARS)
    arms = ["engine", *BENCHMARKS.keys()]
    ics: dict[str, list[float]] = {a: [] for a in arms}
    legs: dict[str, list[dict]] = {a: [] for a in arms}
    prev_w: dict[str, dict[str, float]] = {a: {} for a in arms}
    diagnostics: list[dict] = []
    per_date: list[dict] = []
    pit_dates = 0

    for n, i in enumerate(idxs):
        date = panel.dates[i]

        # -- point-in-time universe ----------------------------------------
        allowed: set[str] | None = None
        if membership:
            usable = [d for d in membership if d <= date]
            if usable:
                allowed = membership[max(usable)]
                pit_dates += 1

        valid = panel.valid_mask(i, C.MIN_BARS)
        sel = [
            k for k, s in enumerate(panel.symbols)
            if valid[k] and (allowed is None or s in allowed)
        ]
        if len(sel) < 30:  # too thin a cross-section to rank meaningfully
            continue
        symbols = [panel.symbols[k] for k in sel]
        sectors = [sector_of.get(s, "UNMAPPED") for s in symbols]

        # -- inputs, all strictly historical -------------------------------
        betas = compute_betas(panel.daily_returns(i, C.BETA_WINDOW)[sel])
        fwd = panel.forward_return(i, pred_len)[sel]

        window = {s: panel.bars_upto(s, i, lookback) for s in symbols}
        window = {s: b for s, b in window.items() if len(b) >= C.MIN_BARS}
        if len(window) < 30:
            continue
        forecasts = engine.forecast(window, pred_len)
        raw = np.array(
            [
                forecasts[s].median_return if s in forecasts else np.nan
                for s in symbols
            ],
            dtype=float,
        )

        row: dict = {"date": date, "n": len(symbols), "pointInTime": allowed is not None}
        for arm in arms:
            arm_raw = raw if arm == "engine" else BENCHMARKS[arm](panel, i, seed + n)
            if arm != "engine":
                arm_raw = np.asarray(arm_raw, dtype=float)[sel]
            res = _score_arm(arm_raw, betas, sectors, symbols, fwd, prev_w[arm])
            prev_w[arm] = res["weights"]
            ics[arm].append(res["ic"])
            legs[arm].append(
                {
                    "date": date,
                    "topReturn": res["topReturn"],
                    "bottomReturn": res["bottomReturn"],
                    "turnover": res["turnover"],
                }
            )
            row[arm] = {
                "ic": _r(res["ic"]),
                "spread": _r(res["topReturn"] - res["bottomReturn"]),
                "turnover": _r(res["turnover"]),
            }
            if arm == "engine":
                diagnostics.append({"date": date, **res["diagnostics"]})

        per_date.append(row)
        if progress:
            print(f"  [{n + 1}/{len(idxs)}] {date}  n={len(symbols)}  IC={_r(ics['engine'][-1])}")

    overlapping = every < pred_len
    return {
        "rebalances": len(per_date),
        "predLen": pred_len,
        "rebalanceEvery": every,
        "overlapping": overlapping,
        "arms": {
            arm: {
                "ic": summarize(ics[arm], overlapping=overlapping),
                "spread": K.spread_returns([l for l in legs[arm]
                                            if np.isfinite(l["topReturn"])
                                            and np.isfinite(l["bottomReturn"])]),
            }
            for arm in arms
        },
        "neutralization": _summarize_diagnostics(diagnostics),
        "universeCoverage": {
            "rebalances": len(per_date),
            "pointInTime": pit_dates,
            "fallback": len(per_date) - pit_dates,
            "note": (
                "`fallback` dates used the current F&O list for a past date and "
                "therefore carry survivorship bias. Snapshots only accumulate "
                "going forward, so early runs are expected to be all fallback."
            ),
        },
        "perDate": per_date,
    }


def _summarize_diagnostics(rows: list[dict]) -> dict:
    """Average the before/after neutralisation numbers across rebalances."""
    if not rows:
        return {}

    def avg(path: str, key: str) -> float | None:
        vals = [r[path][key] for r in rows if r.get(path, {}).get(key) is not None]
        return round(float(np.mean(vals)), 4) if vals else None

    after_beta, after_sector = avg("after", "betaRankCorr"), avg("after", "sectorR2")
    passed = sum(1 for r in rows if r.get("passed"))
    return {
        "before": {"betaRankCorr": avg("before", "betaRankCorr"),
                   "sectorR2": avg("before", "sectorR2")},
        "after": {"betaRankCorr": after_beta, "sectorR2": after_sector},
        "passedRebalances": passed,
        "totalRebalances": len(rows),
        "thresholds": {
            "maxBetaRankCorr": C.MAX_BETA_CORR_AFTER,
            "maxSectorR2": C.MAX_SECTOR_R2_AFTER,
        },
        "verdict": (
            "Neutralisation is working: post-neutralisation beta correlation and "
            "sector R^2 are both inside their bars."
            if passed == len(rows)
            else f"Neutralisation FAILED on {len(rows) - passed}/{len(rows)} "
                 "rebalances -- the ranking is still partly beta or sector, and "
                 "should not be treated as stock selection."
        ),
    }


def verdict(result: dict) -> dict:
    """Turn the backtest into the gate the UI reads.

    Deliberately blunt. Two ways to fail, and the momentum one is the one that
    matters commercially: a model that ties 12-1 momentum has bought nothing for
    its 12 billion training candles.
    """
    engine_ic = result["arms"]["engine"]["ic"]
    mom_ic = result["arms"].get("momentum_12_1", {}).get("ic", {})
    icir = engine_ic.get("icir")
    mom_icir = mom_ic.get("icir")
    n = engine_ic.get("n") or 0

    reasons: list[str] = []
    if n < C.MIN_REBALANCES:
        reasons.append(
            f"only {n} rebalances (need {C.MIN_REBALANCES}); the t-stat is not "
            "interpretable at this sample size"
        )
    if icir is None:
        reasons.append("ICIR could not be computed")
    elif icir < C.MIN_ICIR:
        reasons.append(f"ICIR {icir:.2f} is below the {C.MIN_ICIR:.2f} bar")
    if icir is not None and mom_icir is not None:
        edge = icir - mom_icir
        if edge < C.MIN_ICIR_EDGE_OVER_MOMENTUM:
            reasons.append(
                f"ICIR beats 12-1 momentum by only {edge:+.2f} (need "
                f"{C.MIN_ICIR_EDGE_OVER_MOMENTUM:+.2f}) -- momentum is free, so "
                "this model is not earning its compute"
            )
    if result.get("overlapping"):
        reasons.append("rebalances overlap the forecast horizon, so ICIR is inflated")
    if not result.get("neutralization", {}).get("verdict", "").startswith("Neutralisation is working"):
        reasons.append("neutralisation did not pass on every rebalance")

    return {
        "validated": not reasons,
        "icir": icir,
        "momentumIcir": mom_icir,
        "edgeOverMomentum": _r(icir - mom_icir) if icir is not None and mom_icir is not None else None,
        "bar": C.MIN_ICIR,
        "reasons": reasons,
        "summary": (
            "Measured skill clears the stated bar."
            if not reasons
            else "UNVALIDATED -- " + "; ".join(reasons)
        ),
    }


def _r(x) -> float | None:
    if x is None or not np.isfinite(x):
        return None
    return round(float(x), 6)
