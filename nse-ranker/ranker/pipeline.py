"""
Orchestration: the daily ranking run and the walk-forward validation run.

Two entry points, deliberately on different cadences:

* `run_daily` -- cheap. One forecast per name, once, after the close. Writes the
  ranks the tab shows.
* `run_validation` -- expensive. Re-forecasts the whole universe at every
  historical rebalance date, so with Kronos it costs roughly (number of
  rebalances) times a daily run. It writes the skill report the tab is *gated*
  on, and is meant to run weekly or on demand, never on the daily schedule.

The daily run carries the last measured skill verdict forward into its own
output, so the UI never has to join two files to know whether to trust the
ranks -- and so a daily run that happens before any validation has ever been
done is explicitly, visibly unvalidated rather than silently confident.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import time

import numpy as np

from . import config as C
from . import corpactions
from .backtest import verdict, walk_forward
from .engines import get_engine
from .neutralize import compute_betas, neutralize
from .panel import build_panel
from .ranking import deciles, percentiles, winsorize
from .universe import (
    Member,
    check_size,
    derive_fo_universe,
    load_sector_map,
    load_snapshots,
    save_snapshot,
)
from .upstox import daily_candles, fetch_instruments

ISO = "%Y-%m-%dT%H:%M:%S.000Z"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime(ISO)


# ---------------------------------------------------------------------------
# Data acquisition
# ---------------------------------------------------------------------------


def load_universe(repo_root: str, today: str) -> list[Member]:
    sector_map = load_sector_map(repo_root)
    instruments = fetch_instruments()
    if not instruments:
        # Ranking an empty universe would publish a green run over no data --
        # the exact failure the stocks pipeline already guards against.
        raise RuntimeError(
            "no NSE instrument master (all URLs and retries failed) -- refusing "
            "to build a universe. This is usually the Upstox asset CDN 403ing "
            "the runner; it typically clears within the hour."
        )
    members = derive_fo_universe(instruments, today, sector_map)
    check_size(members)
    return members


def fetch_history(
    token: str, members: list[Member], years: int = C.HISTORY_YEARS
) -> tuple[dict, dict]:
    """Daily bars per symbol, corporate-action cleaned. Returns (bars, ca_info)."""
    today = dt.date.today()
    frm = today.replace(year=today.year - years).isoformat()
    to = today.isoformat()

    bars: dict[str, list] = {}
    ca: dict[str, dict] = {}
    empty_streak = 0
    for n, m in enumerate(members, 1):
        raw = daily_candles(token, m.equity_key, frm, to)

        # A dead token or a blocked client fails EVERY call identically. Without
        # this, the run makes 190 doomed requests and then reports "0 names",
        # which reads like a data problem rather than an auth one.
        if not raw:
            empty_streak += 1
            if empty_streak >= C.MAX_CONSECUTIVE_EMPTY:
                raise RuntimeError(
                    f"{empty_streak} consecutive symbols returned no candles — "
                    "this is a systemic failure, not thin data. Check the error "
                    "printed above: an expired/revoked UPSTOX_ACCESS_TOKEN and a "
                    "rejected request look different there. Aborting rather than "
                    f"issuing {len(members) - n} more doomed requests."
                )
        else:
            empty_streak = 0

        if len(raw) < C.MIN_BARS:
            print(f"  skip {m.symbol}: {len(raw)} bars (< {C.MIN_BARS})")
            continue
        cleaned, info = corpactions.clean(raw)
        bars[m.symbol] = cleaned
        ca[m.symbol] = info
        if n % 25 == 0:
            print(f"  history {n}/{len(members)} ({len(bars)} usable)")
    return bars, ca


# ---------------------------------------------------------------------------
# Daily ranking
# ---------------------------------------------------------------------------


def rank_cross_section(
    forecasts: dict, panel, members_by_symbol: dict[str, Member], i: int
) -> tuple[list[dict], dict]:
    """Neutralise, rank and describe one cross-section."""
    symbols = [s for s in panel.symbols if s in forecasts
               and np.isfinite(forecasts[s].median_return)]
    if len(symbols) < 30:
        raise RuntimeError(
            f"only {len(symbols)} usable forecasts -- too thin to rank. Breadth "
            "is the edge; a cross-section this small is not a ranking."
        )

    sel = [panel.symbols.index(s) for s in symbols]
    raw = np.array([forecasts[s].median_return for s in symbols], dtype=float)
    betas = compute_betas(panel.daily_returns(i, C.BETA_WINDOW)[sel])
    sectors = [members_by_symbol[s].sector if s in members_by_symbol else "UNMAPPED"
               for s in symbols]

    scores, diag = neutralize(raw, betas, sectors)
    scores = winsorize(scores)
    pct = percentiles(scores)
    dec = deciles(scores)
    order = np.argsort(-scores)          # most bullish first
    rank_of = {int(k): r + 1 for r, k in enumerate(order)}

    rows = []
    for k, sym in enumerate(symbols):
        m = members_by_symbol.get(sym)
        f = forecasts[sym]
        d = int(dec[k])
        rows.append(
            {
                "symbol": sym,
                "name": m.name if m else sym,
                "sector": m.sector if m else "UNMAPPED",
                "rank": rank_of[k],
                "decile": d,
                "percentile": round(float(pct[k]), 4),
                "score": round(float(scores[k]), 6),
                "rawForecast": round(float(raw[k]), 6),
                "forecastReturn": round(float(raw[k]), 6),
                "lastClose": round(float(f.last_close), 2),
                "beta": round(float(betas[k]), 3),
                # Rounded here rather than at source: full float64 precision on
                # five quantiles x 190 names is a third of the payload, for
                # digits no chart can resolve.
                "quantiles": {k2: round(float(v2), 5) for k2, v2 in f.quantiles.items()},
                "lean": _lean(d),
                "implication": _implication(d),
            }
        )
    rows.sort(key=lambda r: r["rank"])
    return rows, diag


def _lean(decile: int) -> str:
    if decile >= C.DECILES - 1:
        return "bullish"
    if decile <= 2:
        return "bearish"
    return "neutral"


def _implication(decile: int) -> str:
    """The option-selling read. This is what the operator actually acts on."""
    lean = _lean(decile)
    if lean == "bullish":
        return "Lean bullish — prefer selling puts"
    if lean == "bearish":
        return "Lean bearish — prefer selling calls"
    return "No lean — neither side favoured by the ranking"


def run_daily(
    repo_root: str,
    token: str,
    out_dir: str,
    engine_name: str = "bootstrap",
    pred_len: int = C.PRED_LEN,
    universe_limit: int | None = None,
    vendor_path: str | None = None,
) -> dict:
    today = dt.date.today().isoformat()
    print(f"[daily] {today} engine={engine_name}")

    members = load_universe(repo_root, today)
    if universe_limit:
        # Smoke tests only. Never in production: cutting the universe trades away
        # breadth, which is the edge.
        print(f"::warning::universe truncated to {universe_limit} names (smoke test)")
        members = members[:universe_limit]
    print(f"[daily] universe: {len(members)} names")

    snap_dir = os.path.join(out_dir, "universe-snapshots")
    save_snapshot(snap_dir, today, members)

    bars, ca = fetch_history(token, members)
    print(f"[daily] history: {len(bars)} names with >= {C.MIN_BARS} bars")
    ca_audit = corpactions.audit(ca)
    print(f"[daily] corporate actions: {ca_audit['verdict']}")

    panel = build_panel(bars)
    i = panel.n_dates - 1
    by_symbol = {m.symbol: m for m in members}

    window = {s: panel.bars_upto(s, i, C.LOOKBACK_BARS) for s in panel.symbols}
    window = {s: b for s, b in window.items() if len(b) >= C.MIN_BARS}

    engine = get_engine(engine_name, vendor_path=vendor_path)
    t0 = time.time()
    if engine_name == "kronos":
        forecasts = engine.forecast(window, pred_len, with_paths=True)
    else:
        forecasts = engine.forecast(window, pred_len)
    print(f"[daily] forecast: {len(forecasts)} names in {time.time() - t0:.1f}s")

    rows, diag = rank_cross_section(forecasts, panel, by_symbol, i)

    skill = load_skill(out_dir)
    payload = {
        "asOf": _now(),
        "tradeDate": panel.dates[i],
        "engine": engine_name,
        "model": C.KRONOS_MODEL if engine_name == "kronos" else "block-bootstrap",
        "predLen": pred_len,
        "horizonLabel": f"{pred_len} trading days",
        "universeCount": len(rows),
        "neutralization": diag,
        "corporateActions": ca_audit,
        "skill": (skill or {}).get("verdict"),
        "validated": bool((skill or {}).get("verdict", {}).get("validated")),
        "rows": rows,
    }

    os.makedirs(out_dir, exist_ok=True)
    _write(os.path.join(out_dir, C.INDEX_FILE), payload)
    _write_details(out_dir, rows, forecasts, panel)
    print(f"[daily] wrote {len(rows)} ranks -> {out_dir}")
    return payload


def _write_details(out_dir: str, rows: list[dict], forecasts: dict, panel) -> None:
    """Per-name detail: sample paths and recent OHLCV, one small file each.

    Split out of index.json deliberately -- inlining paths and 60 bars for 190
    names would push the payload past half a megabyte for a view most sessions
    never open.
    """
    for r in rows:
        sym = r["symbol"]
        f = forecasts.get(sym)
        bars = panel.bars.get(sym, [])[-C.KEEP_RECENT_BARS:]
        _write(
            os.path.join(out_dir, f"{sym}.json"),
            {
                "symbol": sym,
                "name": r["name"],
                "sector": r["sector"],
                "asOf": _now(),
                "rank": r["rank"],
                "decile": r["decile"],
                "percentile": r["percentile"],
                "forecastReturn": r["forecastReturn"],
                "lastClose": r["lastClose"],
                "lean": r["lean"],
                "implication": r["implication"],
                "quantiles": f.quantiles if f else {},
                "paths": [[round(float(x), 2) for x in p] for p in (f.paths if f else [])],
                # Authoritative per-step band, from every sample rather than the
                # few paths above. The chart draws this; `paths` are texture.
                "band": {k: [round(float(x), 2) for x in v]
                         for k, v in (f.band if f else {}).items()},
                "recent": [
                    {"t": b.t, "o": round(b.o, 2), "h": round(b.h, 2),
                     "l": round(b.l, 2), "c": round(b.c, 2), "v": b.v}
                    for b in bars
                ],
            },
        )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def run_validation(
    repo_root: str,
    token: str,
    out_dir: str,
    engine_name: str = "bootstrap",
    pred_len: int = C.PRED_LEN,
    universe_limit: int | None = None,
    vendor_path: str | None = None,
) -> dict:
    today = dt.date.today().isoformat()
    print(f"[validate] {today} engine={engine_name}")

    members = load_universe(repo_root, today)
    if universe_limit:
        members = members[:universe_limit]
    bars, ca = fetch_history(token, members)
    panel = build_panel(bars)
    sector_of = {m.symbol: m.sector for m in members}

    depth = {
        "measured": True,
        "oldestBar": panel.dates[0] if panel.dates else None,
        "newestBar": panel.dates[-1] if panel.dates else None,
        "tradingDays": panel.n_dates,
        "approxYears": round(panel.n_dates / 250.0, 2),
        "requestedYears": C.HISTORY_YEARS,
        "note": (
            "Measured from what Upstox actually returned, not assumed. If "
            "approxYears is well below requestedYears, the API's depth -- not "
            "the request -- is the binding constraint."
        ),
    }

    engine = get_engine(engine_name, vendor_path=vendor_path)
    result = walk_forward(
        panel, sector_of, engine, pred_len=pred_len,
        membership=load_snapshots(os.path.join(out_dir, "universe-snapshots")) or None,
    )
    gate = verdict(result)

    payload = {
        "asOf": _now(),
        "engine": engine_name,
        "model": C.KRONOS_MODEL if engine_name == "kronos" else "block-bootstrap",
        "verdict": gate,
        "dataDepth": depth,
        "corporateActions": corpactions.audit(ca),
        "config": {
            "predLen": pred_len,
            "rebalanceEvery": C.REBALANCE_EVERY,
            "minIcir": C.MIN_ICIR,
            "minEdgeOverMomentum": C.MIN_ICIR_EDGE_OVER_MOMENTUM,
            "minRebalances": C.MIN_REBALANCES,
            "costRoundTripBps": round(C.COSTS.round_trip_bps(), 2),
            "impactBps": C.COSTS.impact_bps,
        },
        **{k: v for k, v in result.items() if k != "perDate"},
        "perDate": result["perDate"],
    }

    os.makedirs(out_dir, exist_ok=True)
    _write(os.path.join(out_dir, C.SKILL_FILE), payload)
    print(f"[validate] {gate['summary']}")
    return payload


def load_skill(out_dir: str) -> dict | None:
    path = os.path.join(out_dir, C.SKILL_FILE)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def _write(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"), allow_nan=False, default=_json_safe)


def _json_safe(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        v = float(o)
        return v if np.isfinite(v) else None
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not JSON serialisable: {type(o)}")
