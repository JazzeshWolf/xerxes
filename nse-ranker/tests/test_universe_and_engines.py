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


# --- Kronos batch planning ---------------------------------------------------
#
# `predict_batch` refuses a batch whose series differ in length. MIN_BARS (260)
# admits names with far fewer bars than MAX_CONTEXT (512), so on the first live
# Kronos run four of seven batches each caught a short name and the engine NaN'd
# all 32 of their members -- 114 of 210 names silently vanished from the
# ranking, RELIANCE, TCS and INFY among them. Breadth is the edge, so this is
# the invariant that matters most about batching.


def _plan(lengths, batch_size=32, max_context=512):
    from ranker.engines.kronos import plan_batches

    return plan_batches(lengths, batch_size, max_context)


def test_every_batch_has_one_consistent_length():
    # The production shape: mostly full-context names, a handful short.
    lengths = {f"S{i:03d}": 512 for i in range(210)}
    for sym, n in zip(("S007", "S042", "S100", "S150", "S201"),
                      (338, 469, 503, 454, 430)):
        lengths[sym] = n

    for chunk, ctx in _plan(lengths):
        assert ctx == min(min(lengths[s], 512) for s in chunk)
        assert ctx > 0


def test_no_name_is_dropped_by_batching():
    lengths = {f"S{i:03d}": 512 for i in range(210)}
    lengths["S007"] = 338
    lengths["S042"] = 469

    planned = [s for chunk, _ in _plan(lengths) for s in chunk]
    assert sorted(planned) == sorted(lengths), "breadth is the edge -- lose no name"
    assert len(planned) == len(set(planned)), "no name forecast twice"


def test_a_short_name_does_not_truncate_the_full_length_ones():
    # The regression that matters: one 338-bar name must not drag the whole
    # universe down to 338 bars of context.
    lengths = {f"S{i:03d}": 512 for i in range(210)}
    lengths["S007"] = 338

    plan = _plan(lengths)
    full = [ctx for _, ctx in plan if ctx == 512]
    assert len(full) >= len(plan) - 1, "only the batch holding the short name loses context"
    assert sum(len(c) for c, ctx in plan if ctx == 512) >= 209 - 32


def test_context_is_capped_at_max_context():
    # A name with 6 years of history still only feeds the model its window.
    lengths = {"A": 1500, "B": 1500, "C": 900}
    assert all(ctx <= 512 for _, ctx in _plan(lengths))


def test_batches_respect_the_size_limit():
    lengths = {f"S{i:03d}": 512 for i in range(210)}
    assert all(len(c) <= 32 for c, _ in _plan(lengths))


# --- the momentum engine -----------------------------------------------------
#
# The ranker runs on 12-1 momentum, and the backtest scores it against a
# `momentum_12_1` BENCHMARK arm. If the engine computed the factor its own way
# the two could disagree, and the measured ICIR would then describe something
# other than what the daily job ships.
#
# The trap that makes this non-obvious: `Panel.bars_upto` filters by DATE and
# then slices, while the panel's date axis is the union of every symbol's dates.
# For a name that halted for a few sessions, `bars[-22]` is NOT
# `panel.closes[:, i - 21]` -- so the tempting `closes[-22] / closes[-253] - 1`
# is quietly wrong for exactly the gappy names. Hence the engine delegates to the
# benchmark rather than reimplementing it, and hence this test uses a panel that
# CONTAINS a gap: without one it would pass either way and prove nothing.


def _walk(dates, s0, seed):
    from ranker.upstox import Bar

    rng = np.random.default_rng(seed)
    px, out = s0, []
    for t in dates:
        px *= float(np.exp(rng.normal(0.0004, 0.012)))
        out.append(Bar(t=t, o=px, h=px * 1.01, l=px * 0.99, c=px, v=1000.0))
    return out


@pytest.fixture(scope="module")
def gappy_panel():
    from ranker.panel import build_panel

    dates = [f"2024-{1 + d // 28:02d}-{1 + d % 28:02d}" for d in range(400)]
    bars = {"DENSE1": _walk(dates, 100.0, 1), "DENSE2": _walk(dates, 250.0, 2)}
    # Halts for ten sessions, inside the 12-1 lookback window.
    bars["GAPPY"] = _walk([d for k, d in enumerate(dates) if not (300 <= k < 310)], 80.0, 3)
    return build_panel(bars)


def test_momentum_engine_matches_its_own_benchmark_exactly(gappy_panel):
    from ranker.benchmarks import momentum_12_1

    i = gappy_panel.n_dates - 1
    bench = momentum_12_1(gappy_panel, i)
    got = get_engine("momentum").forecast_panel(gappy_panel, i, 21)

    for k, sym in enumerate(gappy_panel.symbols):
        assert sym in got, f"{sym} dropped"
        assert got[sym].median_return == pytest.approx(float(bench[k]), abs=1e-12), sym


def test_a_bar_indexed_momentum_would_have_diverged(gappy_panel):
    # Pins the REASON for the delegation. If this ever stops diverging the panel
    # fixture has lost its gap and the test above is no longer proving anything.
    from ranker.benchmarks import momentum_12_1

    i = gappy_panel.n_dates - 1
    bench = dict(zip(gappy_panel.symbols, momentum_12_1(gappy_panel, i)))
    closes = [b.c for b in gappy_panel.bars["GAPPY"]]
    naive = closes[-1 - C.MOMENTUM_SKIP] / closes[-1 - C.MOMENTUM_LOOKBACK] - 1.0
    assert abs(naive - float(bench["GAPPY"])) > 1e-6, (
        "the gapped symbol no longer exposes the bar-vs-panel misalignment"
    )


def test_momentum_engine_declares_itself_a_factor():
    # The UI reads this to avoid printing a trailing 12-month return under a
    # heading that says "Forecast".
    e = get_engine("momentum")
    assert e.uses_panel is True
    assert e.signal_kind == "factor"
    assert get_engine("bootstrap").uses_panel is False
    assert get_engine("bootstrap").signal_kind == "forecastReturn"


def test_momentum_engine_refuses_the_bar_interface():
    # Calling `forecast` would silently give the wrong answer for gappy names,
    # so it must raise rather than quietly compute something plausible.
    with pytest.raises(NotImplementedError, match="Panel"):
        get_engine("momentum").forecast({}, 21)


def test_momentum_engine_drops_names_with_no_usable_close(gappy_panel):
    # `_write` serialises with allow_nan=False, so a NaN close would blow up only
    # after a full run. Names without one must never reach the payload.
    i = gappy_panel.n_dates - 1
    for f in get_engine("momentum").forecast_panel(gappy_panel, i, 21).values():
        assert np.isfinite(f.median_return) and np.isfinite(f.last_close)
        assert f.last_close > 0
