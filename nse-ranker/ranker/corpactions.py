"""
Corporate-action detection and back-adjustment.

Indian equities split and issue bonuses frequently. On an unadjusted feed a 2:1
split shows up as a clean -50% day, and in a *cross-sectional* ranker that is
catastrophic in a specific way: it does not add noise, it adds a huge fake
negative return that lands the name in the bottom decile with total confidence.
A handful of these per rebalance would dominate the ranking outright. This is
the failure the build spec singles out, and it is silent -- the numbers all look
like numbers.

## The detection problem, honestly stated

Close-to-close alone cannot separate a 2:3 split from a genuine -33% session.
Both print the same ratio. So detection uses three pieces of evidence:

1. **Ratio proximity** -- the move lands near a round corporate-action ratio.
2. **Whole-bar repricing** -- on a split the entire bar (open/high/low) sits at
   the new level, because there is no old-price trading after the ex-date. In a
   crash the high is usually still up near the previous close. This is the
   discriminator that does most of the work.
3. **Volume expansion** -- share count rises by the split factor, so traded
   share volume jumps even though traded *value* does not.

Ratios far outside any plausible session (halving, thirding, 10x) are accepted
on ratio + whole-bar evidence. Ratios a real move could imitate (2:3, 3:4, 5:6)
additionally require volume corroboration. Every decision, accepted or rejected,
is returned for the report -- a silent correction is as dangerous as a silent
miss, and this module refuses to make either invisible.

## If the feed is already adjusted

Then detection finds ~nothing, and that near-zero count is itself the evidence
that Upstox adjusts. `audit()` reports the count and its interpretation so the
question "are these candles adjusted?" is answered by measurement on the runner
rather than by assumption in a sandbox that cannot reach the API.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from statistics import median

from . import config as C
from .upstox import Bar


@dataclass(frozen=True)
class Action:
    """A detected corporate action on an ex-date.

    `ratio` is the PRICE multiplier: 0.5 for a 2:1 split (price halves), 2.0 for
    a 1:2 consolidation. Back-adjustment multiplies every earlier bar by it.
    """

    date: str
    ratio: float
    observed: float
    kind: str            # "split/bonus" | "consolidation"
    confidence: str      # "high" | "medium"
    volume_ratio: float | None
    whole_bar: bool

    def as_dict(self) -> dict:
        return asdict(self)


def _nearest_ratio(observed: float) -> float | None:
    best, best_err = None, None
    for r in C.CA_RATIOS:
        err = abs(observed / r - 1.0)
        if err <= C.CA_RATIO_TOLERANCE and (best_err is None or err < best_err):
            best, best_err = r, err
    return best


def _is_ambiguous(ratio: float) -> bool:
    return any(abs(ratio - a) < 1e-9 for a in C.CA_AMBIGUOUS_RATIOS)


def detect_actions(bars: list[Bar]) -> tuple[list[Action], list[dict]]:
    """Scan a daily series for corporate actions.

    Returns (accepted actions, rejected candidates). Rejections are kept because
    "we saw a -31% day and decided it was real" is exactly the judgement an
    operator needs to be able to audit later.
    """
    accepted: list[Action] = []
    rejected: list[dict] = []
    if len(bars) < 3:
        return accepted, rejected

    for i in range(1, len(bars)):
        prev, cur = bars[i - 1], bars[i]
        observed = cur.c / prev.c
        if abs(observed - 1.0) < C.CA_SUSPECT_RETURN:
            continue

        ratio = _nearest_ratio(observed)
        if ratio is None:
            rejected.append(
                {
                    "date": cur.t,
                    "observed": round(observed, 4),
                    "reason": "large move, but not near any split/bonus ratio "
                              "-- treated as a real return",
                }
            )
            continue

        # Whole-bar repricing: on a down-split the day's HIGH is already at the
        # new level; on a consolidation the LOW is already at the new level.
        slack = C.CA_RATIO_TOLERANCE * C.CA_RANGE_SLACK
        if ratio < 1.0:
            whole_bar = (cur.h / prev.c) <= ratio * (1.0 + slack)
        else:
            whole_bar = (cur.l / prev.c) >= ratio * (1.0 - slack)

        # Volume corroboration against the preceding month's median.
        window = [b.v for b in bars[max(0, i - 21): i] if b.v > 0]
        vol_ratio = (cur.v / median(window)) if window and cur.v > 0 else None
        vol_ok = vol_ratio is not None and vol_ratio >= C.CA_VOLUME_CONFIRM

        if _is_ambiguous(ratio):
            # A real session could print this ratio -- demand corroboration.
            if not (whole_bar and vol_ok):
                rejected.append(
                    {
                        "date": cur.t,
                        "observed": round(observed, 4),
                        "nearestRatio": round(ratio, 4),
                        "wholeBar": whole_bar,
                        "volumeRatio": round(vol_ratio, 2) if vol_ratio else None,
                        "reason": "ratio is imitable by a real move and lacks "
                                  "whole-bar + volume corroboration",
                    }
                )
                continue
            confidence = "medium"
        else:
            if not whole_bar:
                rejected.append(
                    {
                        "date": cur.t,
                        "observed": round(observed, 4),
                        "nearestRatio": round(ratio, 4),
                        "wholeBar": False,
                        "reason": "close matched a split ratio but the bar did "
                                  "not fully reprice -- looks like a real move",
                    }
                )
                continue
            confidence = "high" if vol_ok else "medium"

        accepted.append(
            Action(
                date=cur.t,
                ratio=ratio,
                observed=round(observed, 6),
                kind="split/bonus" if ratio < 1.0 else "consolidation",
                confidence=confidence,
                volume_ratio=round(vol_ratio, 2) if vol_ratio is not None else None,
                whole_bar=whole_bar,
            )
        )

    return accepted, rejected


def back_adjust(bars: list[Bar], actions: list[Action]) -> list[Bar]:
    """Rewrite pre-ex-date bars onto the post-action price basis.

    Standard back-adjustment: every bar strictly before an ex-date is multiplied
    by that action's price ratio (and its volume divided by it, since share
    count moves the other way). Multiple actions compound. The most recent price
    is left untouched, so the series still ends at the real market price -- which
    matters because the UI shows it next to a live quote.
    """
    if not actions:
        return list(bars)

    by_date = {a.date: a.ratio for a in actions}
    out: list[Bar] = []
    # Walk backwards accumulating the factor, so each bar carries the product of
    # every action that happened after it.
    factor = 1.0
    for bar in reversed(bars):
        if bar.t in by_date:
            # The ex-date bar itself is already on the new basis; everything
            # before it needs the adjustment.
            out.append(
                Bar(t=bar.t, o=bar.o * factor, h=bar.h * factor, l=bar.l * factor,
                    c=bar.c * factor, v=bar.v / factor if factor else bar.v)
            )
            factor *= by_date[bar.t]
            continue
        out.append(
            Bar(t=bar.t, o=bar.o * factor, h=bar.h * factor, l=bar.l * factor,
                c=bar.c * factor, v=bar.v / factor if factor else bar.v)
        )
    out.reverse()
    return out


def clean(bars: list[Bar]) -> tuple[list[Bar], dict]:
    """Detect, adjust, and hand back an auditable record of what was done."""
    actions, rejected = detect_actions(bars)
    adjusted = back_adjust(bars, actions)
    return adjusted, {
        "actions": [a.as_dict() for a in actions],
        "rejected": rejected,
        "adjusted": bool(actions),
    }


def audit(per_symbol: dict[str, dict]) -> dict:
    """Universe-level read on whether the feed appears adjusted.

    `per_symbol` is {symbol: the dict returned by clean()}. The interpretation
    matters more than the count: across ~190 NSE names over several years, an
    unadjusted feed should surface dozens of splits and bonuses. Near-zero means
    the feed is already adjusted -- a fact worth stating explicitly rather than
    leaving as an unexamined assumption.
    """
    total = sum(len(v["actions"]) for v in per_symbol.values())
    affected = [s for s, v in per_symbol.items() if v["actions"]]
    rejected = sum(len(v["rejected"]) for v in per_symbol.values())
    n = max(1, len(per_symbol))
    per_100 = total / n * 100

    if total == 0:
        verdict = (
            "No corporate actions detected anywhere in the universe. Across ~190 "
            "NSE F&O names over several years an UNADJUSTED feed would show "
            "dozens, so this is strong evidence Upstox daily candles are already "
            "adjusted. The detector stays on as a regression guard."
        )
    elif per_100 < 2:
        verdict = (
            f"{total} action(s) across {len(affected)} name(s) -- far below what "
            "an unadjusted feed would show. The feed is likely adjusted and "
            "these are probably genuine large moves that resembled split ratios. "
            "Inspect them before trusting the affected names."
        )
    else:
        verdict = (
            f"{total} action(s) across {len(affected)} name(s). That density is "
            "consistent with an UNADJUSTED feed; back-adjustment is doing real "
            "work and must not be disabled."
        )

    return {
        "actionsDetected": total,
        "symbolsAffected": len(affected),
        "largeMovesRejected": rejected,
        "actionsPer100Symbols": round(per_100, 2),
        "verdict": verdict,
        "examples": {s: per_symbol[s]["actions"] for s in affected[:10]},
    }
