import os

import numpy as np
import pytest

from ranker import config as C
from ranker.engines import get_engine
from ranker.engines.bootstrap import BootstrapEngine, block_length
from ranker.panel import build_panel
from ranker.universe import (
    check_size,
    coverage,
    derive_fo_universe,
    load_sector_map,
    members_asof,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# --- sector map (parsed from the repo's existing universe file) --------------


def test_sector_map_parses_the_repo_universe():
    m = load_sector_map(REPO_ROOT)
    assert len(m) >= 150
    assert m["RELIANCE"] == ("Reliance Industries", "Energy & Oil")
    # Awkward rows the regex has to survive: an ampersand in the symbol and an
    # apostrophe inside a double-quoted display name.
    assert m["M&M"][1] == "Auto"
    assert m["DRREDDY"][0] == "Dr Reddy's"


def test_every_mapped_name_has_a_sector():
    # Mirrors the JS-side guarantee: an untagged name silently vanishes from its
    # peer group, and here it would vanish from sector-neutralisation.
    m = load_sector_map(REPO_ROOT)
    assert all(sector.strip() for _, sector in m.values())


# --- F&O universe derivation ------------------------------------------------


def _instruments():
    """A miniature Upstox instrument master."""
    rows = []
    for sym, isin in [("RELIANCE", "INE002A01018"), ("TCS", "INE467B01029"),
                      ("SBIN", "INE062A01020")]:
        rows.append({"segment": "NSE_EQ", "trading_symbol": sym,
                     "instrument_type": "EQ", "instrument_key": f"NSE_EQ|{isin}"})
        rows.append({"segment": "NSE_FO", "asset_symbol": sym, "instrument_type": "FUT",
                     "expiry": "2026-09-24", "instrument_key": f"NSE_FO|{sym}FUT",
                     "underlying_key": f"NSE_EQ|{isin}"})
    # An index future -- must never enter a single-stock cross-section.
    rows.append({"segment": "NSE_FO", "asset_symbol": "NIFTY", "instrument_type": "FUT",
                 "expiry": "2026-09-24", "instrument_key": "NSE_FO|NIFTYFUT"})
    # An expired stock future -- must be ignored.
    rows.append({"segment": "NSE_FO", "asset_symbol": "TCS", "instrument_type": "FUT",
                 "expiry": "2020-01-30", "instrument_key": "NSE_FO|TCSOLD"})
    # An option, not a future -- membership is derived from futures only.
    rows.append({"segment": "NSE_FO", "asset_symbol": "INFY", "instrument_type": "CE",
                 "expiry": "2026-09-24", "strike_price": 1500})
    return rows


def test_derive_universe_keeps_stocks_and_drops_indices():
    sectors = load_sector_map(REPO_ROOT)
    members = derive_fo_universe(_instruments(), "2026-08-11", sectors)
    syms = [m.symbol for m in members]
    assert syms == ["RELIANCE", "SBIN", "TCS"]
    assert "NIFTY" not in syms
    assert "INFY" not in syms       # option-only, no future
    assert all(m.equity_key.startswith("NSE_EQ|") for m in members)


def test_derive_universe_attaches_sectors():
    sectors = load_sector_map(REPO_ROOT)
    members = derive_fo_universe(_instruments(), "2026-08-11", sectors)
    assert {m.symbol: m.sector for m in members}["SBIN"] == "Banks"


def test_unmapped_name_is_kept_not_dropped():
    # Losing a name costs breadth, which is the edge. Tag it and report it.
    members = derive_fo_universe(_instruments(), "2026-08-11", {})
    assert len(members) == 3
    assert all(m.sector == "UNMAPPED" for m in members)


def test_check_size_rejects_an_implausible_universe():
    with pytest.raises(ValueError, match="outside the sane band"):
        check_size([])


# --- point-in-time membership ----------------------------------------------


def test_members_asof_uses_the_latest_snapshot_at_or_before_the_date():
    snaps = {"2025-01-01": {"A", "B"}, "2025-06-01": {"A", "B", "C"}}
    got, pit = members_asof(snaps, "2025-07-01", fallback=["Z"])
    assert got == ["A", "B", "C"] and pit is True
    got, pit = members_asof(snaps, "2025-03-01", fallback=["Z"])
    assert got == ["A", "B"] and pit is True


def test_members_asof_falls_back_and_says_so():
    got, pit = members_asof({"2025-06-01": {"A"}}, "2024-01-01", fallback=["Z"])
    assert got == ["Z"]
    # False is the survivorship-bias flag -- the caller must be able to count it.
    assert pit is False


def test_coverage_counts_the_biased_dates():
    cov = coverage({"2025-06-01": {"A"}}, ["2025-01-01", "2025-07-01", "2025-08-01"])
    assert cov["pointInTime"] == 2
    assert cov["fallback"] == 1


# --- bootstrap engine -------------------------------------------------------


def test_block_length_follows_the_horizon_within_bounds():
    assert block_length(21) == 7
    assert block_length(3) == C.BOOTSTRAP_BLOCK_BOUNDS[0]     # floored
    assert block_length(300) == C.BOOTSTRAP_BLOCK_BOUNDS[1]   # capped


def test_bootstrap_produces_a_usable_forecast(planted_panel):
    panel = planted_panel["panel"]
    series = {s: panel.bars[s] for s in panel.symbols[:6]}
    out = BootstrapEngine(paths=200).forecast(series, 21)

    assert set(out) == set(series)
    for f in out.values():
        assert np.isfinite(f.median_return)
        assert f.n_samples == 200
        assert f.quantiles["q05"] < f.quantiles["q50"] < f.quantiles["q95"]
        assert len(f.paths) == C.KEEP_SAMPLE_PATHS
        assert all(len(p) == 21 for p in f.paths)


def test_bootstrap_is_reproducible_but_not_identical_across_names(planted_panel):
    panel = planted_panel["panel"]
    series = {s: panel.bars[s] for s in panel.symbols[:4]}
    a = BootstrapEngine(paths=100).forecast(series, 21)
    b = BootstrapEngine(paths=100).forecast(series, 21)
    assert [a[s].median_return for s in series] == [b[s].median_return for s in series]
    # A shared draw across names would inject a spurious common factor straight
    # into a cross-sectional ranking.
    assert len({round(a[s].median_return, 9) for s in series}) > 1


def test_bootstrap_handles_a_too_short_series():
    from ranker.upstox import Bar

    bars = [Bar(t=f"2025-01-{i + 1:02d}", o=10, h=10, l=10, c=10, v=1) for i in range(5)]
    out = BootstrapEngine().forecast({"X": bars}, 21)
    assert np.isnan(out["X"].median_return)


# --- engine registry --------------------------------------------------------


def test_get_engine_resolves_the_bootstrap_without_torch():
    assert isinstance(get_engine("bootstrap"), BootstrapEngine)


def test_get_engine_rejects_an_unknown_name():
    with pytest.raises(ValueError, match="unknown engine"):
        get_engine("nope")


def test_importing_the_package_does_not_pull_in_torch():
    # The pure-math core must stay testable with no model stack present. If this
    # ever fails, an eager `import kronos` has crept into the package.
    import subprocess
    import sys

    code = "import sys, ranker, ranker.backtest, ranker.engines; assert 'torch' not in sys.modules"
    r = subprocess.run([sys.executable, "-c", code], capture_output=True,
                       cwd=os.path.join(REPO_ROOT, "nse-ranker"))
    assert r.returncode == 0, r.stderr.decode()
