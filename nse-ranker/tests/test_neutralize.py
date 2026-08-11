import numpy as np
import pytest

from ranker.neutralize import (
    beta_neutralize,
    check,
    compute_betas,
    demean,
    neutralize,
    sector_neutralize,
    sector_r2,
)
from ranker.ranking import rank_correlation


def test_demean_removes_the_common_component():
    x = np.array([1.0, 2.0, 3.0])
    assert demean(x).mean() == pytest.approx(0.0)


def test_compute_betas_recovers_known_betas():
    rng = np.random.default_rng(0)
    market = rng.standard_normal(400) * 0.01
    true_betas = np.array([0.5, 1.0, 1.8])
    returns = np.array([b * market + rng.standard_normal(400) * 0.002 for b in true_betas])
    est = compute_betas(returns)
    # The equal-weight mean of three names is a noisy proxy for the true market,
    # so betas come back proportional rather than exact -- ordering is what the
    # neutralisation actually needs.
    assert np.argsort(est).tolist() == np.argsort(true_betas).tolist()


def test_compute_betas_fills_and_clips():
    rng = np.random.default_rng(1)
    returns = rng.standard_normal((5, 300)) * 0.01
    returns[3, :] = np.nan  # a name with no usable history
    betas = compute_betas(returns)
    assert np.isfinite(betas).all()
    assert betas.min() >= 0.0 and betas.max() <= 3.0


def test_beta_neutralize_annihilates_an_exactly_linear_beta_signal():
    # A ranking that IS beta -- the exact failure this module exists to catch.
    # Perfectly linear, so OLS explains all of it and the residual is numerically
    # zero. (`rank_correlation` then has no variance to work with and returns
    # NaN, which `diagnostics` reports as None -- i.e. "no beta loading left".)
    betas = np.linspace(0.4, 2.0, 60)
    residual = beta_neutralize(3.0 * betas, betas)
    assert np.abs(residual).max() < 1e-9


def test_beta_neutralize_kills_a_noisy_beta_signal():
    # The realistic version: mostly beta, plus idiosyncratic noise.
    rng = np.random.default_rng(11)
    betas = np.linspace(0.4, 2.0, 120)
    scores = 3.0 * betas + rng.standard_normal(120) * 0.15
    before = abs(rank_correlation(scores, betas))
    after = abs(rank_correlation(beta_neutralize(scores, betas), betas))
    assert before > 0.95
    assert after < 0.05


def test_beta_neutralize_preserves_an_orthogonal_signal():
    rng = np.random.default_rng(7)
    betas = rng.uniform(0.5, 1.8, 80)
    signal = rng.standard_normal(80)
    out = beta_neutralize(signal, betas)
    # Neutralisation must remove beta, not the alpha that sits beside it.
    assert rank_correlation(out, signal) > 0.9


def test_sector_neutralize_removes_a_pure_sector_bet():
    sectors = ["IT"] * 10 + ["Banks"] * 10 + ["Pharma"] * 10
    scores = np.array([5.0] * 10 + [0.0] * 10 + [-5.0] * 10)
    assert sector_r2(scores, sectors) > 0.95
    out = sector_neutralize(scores, sectors)
    assert sector_r2(out, sectors) < 1e-9


def test_small_sectors_are_pooled_not_deleted():
    # A one-name sector regressed on its own dummy would have its score zeroed --
    # deleting the name's signal instead of neutralising it.
    sectors = ["IT"] * 10 + ["Lonely"]
    scores = np.array([0.0] * 10 + [4.0])
    out = sector_neutralize(scores, sectors)
    assert out[-1] != 0.0


def test_full_pipeline_reports_before_and_after():
    rng = np.random.default_rng(3)
    n = 120
    betas = rng.uniform(0.5, 1.9, n)
    sectors = ["IT", "Banks", "Pharma", "Auto"] * (n // 4)
    effects = {"IT": 1.0, "Banks": -1.0, "Pharma": 0.5, "Auto": -0.5}
    sector_effect = np.array([effects[s] for s in sectors])
    raw = 2.0 * betas + sector_effect + rng.standard_normal(n) * 0.1

    out, diag = neutralize(raw, betas, sectors)

    # Beta dominates the raw score but the sector effect dilutes the rank
    # correlation, so "before" lands around 0.7 rather than near 1.
    assert abs(diag["before"]["betaRankCorr"]) > 0.6
    assert abs(diag["after"]["betaRankCorr"]) < 0.2
    assert diag["before"]["sectorR2"] > diag["after"]["sectorR2"]
    assert diag["passed"] is True


def test_check_fails_a_still_beta_loaded_ranking():
    assert check({"betaRankCorr": 0.9, "sectorR2": 0.0}) is False
    assert check({"betaRankCorr": 0.0, "sectorR2": 0.9}) is False
    assert check({"betaRankCorr": 0.05, "sectorR2": 0.02}) is True
