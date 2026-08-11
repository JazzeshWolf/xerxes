"""
Upstox market-data client for the ranker (read-only, daily bars only).

Deliberately a *copy* of the patterns in `scripts/upstox.mjs` rather than an
import of it: the build spec isolates this service from the screener's pipeline,
and a shared module would couple a Python cron to a Node one. What is reproduced
here is the hard-won operational behaviour, not the code:

* the asset CDN intermittently 403s GitHub runners, so the instrument master is
  retried with backoff across two URLs before giving up (CLAUDE.md documents a
  live incident where both URLs 403'd for ~30 minutes);
* an HTML or empty body masquerading as gzip is treated as a block, not as data;
* every fetcher fails soft, returning empty rather than raising, so one dead
  symbol cannot abort a 200-name run.

Standard library only -- no `requests` -- so the service installs fast on a
runner and the pure-math modules stay importable without any third-party stack.
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass

from . import config as C

_BROWSERISH = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/gzip, application/octet-stream, application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://upstox.com/",
}


@dataclass(frozen=True)
class Bar:
    t: str      # ISO date
    o: float
    h: float
    l: float
    c: float
    v: float


class UpstoxError(RuntimeError):
    pass


def _get(url: str, headers: dict, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        if res.status != 200:
            raise UpstoxError(f"{url} -> {res.status}")
        return res.read()


def fetch_instruments() -> list[dict]:
    """The NSE instrument master, gunzipped, with the documented retry posture.

    Returns [] only after every URL and attempt has failed. Callers must treat
    an empty master as a hard abort -- ranking an empty universe would publish a
    green run over no data, the exact failure mode the stocks pipeline guards
    against.
    """
    for url in (C.UPSTOX_INSTRUMENTS_NSE, C.UPSTOX_INSTRUMENTS_ALL):
        for attempt in range(1, C.FETCH_ATTEMPTS + 1):
            try:
                buf = _get(url, _BROWSERISH)
                is_gz = len(buf) > 2 and buf[0] == 0x1F and buf[1] == 0x8B
                # A '<' first byte or a tiny body is an error page, not data.
                if not is_gz and (len(buf) < 100 or buf[:1] == b"<"):
                    raise UpstoxError("blocked (HTML/empty response)")
                text = gzip.decompress(buf).decode("utf-8") if is_gz else buf.decode("utf-8")
                rows = json.loads(text)
                if isinstance(rows, list) and rows:
                    print(f"upstox instruments: {len(rows)} from {url}")
                    return rows
                raise UpstoxError("empty instrument list")
            except Exception as exc:  # noqa: BLE001 - fail soft, try the next URL
                print(f"upstox instruments {url} (attempt {attempt}/{C.FETCH_ATTEMPTS}): {exc}")
                if attempt < C.FETCH_ATTEMPTS:
                    time.sleep(C.FETCH_BACKOFF_SEC * attempt)
    return []


def daily_candles(token: str, instrument_key: str, from_iso: str, to_iso: str) -> list[Bar]:
    """Daily OHLCV, oldest-first.

    Upstox returns candles newest-first as
    ``[timestamp, open, high, low, close, volume, oi]``; we reverse and drop any
    bar that is not internally consistent (non-positive price, high < low).
    """
    url = (
        f"{C.UPSTOX_BASE}/historical-candle/"
        f"{urllib.parse.quote(instrument_key, safe='')}/day/{to_iso}/{from_iso}"
    )
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    try:
        payload = json.loads(_get(url, headers))
    except Exception as exc:  # noqa: BLE001 - one dead symbol must not abort the run
        print(f"upstox candles {instrument_key}: {exc}")
        return []

    out: list[Bar] = []
    for row in payload.get("data", {}).get("candles", []) or []:
        try:
            t = str(row[0])[:10]
            o, h, l, c = float(row[1]), float(row[2]), float(row[3]), float(row[4])
            v = float(row[5]) if len(row) > 5 and row[5] is not None else 0.0
        except (TypeError, ValueError, IndexError):
            continue
        if min(o, h, l, c) <= 0 or h < l:
            continue
        out.append(Bar(t=t, o=o, h=h, l=l, c=c, v=v))
    out.reverse()
    return out


def measure_history_depth(token: str, instrument_key: str, years: int = 12) -> dict:
    """Ask for far more history than we need and report what actually came back.

    The build spec asks how far back Upstox daily candles go. That cannot be
    answered from a sandbox with no route to the API, and it should not be
    guessed -- so it is *measured* on the runner and written into the report.
    """
    import datetime as dt

    today = dt.date.today()
    frm = today.replace(year=today.year - years).isoformat()
    bars = daily_candles(token, instrument_key, frm, today.isoformat())
    if not bars:
        return {"ok": False, "requestedFrom": frm, "note": "no candles returned"}
    return {
        "ok": True,
        "instrument": instrument_key,
        "requestedFrom": frm,
        "oldestBar": bars[0].t,
        "newestBar": bars[-1].t,
        "bars": len(bars),
        "approxYears": round(len(bars) / 250.0, 2),
    }
