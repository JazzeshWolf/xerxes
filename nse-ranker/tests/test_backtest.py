"""
Meta-validation: does the harness measure skill correctly?

Every number this service publishes comes out of `walk_forward`. If that
function can be fooled, the scorecard is decoration. So these tests check the
harness against data whose answer is known in advance:

* given a signal that provably predicts, it must report a high IC;
* given noise, it must report ICIR near zero -- a harness that manufactures
  skill from random input would validate anything;
* it must never touch a bar the trader would not have had.

The third is the one that silently destroys backtests, so it is tested
structurally against the panel accessors rather than inferred from a result.
"""

from __future__ import annotations

import numpy as np
import pytest

from ranker import config as C
from ranker.backtest import rebalance_dates, verdict, walk_forward
from ranker.engines.base import Engine, Forecast


class TrailingReturnEngine(Engine):
    """Forecasts the trailing 21-day return -- the planted signal, observable."""

    name = "trailing"

    def forecast(self, series, pred_len):
        out = {}
        for sym, bars in series.items():
            closes = self._closes(bars)
            r = closes[-1] / closes[-22] - 1.0 if closes.size > 22 else float("nan")
            out[sym] = Forecast(symbol=sym, median_return=float(r),
                                last_close=float(closes[-1]), engine=self.name)
        return out


class NoiseEngine(Engine):
    """Forecasts pure noise. Must produce no measurable skill."""

    name = "noise"

    def __init__(self, seed: int = 0):
        self.rng = np.random.default_rng(seed)

    def forecast(self, series, pred_len):
        return {
            s: Forecast(symbol=s, median_return=float(self.rng.standard_normal()),
                        last_close=float(b[-1].c), engine=self.name)
            for s, b in series.items()
        }


# ---------------------------------------------------------------------------
# No lookahead -- structural
# ---------------------------------------------------------------------------


def test_bars_upto_never_returns_a_future_bar(planted_panel):
    panel = planted_panel["panel"]
    for i in (300, 600, 900):
        cutoff = panel.dates[i]
        for sym in panel.symbols[:5]:
            got = panel.bars_upto(sym, i, C.LOOKBACK_BARS)
            assert got, "window should not be empty"
            assert max(b.t for b in got) <= cutoff


def test_window_and_forward_return_do_not_overlap(planted_panel):
    panel = planted_panel["panel"]
    i, h = 500, 21
    w = panel.window(i, 50)
    assert w.shape[1] == 50
    # The forward return is measured from i to i+h, strictly after the window.
    expected = panel.closes[:, i + h] / panel.closes[:, i] - 1.0
    np.testing.assert_allclose(panel.forward_return(i, h), expected, equal_nan=True)


def test_forward_return_is_nan_past_the_end(planted_panel):
    panel = planted_panel["panel"]
    assert np.isnan(panel.forward_return(panel.n_dates - 2, 21)).all()


def test_rebalance_dates_leave_a_full_horizon_ahead(planted_panel):
    panel = planted_panel["panel"]
    idxs = rebalance_dates(panel, 21, 21, C.MIN_BARS)
    assert idxs
    assert min(idxs) >= max(C.MIN_BARS, C.BETA_WINDOW)
    assert max(idxs) + 21 < panel.n_dates


# ---------------------------------------------------------------------------
# Does it find real skill, and only real skill?
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def signal_run(planted_panel):
    return walk_forward(
        planted_panel["panel"], planted_panel["sector_of"], TrailingReturnEngine(),
        pred_len=21, lookback=C.LOOKBACK_BARS, every=21, progress=False,
    )


@pytest.fixture(scope="module")
def noise_run(planted_panel):
    return walk_forward(
        planted_panel["panel"], planted_panel["sector_of"], NoiseEngine(seed=5),
        pred_len=21, lookback=C.LOOKBACK_BARS, every=21, progress=False,
    )


def test_harness_detects_a_planted_signal(signal_run):
    ic = signal_run["arms"]["engine"]["ic"]
    assert ic["n"] >= 20
    assert ic["meanIC"] > 0.10, "a provably predictive signal must score a positive IC"
    assert ic["icir"] > 0.5


