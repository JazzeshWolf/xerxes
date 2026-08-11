"""
Appending today's close from the live quote.

Upstox's historical-candle endpoint excludes the running session, so a job
scheduled for 16:00 IST — explicitly "after the close" — was still ranking on
the PREVIOUS day's data. The first live run made this visible: it published a
2026-08-10 ranking at 21:52 IST on 08-11, forty minutes *after* the index
pipeline had already recorded an 08-11 bar. That pipeline merges the live quote
into its history (`build-data.mjs`), and this is the same move.

The dangerous half is the holiday case: the quote endpoint answers on a
non-trading day too, with yesterday's price. Appending that would add a
fabricated flat bar to ~200 names and corrupt every return series the ranking is
built on — silently, and in a way that looks like data. Hence the universe-level
movement check, which these tests pin.
"""

from __future__ import annotations

import datetime as dt

import pytest

from ranker import config as C
from ranker import pipeline
from ranker.universe import Member
from ranker.upstox import Bar, bar_from_quote


def _members(n: int) -> list[Member]:
    return [Member(symbol=f"S{i}", name=f"S{i}", sector="IT", equity_key=f"NSE_EQ|K{i}")
            for i in range(n)]


def _bars(last_close: float) -> list[Bar]:
    return [Bar(t="2026-08-10", o=last_close, h=last_close, l=last_close,
                c=last_close, v=1000.0)]


@pytest.fixture
def after_close(monkeypatch):
    monkeypatch.setattr(pipeline, "ist_now",
                        lambda: dt.datetime(2026, 8, 11, 16, 0))


# --- bar_from_quote ---------------------------------------------------------


def test_bar_from_quote_builds_a_consistent_bar():
    b = bar_from_quote("2026-08-11",
                       {"last_price": 105.0, "open": 100.0, "high": 106.0,
                        "low": 99.0, "volume": 5000.0})
    assert (b.t, b.o, b.c, b.v) == ("2026-08-11", 100.0, 105.0, 5000.0)
    assert b.h >= max(b.o, b.c) and b.l <= min(b.o, b.c)


def test_bar_from_quote_falls_back_to_last_price():
    # A thin quote should still yield a usable close rather than nothing.
    b = bar_from_quote("2026-08-11", {"last_price": 50.0})
    assert b.o == b.h == b.l == b.c == 50.0


def test_bar_from_quote_repairs_an_inconsistent_range():
    # If last price printed outside the reported range, widen the range rather
    # than emit a bar with high < close, which the loader would drop.
    b = bar_from_quote("2026-08-11",
                       {"last_price": 120.0, "open": 100.0, "high": 110.0, "low": 95.0})
    assert b.h >= 120.0 and b.l <= 100.0


def test_bar_from_quote_needs_a_price():
    assert bar_from_quote("2026-08-11", {}) is None
    assert bar_from_quote("2026-08-11", {"last_price": None}) is None


# --- the clock gate ---------------------------------------------------------


def test_does_not_append_before_the_close(monkeypatch):
    monkeypatch.setattr(pipeline, "ist_now", lambda: dt.datetime(2026, 8, 11, 12, 0))
    called = {"n": 0}
    monkeypatch.setattr(pipeline, "quotes", lambda *a: called.__setitem__("n", 1) or {})

    bars = {"S0": _bars(100.0)}
    # Mid-session the "close" would be an intraday price. Ranking on a
    # half-formed session is worse than honestly ranking on yesterday.
    assert pipeline.append_todays_close("tok", _members(1), bars) is False
    assert called["n"] == 0
    assert len(bars["S0"]) == 1


def test_appends_after_the_close(after_close, monkeypatch):
    members = _members(10)
    bars = {m.symbol: _bars(100.0) for m in members}
    monkeypatch.setattr(
        pipeline, "quotes",
        lambda tok, keys: {k: {"last_price": 100.0 + i} for i, k in enumerate(keys)},
    )
    assert pipeline.append_todays_close("tok", members, bars) is True
    assert all(len(b) == 2 for b in bars.values())
    assert bars["S1"][-1].t == "2026-08-11"


def test_skips_when_candles_already_cover_today(after_close, monkeypatch):
    called = {"n": 0}
    monkeypatch.setattr(pipeline, "quotes", lambda *a: called.__setitem__("n", 1) or {})
    bars = {"S0": [Bar(t="2026-08-11", o=1, h=1, l=1, c=1, v=1)]}
    assert pipeline.append_todays_close("tok", _members(1), bars) is False
    assert called["n"] == 0


# --- the holiday guard ------------------------------------------------------


def test_holiday_appends_nothing(after_close, monkeypatch):
    # The quote endpoint answers on a holiday too, echoing yesterday's price.
    # Appending that would put a fabricated flat bar on every name.
    members = _members(20)
    bars = {m.symbol: _bars(100.0) for m in members}
    monkeypatch.setattr(pipeline, "quotes",
                        lambda tok, keys: {k: {"last_price": 100.0} for k in keys})

    assert pipeline.append_todays_close("tok", members, bars) is False
    assert all(len(b) == 1 for b in bars.values()), "no fabricated bars"


def test_a_genuine_session_with_a_few_flat_names_still_appends(after_close, monkeypatch):
    members = _members(20)
    bars = {m.symbol: _bars(100.0) for m in members}

    # 16 of 20 move: a real, if quiet, session.
    def q(tok, keys):
        return {k: {"last_price": 100.0 if i < 4 else 100.0 + i}
                for i, k in enumerate(keys)}

    monkeypatch.setattr(pipeline, "quotes", q)
    assert pipeline.append_todays_close("tok", members, bars) is True
    assert all(len(b) == 2 for b in bars.values())


def test_threshold_is_the_documented_one(after_close, monkeypatch):
    # Exactly at the floor should not pass — the guard is a floor, not a target.
    members = _members(10)
    bars = {m.symbol: _bars(100.0) for m in members}
    moved = int(C.MIN_MOVED_FRACTION * 10) - 1

    def q(tok, keys):
        return {k: {"last_price": 100.0 + (i + 1 if i < moved else 0)}
                for i, k in enumerate(keys)}

    monkeypatch.setattr(pipeline, "quotes", q)
    assert pipeline.append_todays_close("tok", members, bars) is False


def test_no_quotes_at_all_is_not_treated_as_a_session(after_close, monkeypatch):
    members = _members(5)
    bars = {m.symbol: _bars(100.0) for m in members}
    monkeypatch.setattr(pipeline, "quotes", lambda tok, keys: {})
    assert pipeline.append_todays_close("tok", members, bars) is False
    assert all(len(b) == 1 for b in bars.values())
