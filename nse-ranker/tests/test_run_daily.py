"""
An end-to-end smoke test of `run_daily`, with the network stubbed.

It exists because of a real production failure. The engine swap added an
`expiries` local to `run_daily`, an edit landed that did not apply, and the
resulting `NameError` passed **119 unit tests** untouched — every one of them
exercised a function *inside* the pipeline, none ran the pipeline itself. The
break only surfaced on a runner, fifteen minutes into fetching history, after
which the job died having published nothing.

So this asserts almost nothing about the numbers. Its job is to prove the daily
path executes at all: universe -> history -> engine -> rank -> payload -> write.
A typo anywhere on that path fails here in under a second instead of in CI.
"""

from __future__ import annotations

import json
import os

import numpy as np
import pytest

from ranker import config as C
from ranker import pipeline
from ranker.universe import Member
from ranker.upstox import Bar

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _bars(n: int, seed: int, start: float = 100.0) -> list[Bar]:
    """`n` consecutive weekday bars ending just before the stubbed expiries."""
    import datetime as dt

    rng = np.random.default_rng(seed)
    px, out = start, []
    d = dt.date(2026, 9, 11)
    days: list[dt.date] = []
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= dt.timedelta(days=1)
    for day in reversed(days):
        px *= float(np.exp(rng.normal(0.0004, 0.012)))
        out.append(Bar(t=day.isoformat(), o=px, h=px * 1.01, l=px * 0.99, c=px, v=1000.0))
    return out


@pytest.fixture
def stubbed(monkeypatch, tmp_path):
    """Every network edge replaced; everything downstream of them runs for real."""
    syms = [f"S{i:03d}" for i in range(40)]
    members = [
        Member(symbol=s, name=s, sector=["IT", "BANK", "AUTO"][k % 3], equity_key=f"NSE_EQ|{k}")
        for k, s in enumerate(syms)
    ]
    expiries = ["2026-09-29", "2026-10-27"]

    monkeypatch.setattr(
        pipeline, "load_universe",
        lambda root, today, want_expiries=False: (members, expiries) if want_expiries else members,
    )
    monkeypatch.setattr(
        pipeline, "fetch_history",
        lambda token, ms: ({m.symbol: _bars(400, i, 100.0 + i) for i, m in enumerate(ms)}, {}),
    )
    # The live-quote append has its own tests; keep it out of this path.
    monkeypatch.setattr(pipeline, "append_todays_close", lambda *a, **k: False)
    return {"out": str(tmp_path), "symbols": syms}


def test_run_daily_completes_and_writes_an_index(stubbed):
    payload = pipeline.run_daily(REPO_ROOT, "tok", stubbed["out"], engine_name="momentum")
    assert payload["universeCount"] > 0
    written = json.load(open(os.path.join(stubbed["out"], C.INDEX_FILE)))
    assert written["rows"], "an index with no rows is a broken publish"
    assert len(written["rows"]) == payload["universeCount"]


def test_run_daily_publishes_the_expiry_guidance(stubbed):
    # The regression that prompted this file: `expiries` went out of scope and
    # the whole run died here.
    p = pipeline.run_daily(REPO_ROOT, "tok", stubbed["out"], engine_name="momentum")
    assert p["expiry"]["current"]["date"] == "2026-09-29"
    assert p["expiry"]["horizonTradingDays"] == C.PRED_LEN


def test_run_daily_labels_the_horizon_forward_not_backward(stubbed):
    # horizonLabel is the HOLDING period; the signal's lookback lives in
    # `signal.window`. Conflating them once already lost the only number that
    # says which expiry to sell.
    p = pipeline.run_daily(REPO_ROOT, "tok", stubbed["out"], engine_name="momentum")
    assert "trading days" in p["horizonLabel"]
    assert p["signal"]["kind"] == "factor"
    assert p["signal"]["window"] != p["horizonLabel"]


def test_run_daily_writes_a_detail_file_per_ranked_name(stubbed):
    p = pipeline.run_daily(REPO_ROOT, "tok", stubbed["out"], engine_name="momentum")
    for row in p["rows"][:5]:
        d = json.load(open(os.path.join(stubbed["out"], f"{row['symbol']}.json")))
        assert d["symbol"] == row["symbol"]
        assert d["signal"]["kind"] == "factor"


def test_run_daily_works_on_the_bootstrap_engine_too(stubbed):
    # The panel/bars dispatch must not have broken the generative path.
    p = pipeline.run_daily(REPO_ROOT, "tok", stubbed["out"], engine_name="bootstrap")
    assert p["universeCount"] > 0
    assert p["signal"]["kind"] == "forecastReturn"
    assert "trading days" in p["horizonLabel"]