def test_harness_reports_no_skill_for_noise(noise_run):
    ic = noise_run["arms"]["engine"]["ic"]
    # The decisive test: a harness that finds skill in noise would validate
    # anything put through it.
    assert abs(ic["meanIC"]) < 0.05
    assert abs(ic["icir"]) < 0.5


def test_random_benchmark_is_flat_in_both_runs(signal_run, noise_run):
    for run in (signal_run, noise_run):
        rnd = run["arms"]["random"]["ic"]
        assert abs(rnd["meanIC"]) < 0.05


def test_signal_beats_random_on_decile_spread(signal_run):
    eng = signal_run["arms"]["engine"]["spread"]
    rnd = signal_run["arms"]["random"]["spread"]
    assert eng["meanGrossPerRebalance"] > rnd["meanGrossPerRebalance"]


def test_costs_reduce_the_net_spread(signal_run):
    sp = signal_run["arms"]["engine"]["spread"]
    assert sp["net"]["meanNetPerRebalance"] < sp["meanGrossPerRebalance"]
    assert sp["costDragPerRebalance"] > 0
    # Higher impact must always hurt more -- the sensitivity table is the
    # honesty check on the softest input in the cost model.
    nets = [x["meanNetPerRebalance"] for x in sp["impactSensitivity"]]
    assert nets == sorted(nets, reverse=True)


def test_neutralization_diagnostics_are_reported(signal_run):
    nz = signal_run["neutralization"]
    assert nz["after"]["betaRankCorr"] is not None
    assert abs(nz["after"]["betaRankCorr"]) <= C.MAX_BETA_CORR_AFTER
    assert nz["after"]["sectorR2"] <= C.MAX_SECTOR_R2_AFTER


def test_ic_series_is_marked_non_overlapping(signal_run):
    assert signal_run["overlapping"] is False
    assert signal_run["arms"]["engine"]["ic"]["overlapping"] is False


def test_overlapping_rebalances_are_flagged_as_inflated(planted_panel):
    run = walk_forward(
        planted_panel["panel"], planted_panel["sector_of"], TrailingReturnEngine(),
        pred_len=21, every=5, progress=False,
    )
    assert run["overlapping"] is True
    assert run["arms"]["engine"]["ic"]["overlapping"] is True
    assert "inflated" in run["arms"]["engine"]["ic"]["note"]
    assert verdict(run)["validated"] is False


# ---------------------------------------------------------------------------
# The gate the UI reads
# ---------------------------------------------------------------------------


def test_verdict_rejects_a_noise_engine(noise_run):
    v = verdict(noise_run)
    assert v["validated"] is False
    assert v["reasons"]
    assert v["summary"].startswith("UNVALIDATED")


def test_verdict_requires_beating_momentum():
    # A model that ties momentum has bought nothing for its pre-training.
    fake = {
        "overlapping": False,
        "neutralization": {"verdict": "Neutralisation is working: ..."},
        "arms": {
            "engine": {"ic": {"icir": 0.60, "n": 40}},
            "momentum_12_1": {"ic": {"icir": 0.58, "n": 40}},
        },
    }
    v = verdict(fake)
    assert v["validated"] is False
    assert any("momentum" in r for r in v["reasons"])


def test_verdict_passes_a_genuinely_better_model():
    fake = {
        "overlapping": False,
        "neutralization": {"verdict": "Neutralisation is working: ..."},
        "arms": {
            "engine": {"ic": {"icir": 0.75, "n": 40}},
            "momentum_12_1": {"ic": {"icir": 0.30, "n": 40}},
        },
    }
    v = verdict(fake)
    assert v["validated"] is True
    assert v["edgeOverMomentum"] == pytest.approx(0.45)


def test_verdict_requires_enough_rebalances():
    fake = {
        "overlapping": False,
        "neutralization": {"verdict": "Neutralisation is working: ..."},
        "arms": {
            "engine": {"ic": {"icir": 0.9, "n": 5}},
            "momentum_12_1": {"ic": {"icir": 0.1, "n": 5}},
        },
    }
    assert verdict(fake)["validated"] is False
