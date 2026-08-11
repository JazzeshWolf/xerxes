"""
Chunked history fetching.

The first live run failed with every historical-candle call returning 403 while
the instrument-master fetch on the same run succeeded. Two things differed and
both are fixed: the candle calls sent urllib's default User-Agent, and they
asked for a 6-year span in one request when the screener's proven Node path only
ever asks for 260 days. Multi-year history therefore has to be stitched from
windows — which this service needs regardless, since Kronos's 512-bar context is
~2.5 years of trading days.

These tests exercise the stitching without touching the network by substituting
the single-window fetcher.
"""

from __future__ import annotations

import datetime as dt

import pytest

from ranker import config as C
from ranker import upstox
from ranker.upstox import Bar, daily_candles


def _bars(start: str, n: int) -> list[Bar]:
    d = dt.date.fromisoformat(start)
    out = []
    for i in range(n):
        day = d + dt.timedelta(days=i)
        out.append(Bar(t=day.isoformat(), o=100.0, h=101.0, l=99.0, c=100.0, v=1000.0))
    return out


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(upstox.time, "sleep", lambda *_: None)


def test_spans_the_whole_range_in_multiple_windows(monkeypatch):
    seen: list[tuple[str, str]] = []

    def fake(token, key, frm, to):
        seen.append((frm, to))
        days = (dt.date.fromisoformat(to) - dt.date.fromisoformat(frm)).days + 1
        return _bars(frm, days)

    monkeypatch.setattr(upstox, "_candles_window", fake)
    out = daily_candles("tok", "NSE_EQ|X", "2021-01-01", "2024-01-01")

    # A 3-year ask must not go out as one request.
    assert len(seen) > 1
    assert all(
        (dt.date.fromisoformat(to) - dt.date.fromisoformat(frm)).days <= C.HISTORY_CHUNK_DAYS
        for frm, to in seen
    )
    # And the windows must tile the range with no hole between them.
    assert seen[0][0] == "2021-01-01"
    assert seen[-1][1] == "2024-01-01"
    for (_, prev_to), (next_from, _) in zip(seen, seen[1:]):
        gap = (dt.date.fromisoformat(next_from) - dt.date.fromisoformat(prev_to)).days
        assert gap == 1
    assert out[0].t == "2021-01-01"
    assert out[-1].t == "2024-01-01"


def test_returns_bars_oldest_first_and_deduplicated(monkeypatch):
    # Overlapping windows are the realistic case at a boundary; one bar per date.
    monkeypatch.setattr(upstox, "_candles_window", lambda *a: _bars("2023-01-01", 400))
    out = daily_candles("tok", "NSE_EQ|X", "2023-01-01", "2024-06-01")
    dates = [b.t for b in out]
    assert dates == sorted(dates)
    assert len(dates) == len(set(dates))


def test_a_failing_window_keeps_what_was_already_collected(monkeypatch):
    calls = {"n": 0}

    def flaky(token, key, frm, to):
        calls["n"] += 1
        if calls["n"] == 1:
            return _bars(frm, 50)
        raise upstox.UpstoxError("HTTP 403 — token expired")

    monkeypatch.setattr(upstox, "_candles_window", flaky)
    out = daily_candles("tok", "NSE_EQ|X", "2021-01-01", "2024-01-01")

    assert len(out) == 50           # the first window survived
    # A structural failure repeats for every window, so we stop rather than
    # printing the same error a dozen times.
    assert calls["n"] == 2


def test_bad_date_range_returns_empty_rather_than_raising(monkeypatch):
    monkeypatch.setattr(upstox, "_candles_window", lambda *a: _bars("2023-01-01", 5))
    assert daily_candles("tok", "NSE_EQ|X", "not-a-date", "2024-01-01") == []


def test_auth_headers_carry_a_real_user_agent():
    # urllib's default UA is a common thing for API edges to reject, and the
    # instrument-master fetch (browser UA) succeeded on the same run these 403'd.
    h = upstox._auth_headers("tok")
    assert h["Authorization"] == "Bearer tok"
    assert "python" not in h["User-Agent"].lower()
    assert "Mozilla" in h["User-Agent"]


def test_http_error_body_is_surfaced(monkeypatch):
    # Patch urlopen, not _get: the conversion under test lives inside _get, and
    # replacing _get would test nothing.
    import io
    import urllib.error

    def boom(req, timeout=60.0):
        raise urllib.error.HTTPError(
            req.full_url, 403, "Forbidden", {},
            io.BytesIO(b'{"errors":[{"errorCode":"UDAPI100050","message":"Invalid token"}]}'),
        )

    monkeypatch.setattr(upstox.urllib.request, "urlopen", boom)
    # A bare "403" cannot distinguish an expired token from a rejected request;
    # the structured body can, and that ambiguity is what stalled the first run.
    with pytest.raises(upstox.UpstoxError, match="UDAPI100050"):
        upstox._candles_window("tok", "NSE_EQ|X", "2023-01-01", "2023-06-01")


def test_daily_candles_swallows_the_error_but_logs_it(monkeypatch, capsys):
    import io
    import urllib.error

    def boom(req, timeout=60.0):
        raise urllib.error.HTTPError(
            req.full_url, 403, "Forbidden", {},
            io.BytesIO(b'{"errors":[{"errorCode":"UDAPI100050","message":"Invalid token"}]}'),
        )

    monkeypatch.setattr(upstox.urllib.request, "urlopen", boom)
    # One dead symbol must not abort a 190-name run, but the reason has to reach
    # the log or the run reports "0 names" and looks like a data problem.
    assert daily_candles("tok", "NSE_EQ|X", "2023-01-01", "2024-01-01") == []
    assert "UDAPI100050" in capsys.readouterr().out
