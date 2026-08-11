"""
Universe construction: which NSE F&O single stocks exist on a given date, and
what sector each belongs to.

Two sources, deliberately different in kind:

* **Membership** is derived live from the Upstox NFO instrument master (futures
  contracts -> underlying equities). It changes as SEBI/NSE revise the F&O list.
* **Sector** is read from the repo's existing `scripts/stocks-universe.mjs`,
  which is the single source of truth for the trading grouping the rest of the
  app already uses. Parsed, never duplicated.

## Survivorship bias, stated plainly

Using *today's* F&O list for a backtest of 2023 is survivorship bias: names
added since then were added partly because they did well, and names dropped are
missing entirely. The honest fix is a point-in-time snapshot per date, which is
what `save_snapshot` accumulates -- but snapshots can only be recorded going
forward. On day one there is no history of them, so the backtest falls back to
the current list and `coverage()` reports exactly how many rebalance dates were
served by a real snapshot versus the fallback. That number belongs in the report
rather than in a footnote nobody reads.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from . import config as C

# Index underlyings also have NFO futures; they are not single stocks and must
# never enter a cross-sectional stock ranking.
INDEX_UNDERLYINGS = frozenset(
    {
        "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50",
        "NIFTYIT", "NIFTYINFRA", "SENSEX", "BANKEX", "SENSEX50",
    }
)

# Matches a  ["SYM", "Display Name", "Sector"],  row. The file uses double
# quotes throughout with no escaped quotes inside (apostrophes such as
# "Divi's Labs" are fine, and "M&M" carries an ampersand), so a non-greedy
# [^"]* per field is exact rather than merely convenient.
_ROW_RE = re.compile(r'\[\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\]')


@dataclass(frozen=True)
class Member:
    symbol: str          # NSE trading symbol == Upstox asset_symbol on NSE_FO
    name: str            # display name
    sector: str
    equity_key: str | None = None   # Upstox NSE_EQ instrument_key


def load_sector_map(repo_root: str) -> dict[str, tuple[str, str]]:
    """Parse `scripts/stocks-universe.mjs` -> {SYMBOL: (display name, sector)}.

    Raises if the parse yields an implausible number of rows: a silent partial
    parse would drop names from their sector group, and an unsectored name is
    invisible to sector-neutralisation rather than obviously broken.
    """
    path = os.path.join(repo_root, C.SECTORS_SOURCE)
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    out: dict[str, tuple[str, str]] = {}
    for sym, name, sector in _ROW_RE.findall(src):
        if not sym or not sector:
            continue
        out[sym.upper()] = (name, sector)
    if len(out) < 50:
        raise ValueError(
            f"{C.SECTORS_SOURCE}: parsed only {len(out)} rows -- the file format "
            "changed and the sector map would be silently incomplete."
        )
    return out


def derive_fo_universe(
    instruments: list[dict],
    today_iso: str,
    sector_map: dict[str, tuple[str, str]],
) -> list[Member]:
    """NSE F&O single-stock underlyings with a live futures contract.

    `instruments` is the raw Upstox instrument master (list of dicts). We take
    every NSE_FO *futures* row whose expiry has not passed, map it to its
    underlying, and keep those that resolve to a cash-equity instrument.

    Names present in F&O but missing from the sector map are kept and tagged
    UNMAPPED rather than dropped -- losing a name from the ranking is worse than
    carrying it in a catch-all sector, and the count is reported so the map can
    be refreshed.
    """
    fo_symbols: dict[str, str | None] = {}
    for r in instruments:
        seg = str(r.get("segment") or "").upper()
        if seg != "NSE_FO":
            continue
        itype = str(r.get("instrument_type") or r.get("instrumentType") or "").upper()
        if "FUT" not in itype:
            continue
        expiry = _expiry_iso(r.get("expiry"))
        if expiry is not None and expiry < today_iso:
            continue
        sym = str(r.get("asset_symbol") or r.get("assetSymbol") or r.get("name") or "").upper()
        if not sym or sym in INDEX_UNDERLYINGS:
            continue
        ukey = r.get("underlying_key") or r.get("underlyingKey")
        # First writer wins, but a row carrying an underlying key beats one without.
        if sym not in fo_symbols or (fo_symbols[sym] is None and ukey):
            fo_symbols[sym] = ukey

    # Confirm each underlying against the cash segment, so a stale or malformed
    # NFO row cannot invent a stock that has no equity to fetch history for.
    eq_keys = _equity_keys(instruments)

    members: list[Member] = []
    for sym, ukey in sorted(fo_symbols.items()):
        key = eq_keys.get(sym) or (ukey if _looks_like_equity_key(ukey) else None)
        if key is None:
            continue
        name, sector = sector_map.get(sym, (sym, "UNMAPPED"))
        members.append(Member(symbol=sym, name=name, sector=sector, equity_key=key))
    return members


def _looks_like_equity_key(key) -> bool:
    return isinstance(key, str) and key.upper().startswith("NSE_EQ")


def _equity_keys(instruments: list[dict]) -> dict[str, str]:
    """{TRADING_SYMBOL: instrument_key} for NSE cash equities.

    Mirrors `pickEquityKeys` in scripts/upstox.mjs, including its tolerance for
    an empty instrument_type on some rows.
    """
    out: dict[str, str] = {}
    for r in instruments:
        if str(r.get("segment") or "").upper() != "NSE_EQ":
            continue
        ts = str(r.get("trading_symbol") or r.get("tradingsymbol") or "").upper()
        itype = str(r.get("instrument_type") or r.get("instrumentType") or "").upper()
        if not ts or ts in out:
            continue
        if itype in ("EQ", ""):
            key = r.get("instrument_key") or r.get("instrumentKey")
            if key:
                out[ts] = key
    return out


def _expiry_iso(e) -> str | None:
    """Upstox expiries arrive as epoch millis or an ISO-ish string."""
    if e is None:
        return None
    if isinstance(e, (int, float)):
        import datetime as _dt

        return _dt.datetime.utcfromtimestamp(float(e) / 1000.0).strftime("%Y-%m-%d")
    s = str(e)
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    try:
        import datetime as _dt

        return _dt.datetime.utcfromtimestamp(float(s) / 1000.0).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def check_size(members: list[Member]) -> None:
    """Fail loudly on an implausible universe rather than ranking a broken one."""
    n = len(members)
    if not (C.UNIVERSE_MIN <= n <= C.UNIVERSE_MAX):
        raise ValueError(
            f"derived F&O universe has {n} names, outside the sane band "
            f"[{C.UNIVERSE_MIN}, {C.UNIVERSE_MAX}] -- the instrument-master parse "
            "is probably broken. Refusing to rank."
        )


# ---------------------------------------------------------------------------
# Point-in-time snapshots
# ---------------------------------------------------------------------------


def save_snapshot(dir_path: str, date_iso: str, members: list[Member]) -> str:
    """Record the universe as it stood on `date_iso`.

    Append-only by design: an existing snapshot is never overwritten, because
    rewriting history is precisely the bias this file exists to avoid.
    """
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, f"{date_iso}.json")
    if os.path.exists(path):
        return path
    payload = {
        "date": date_iso,
        "count": len(members),
        "members": [
            {"symbol": m.symbol, "sector": m.sector, "equityKey": m.equity_key}
            for m in members
        ],
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"), sort_keys=True)
    return path


def load_snapshots(dir_path: str) -> dict[str, set[str]]:
    """{date_iso: {symbols}} for every recorded snapshot."""
    out: dict[str, set[str]] = {}
    if not os.path.isdir(dir_path):
        return out
    for fn in sorted(os.listdir(dir_path)):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(dir_path, fn), "r", encoding="utf-8") as fh:
            try:
                payload = json.load(fh)
            except json.JSONDecodeError:
                continue
        date = payload.get("date") or fn[:-5]
        out[date] = {m["symbol"] for m in payload.get("members", []) if m.get("symbol")}
    return out


def members_asof(
    snapshots: dict[str, set[str]], date_iso: str, fallback: list[str]
) -> tuple[list[str], bool]:
    """Universe as of `date_iso`: the latest snapshot at or before it.

    Returns (symbols, point_in_time). `point_in_time` False means the caller got
    `fallback` -- today's list standing in for a past date, i.e. survivorship
    bias on that date. Callers are expected to count these, not ignore them.
    """
    usable = [d for d in snapshots if d <= date_iso]
    if not usable:
        return list(fallback), False
    return sorted(snapshots[max(usable)]), True


def coverage(snapshots: dict[str, set[str]], dates: list[str]) -> dict:
    """How much of a backtest ran on real point-in-time membership."""
    pit = sum(1 for d in dates if any(s <= d for s in snapshots))
    return {
        "rebalances": len(dates),
        "pointInTime": pit,
        "fallback": len(dates) - pit,
        "snapshots": len(snapshots),
        "note": (
            "Dates served by `fallback` used the current F&O list and therefore "
            "carry survivorship bias. Snapshots accumulate going forward."
        ),
    }
