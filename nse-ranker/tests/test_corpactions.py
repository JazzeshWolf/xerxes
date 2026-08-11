import numpy as np

from ranker.corpactions import audit, back_adjust, clean, detect_actions
from ranker.upstox import Bar


def series(closes, volumes=None, start="2025-01-01"):
    """Build a bar series whose OHLC brackets each close tightly (a normal day)."""
    import datetime as dt

    d = dt.date.fromisoformat(start)
    out = []
    for i, c in enumerate(closes):
        v = volumes[i] if volumes else 100_000.0
        out.append(Bar(t=(d + dt.timedelta(days=i)).isoformat(),
                       o=c * 0.998, h=c * 1.005, l=c * 0.995, c=c, v=v))
    return out


def test_clean_series_yields_no_actions():
    bars = series([100 + i * 0.3 for i in range(60)])
    actions, _ = detect_actions(bars)
    assert actions == []


def test_detects_a_two_for_one_split():
    # 40 normal days, then the price halves and the WHOLE bar reprices, with the
    # share volume doubling -- the signature of a 2:1 split.
    closes = [200.0] * 40 + [100.0] * 20
    vols = [100_000.0] * 40 + [200_000.0] * 20
    bars = series(closes, vols)
    actions, _ = detect_actions(bars)
    assert len(actions) == 1
    assert actions[0].ratio == 0.5
    assert actions[0].kind == "split/bonus"
    assert actions[0].confidence == "high"


def test_a_genuine_crash_is_not_mistaken_for_a_split():
    # -33% close-to-close looks exactly like a 2:3 split on close alone, but the
    # day's HIGH is still up near the prior close, which is what a real crash
    # looks like. This is the false positive that would silently delete a real
    # return from the ranking.
    import datetime as dt

    d = dt.date.fromisoformat("2025-01-01")
    bars = [Bar(t=(d + dt.timedelta(days=i)).isoformat(),
                o=100.0, h=100.5, l=99.5, c=100.0, v=100_000.0) for i in range(40)]
    bars.append(Bar(t=(d + dt.timedelta(days=40)).isoformat(),
                    o=99.0, h=99.5, l=66.0, c=67.0, v=150_000.0))
    actions, rejected = detect_actions(bars)
    assert actions == []
    assert any(r["date"] == bars[-1].t for r in rejected)


def test_large_move_far_from_any_ratio_is_kept_as_a_real_return():
    closes = [100.0] * 30 + [70.0] * 10   # -30%: not near a split ratio
    bars = series(closes)
    actions, rejected = detect_actions(bars)
    assert actions == []
    assert rejected and "not near any split/bonus ratio" in rejected[0]["reason"]


def test_back_adjust_makes_the_series_continuous():
    closes = [200.0] * 40 + [100.0] * 20
    vols = [100_000.0] * 40 + [200_000.0] * 20
    bars = series(closes, vols)
    adjusted, info = clean(bars)

    assert info["adjusted"] is True
    prices = np.array([b.c for b in adjusted])
    rets = prices[1:] / prices[:-1] - 1.0
    # The fake -50% return is gone.
    assert np.abs(rets).max() < 0.01
    # The most recent price is untouched: the UI shows it beside a live quote.
    assert adjusted[-1].c == bars[-1].c
    # Pre-split volume is restated onto the new (larger) share count.
    assert adjusted[0].v > bars[0].v


def test_back_adjust_compounds_multiple_actions():
    # 2:1 then 5:1 -- the earliest bars must carry the product of both.
    closes = [1000.0] * 20 + [500.0] * 20 + [100.0] * 20
    vols = [100_000.0] * 20 + [200_000.0] * 20 + [1_000_000.0] * 20
    bars = series(closes, vols)
    actions, _ = detect_actions(bars)
    assert len(actions) == 2
    adjusted = back_adjust(bars, actions)
    assert adjusted[0].c == 100.0    # 1000 * 0.5 * 0.2
    assert adjusted[-1].c == 100.0


def test_detects_a_reverse_split():
    closes = [50.0] * 30 + [500.0] * 20   # 1:10 consolidation
    vols = [1_000_000.0] * 30 + [100_000.0] * 20
    bars = series(closes, vols)
    actions, _ = detect_actions(bars)
    assert len(actions) == 1
    assert actions[0].ratio == 10.0
    assert actions[0].kind == "consolidation"


def test_audit_reads_an_empty_result_as_an_adjusted_feed():
    per_symbol = {f"SYM{i}": {"actions": [], "rejected": [], "adjusted": False} for i in range(50)}
    out = audit(per_symbol)
    assert out["actionsDetected"] == 0
    assert "already" in out["verdict"] and "adjusted" in out["verdict"]


def test_audit_reads_a_dense_result_as_an_unadjusted_feed():
    per_symbol = {
        f"SYM{i}": {
            "actions": [{"date": "2025-01-01", "ratio": 0.5}] if i % 5 == 0 else [],
            "rejected": [],
            "adjusted": i % 5 == 0,
        }
        for i in range(50)
    }
    out = audit(per_symbol)
    assert out["actionsDetected"] == 10
    assert "UNADJUSTED" in out["verdict"]
