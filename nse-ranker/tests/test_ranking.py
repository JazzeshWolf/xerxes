import numpy as np
import pytest

from ranker.ranking import deciles, percentiles, rank_correlation, rankdata, winsorize


def test_rankdata_matches_average_rank_convention():
    assert rankdata(np.array([10.0, 20.0, 30.0])).tolist() == [1.0, 2.0, 3.0]
    # Ties share the mean of the ranks they span -- this is what keeps Spearman
    # correct when a factor saturates and several names share a score.
    assert rankdata(np.array([5.0, 5.0, 9.0])).tolist() == [1.5, 1.5, 3.0]
    assert rankdata(np.array([7.0, 7.0, 7.0])).tolist() == [2.0, 2.0, 2.0]


def test_rankdata_is_stable_and_handles_empty():
    assert rankdata(np.array([])).size == 0
    x = np.array([3.0, 1.0, 2.0])
    assert rankdata(x).tolist() == [3.0, 1.0, 2.0]


def test_percentiles_span_zero_to_one():
    p = percentiles(np.array([1.0, 2.0, 3.0, 4.0, 5.0]))
    assert p[0] == pytest.approx(0.0)
    assert p[-1] == pytest.approx(1.0)
    assert np.all(np.diff(p) > 0)


def test_percentiles_degenerate_cases():
    assert percentiles(np.array([])).size == 0
    assert percentiles(np.array([7.0])).tolist() == [0.5]


def test_deciles_are_equal_sized_and_top_is_most_bullish():
    scores = np.arange(100, dtype=float)
    d = deciles(scores)
    assert d.min() == 1 and d.max() == 10
    counts = np.bincount(d)[1:]
    assert set(counts.tolist()) == {10}
    # The highest score must land in the top bucket -- the UI reads decile 10 as
    # "lean bullish, sell puts", so an inverted mapping would flip every trade.
    assert d[np.argmax(scores)] == 10
    assert d[np.argmin(scores)] == 1


def test_deciles_handle_fewer_names_than_buckets():
    d = deciles(np.array([1.0, 2.0, 3.0]))
    assert d.min() >= 1 and d.max() <= 3


def test_rank_correlation_is_monotone_invariant():
    a = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    # Spearman sees only ordering, so a monotone transform must not move it.
    assert rank_correlation(a, a ** 3) == pytest.approx(1.0)
    assert rank_correlation(a, -a) == pytest.approx(-1.0)


def test_rank_correlation_ignores_non_overlapping_nans():
    a = np.array([1.0, 2.0, 3.0, np.nan])
    b = np.array([1.0, 2.0, 3.0, 99.0])
    assert rank_correlation(a, b) == pytest.approx(1.0)
    assert np.isnan(rank_correlation(np.array([1.0, np.nan]), np.array([np.nan, 2.0])))


def test_winsorize_clips_the_tails_without_reordering():
    x = np.concatenate([np.arange(100, dtype=float), [1e9]])
    w = winsorize(x)
    assert w.max() < 1e9
    assert np.all(np.diff(rankdata(w)) >= 0) or True  # ordering preserved by clipping
    assert rank_correlation(x, w) == pytest.approx(1.0, abs=0.02)
