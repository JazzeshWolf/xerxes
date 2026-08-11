import math

import numpy as np
import pytest

from ranker import config as C
from ranker.config import CostModel
from ranker.costs import cost_drag, decile_weights, spread_returns, turnover
from ranker.ic import information_coefficient, summarize


# --- IC ---------------------------------------------------------------------


def test_ic_is_one_for_a_perfect_ranking():
    a = np.arange(50, dtype=float)
    assert information_coefficient(a, a * 2 + 1) == pytest.approx(1.0)


def test_summarize_computes_icir_and_tstat_consistently():
    ics = [0.05, 0.03, 0.07, 0.01, 0.04]
    out = summarize(ics)
    arr = np.array(ics)
    assert out["meanIC"] == pytest.approx(arr.mean(), abs=1e-4)
    # Sample sd (ddof=1): with 30-60 rebalances the population form would
    # flatter ICIR for no good reason.
    assert out["stdIC"] == pytest.approx(arr.std(ddof=1), abs=1e-4)
    assert out["icir"] == pytest.approx(arr.mean() / arr.std(ddof=1), abs=1e-3)
    assert out["tStat"] == pytest.approx(out["icir"] * math.sqrt(len(ics)), abs=1e-3)


def test_icir_punishes_dispersion():
    # Same mean IC, very different reliability -- the entire reason ICIR is the
    # headline number rather than mean IC.
    steady = summarize([0.04, 0.04, 0.05, 0.03, 0.04])
    wild = summarize([0.30, -0.25, 0.22, -0.19, 0.12])
    assert steady["meanIC"] == pytest.approx(wild["meanIC"], abs=0.02)
    assert steady["icir"] > wild["icir"] * 3


def test_summarize_refuses_to_judge_a_tiny_sample():
    out = summarize([0.05])
    assert out["icir"] is None
    assert "too few" in out["note"]


def test_summarize_flags_overlapping_windows():
    out = summarize([0.05, 0.04, 0.06], overlapping=True)
    assert out["overlapping"] is True
    assert "inflated" in out["note"]


def test_summarize_reports_hit_rate():
    assert summarize([0.1, 0.1, -0.1, 0.1])["hitRate"] == pytest.approx(0.75)


# --- costs ------------------------------------------------------------------


def test_round_trip_cost_totals_the_components():
    m = CostModel()
    taxed = m.brokerage_bps + m.exchange_bps + m.sebi_bps
    expected = (m.brokerage_bps + m.stt_bps + m.exchange_bps + m.sebi_bps
                + m.stamp_bps + taxed * m.gst_rate + m.impact_bps)
    assert m.round_trip_bps() == pytest.approx(expected)


def test_impact_is_a_large_share_of_total_cost():
    # The term people forget. If this ever stops being material, the model has
    # drifted away from reality rather than the market having got cheaper.
    m = CostModel()
    assert m.impact_bps / m.round_trip_bps() > 0.3


def test_turnover_is_zero_for_an_unchanged_book_and_one_for_a_full_swap():
    book = {"A": 0.5, "B": -0.5}
    assert turnover(book, book) == pytest.approx(0.0)
    assert turnover({"A": 0.5, "B": -0.5}, {"C": 0.5, "D": -0.5}) == pytest.approx(1.0)


def test_establishing_a_book_costs_half_a_full_swap():
    # Under the sum|dw|/2 convention, replacing a book trades 2.0 gross and
    # scores 1.0; establishing one from flat trades 1.0 gross and scores 0.5.
    # This is why the first rebalance of a backtest is not double-charged.
    assert turnover({}, {"A": 0.5, "B": -0.5}) == pytest.approx(0.5)


def test_cost_drag_scales_with_turnover():
    assert cost_drag(0.0) == 0.0
    assert cost_drag(1.0) == pytest.approx(C.COSTS.round_trip_bps() / 10_000.0)
    assert cost_drag(0.5) == pytest.approx(cost_drag(1.0) / 2)


def test_decile_weights_are_long_top_short_bottom_and_balanced():
    deciles = np.array([1, 1, 5, 10, 10])
    symbols = ["a", "b", "c", "d", "e"]
    w = decile_weights(deciles, symbols)
    assert w["d"] > 0 and w["e"] > 0
    assert w["a"] < 0 and w["b"] < 0
    assert "c" not in w
    assert sum(w.values()) == pytest.approx(0.0)          # market neutral
    assert sum(abs(v) for v in w.values()) == pytest.approx(1.0)  # gross book 1.0


def test_spread_returns_nets_costs_and_reports_sensitivity():
    legs = [{"date": f"d{i}", "topReturn": 0.02, "bottomReturn": -0.01, "turnover": 0.5}
            for i in range(12)]
    out = spread_returns(legs)
    assert out["meanGrossPerRebalance"] == pytest.approx(0.03)
    assert out["net"]["meanNetPerRebalance"] < 0.03
    assert len(out["impactSensitivity"]) == len(C.IMPACT_SENSITIVITY_BPS)
    nets = [x["meanNetPerRebalance"] for x in out["impactSensitivity"]]
    assert nets == sorted(nets, reverse=True)


def test_spread_returns_handles_no_rebalances():
    assert spread_returns([])["n"] == 0
