"""
Command line entry points.

    python -m ranker.cli probe      # measure Upstox history depth, report, exit
    python -m ranker.cli daily      # build today's ranks
    python -m ranker.cli validate   # walk-forward, write skill.json + report.md
    python -m ranker.cli demo       # synthetic data, no network, no weights

`demo` exists because this service was written in a sandbox with no route to
Upstox and no route to HuggingFace. It generates a correctly-shaped payload from
synthetic prices so the frontend can be built and tested against the real
schema. Its output is stamped `"demo": true` and the UI refuses to present it as
a real ranking -- fixture data that can masquerade as a live signal is worse than
no fixture at all.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

from . import config as C
from . import report as report_mod
from .pipeline import _write, run_daily, run_validation
from .upstox import measure_history_depth


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _token() -> str:
    tok = os.environ.get("UPSTOX_ACCESS_TOKEN", "").strip()
    if not tok:
        print("UPSTOX_ACCESS_TOKEN is not set", file=sys.stderr)
        sys.exit(2)
    return tok


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ranker")
    p.add_argument("command", choices=["probe", "daily", "validate", "demo"])
    p.add_argument("--engine", default=os.environ.get("RANKER_ENGINE", "bootstrap"))
    p.add_argument("--out", default=None, help="output directory")
    p.add_argument("--pred-len", type=int, default=C.PRED_LEN)
    p.add_argument("--limit", type=int, default=None,
                   help="truncate the universe (SMOKE TESTS ONLY -- cutting "
                        "breadth trades away the edge)")
    p.add_argument("--vendor", default=os.environ.get("KRONOS_VENDOR_PATH"),
                   help="path to the vendored Kronos repo (for PYTHONPATH)")
    args = p.parse_args(argv)

    root = _repo_root()
    out = args.out or os.path.join(root, C.OUT_DIR)

    if args.command == "probe":
        return _probe(out)

    if args.command == "demo":
        return _demo(root, out)

    if args.command == "daily":
        run_daily(root, _token(), out, engine_name=args.engine,
                  pred_len=args.pred_len, universe_limit=args.limit,
                  vendor_path=args.vendor)
        return 0

    if args.command == "validate":
        skill = run_validation(root, _token(), out, engine_name=args.engine,
                               pred_len=args.pred_len, universe_limit=args.limit,
                               vendor_path=args.vendor)
        md = report_mod.render(skill)
        path = os.path.join(out, "REPORT.md")
        os.makedirs(out, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(md)
        print(f"[validate] report -> {path}")
        print()
        print(md)
        return 0 if skill["verdict"]["validated"] else 0  # measurement, not a build failure

    return 1


def _probe(out: str) -> int:
    """Answer 'how far back do Upstox daily candles go?' by measuring it."""
    from .universe import load_sector_map  # noqa: PLC0415
    from .upstox import fetch_instruments  # noqa: PLC0415
    from .universe import derive_fo_universe  # noqa: PLC0415

    token = _token()
    today = dt.date.today().isoformat()
    instruments = fetch_instruments()
    if not instruments:
        print("no instrument master -- cannot probe", file=sys.stderr)
        return 1
    members = derive_fo_universe(instruments, today, load_sector_map(_repo_root()))
    print(f"universe: {len(members)} F&O single stocks")

    results = []
    for m in members[:5]:
        d = measure_history_depth(token, m.equity_key)
        d["symbol"] = m.symbol
        results.append(d)
        print(f"  {m.symbol}: {d}")

    payload = {"asOf": dt.datetime.utcnow().isoformat() + "Z",
               "universeCount": len(members), "probes": results}
    _write(os.path.join(out, "probe.json"), payload)
    print(json.dumps(payload, indent=2))
    return 0


def _demo(root: str, out: str) -> int:
    """Synthetic end-to-end run: real symbols and sectors, invented prices."""
    import numpy as np  # noqa: PLC0415

    from .backtest import verdict, walk_forward  # noqa: PLC0415
    from .engines import get_engine  # noqa: PLC0415
    from .panel import build_panel  # noqa: PLC0415
    from .pipeline import _write_details, rank_cross_section  # noqa: PLC0415
    from .universe import Member, load_sector_map  # noqa: PLC0415
    from .upstox import Bar  # noqa: PLC0415

    sector_map = load_sector_map(root)
    symbols = sorted(sector_map)[:190]
    members = [Member(symbol=s, name=sector_map[s][0], sector=sector_map[s][1],
                      equity_key=f"NSE_EQ|{s}") for s in symbols]

    rng = np.random.default_rng(7)
    n, days = len(symbols), 700
    drift = np.zeros((n, days))
    drift[:, 0] = rng.standard_normal(n) * 0.0015
    for t in range(1, days):
        drift[:, t] = 0.99 * drift[:, t - 1] + rng.standard_normal(n) * 0.00025
    market = rng.standard_normal(days) * 0.009
    betas = rng.uniform(0.5, 1.8, n)
    rets = drift + betas[:, None] * market[None, :] + rng.standard_normal((n, days)) * 0.008
    prices = 100.0 * np.exp(np.cumsum(rets, axis=1)) * rng.uniform(0.5, 30, n)[:, None]

    start = dt.date.today() - dt.timedelta(days=int(days * 1.45))
    bars = {}
    for k, s in enumerate(symbols):
        d, seq = start, []
        for c in prices[k]:
            while d.weekday() >= 5:
                d += dt.timedelta(days=1)
            c = float(c)
            seq.append(Bar(t=d.isoformat(), o=c * 0.999, h=c * 1.005, l=c * 0.995,
                           c=c, v=float(rng.integers(50_000, 5_000_000))))
            d += dt.timedelta(days=1)
        bars[s] = seq

    panel = build_panel(bars)
    engine = get_engine("bootstrap")
    i = panel.n_dates - 1
    window = {s: panel.bars_upto(s, i, C.LOOKBACK_BARS) for s in panel.symbols}
    forecasts = engine.forecast(window, C.PRED_LEN)
    rows, diag = rank_cross_section(forecasts, panel, {m.symbol: m for m in members}, i)

    print("[demo] running walk-forward on synthetic data…")
    result = walk_forward(panel, {m.symbol: m.sector for m in members}, engine,
                          pred_len=C.PRED_LEN, progress=False)
    gate = verdict(result)

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    skill = {
        "asOf": now, "demo": True, "engine": "bootstrap",
        "model": "block-bootstrap (SYNTHETIC DEMO DATA)",
        "verdict": gate,
        "dataDepth": {"measured": False, "oldestBar": panel.dates[0],
                      "newestBar": panel.dates[-1], "tradingDays": panel.n_dates,
                      "approxYears": round(panel.n_dates / 250, 2),
                      "requestedYears": C.HISTORY_YEARS,
                      "note": "SYNTHETIC — not a measurement of Upstox depth."},
        "config": {"predLen": C.PRED_LEN, "rebalanceEvery": C.REBALANCE_EVERY,
                   "minIcir": C.MIN_ICIR,
                   "minEdgeOverMomentum": C.MIN_ICIR_EDGE_OVER_MOMENTUM,
                   "minRebalances": C.MIN_REBALANCES,
                   "costRoundTripBps": round(C.COSTS.round_trip_bps(), 2),
                   "impactBps": C.COSTS.impact_bps},
        **{k: v for k, v in result.items() if k != "perDate"},
        "perDate": result["perDate"],
    }
    index = {
        "asOf": now, "demo": True, "tradeDate": panel.dates[i],
        "engine": "bootstrap", "model": "block-bootstrap (SYNTHETIC DEMO DATA)",
        "predLen": C.PRED_LEN, "horizonLabel": f"{C.PRED_LEN} trading days",
        "universeCount": len(rows), "neutralization": diag,
        "corporateActions": {"actionsDetected": 0, "symbolsAffected": 0,
                             "largeMovesRejected": 0, "actionsPer100Symbols": 0,
                             "verdict": "SYNTHETIC — no corporate actions modelled."},
        "skill": gate, "validated": bool(gate["validated"]), "rows": rows,
    }

    _write(os.path.join(out, C.INDEX_FILE), index)
    _write(os.path.join(out, C.SKILL_FILE), skill)
    # Write the per-name files too, so the demo exercises the same output shape
    # the UI's detail view reads rather than only the half of it the table uses.
    _write_details(out, rows, forecasts, panel)
    with open(os.path.join(out, "REPORT.md"), "w", encoding="utf-8") as fh:
        fh.write(report_mod.render(skill))
    print(f"[demo] wrote {len(rows)} synthetic ranks -> {out}")
    print(f"[demo] {gate['summary']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
