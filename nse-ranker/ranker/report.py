"""
The human-readable validation report.

Structured so the two numbers that decide whether any of this is worth running
appear before anything else: **ICIR**, and **how it compares to 12-1 momentum**.
Charts, decile tables and cost breakdowns come after. A report that opens with a
pretty equity curve and buries a 0.1 ICIR in an appendix is a sales document,
not a measurement.

Where a number is absent or fails its bar, the report says so in words rather
than leaving a blank cell for the reader to interpret charitably.
"""

from __future__ import annotations


def render(skill: dict) -> str:
    v = skill.get("verdict", {})
    arms = skill.get("arms", {})
    eng = arms.get("engine", {})
    ic = eng.get("ic", {})
    spread = eng.get("spread", {})
    cfg = skill.get("config", {})

    out: list[str] = []
    w = out.append

    w("# NSE F&O ranker — measured skill")
    w("")
    w(f"_Engine_: **{skill.get('engine')}** (`{skill.get('model')}`)  ")
    w(f"_Generated_: {skill.get('asOf')}  ")
    w(f"_Horizon_: {cfg.get('predLen')} trading days, rebalanced every "
      f"{cfg.get('rebalanceEvery')}")
    w("")

    # ---- the headline ----------------------------------------------------
    w("## Verdict")
    w("")
    if v.get("validated"):
        w(f"**VALIDATED.** {v.get('summary')}")
    else:
        w(f"**NOT VALIDATED.** {v.get('summary')}")
    w("")
    w("| | |")
    w("|---|---|")
    w(f"| **ICIR** (the number that matters) | **{_n(v.get('icir'))}** |")
    w(f"| Bar it must clear | {_n(v.get('bar'))} |")
    w(f"| 12-1 momentum ICIR | {_n(v.get('momentumIcir'))} |")
    w(f"| **Edge over momentum** | **{_n(v.get('edgeOverMomentum'))}** |")
    w(f"| Mean IC | {_n(ic.get('meanIC'))} |")
    w(f"| IC std | {_n(ic.get('stdIC'))} |")
    w(f"| t-stat | {_n(ic.get('tStat'))} |")
    w(f"| Rebalances | {ic.get('n')} |")
    w(f"| Hit rate | {_pct(ic.get('hitRate'))} |")
    w("")
    w("ICIR is mean IC divided by its standard deviation across rebalances. Mean "
      "IC on its own says nothing: the same average from a signal that works "
      "every month and one that swings wildly are different products, and only "
      "the ratio distinguishes them.")
    w("")
    if v.get("reasons"):
        w("**Why it did not validate:**")
        w("")
        for r in v["reasons"]:
            w(f"- {r}")
        w("")

    # ---- momentum comparison, spelled out --------------------------------
    w("## Against the benchmarks")
    w("")
    w("| Arm | ICIR | Mean IC | t-stat | Gross spread / rebalance | Net of costs |")
    w("|---|---|---|---|---|---|")
    for name in ("engine", "momentum_12_1", "reversal_5d", "random"):
        arm = arms.get(name)
        if not arm:
            continue
        a_ic, a_sp = arm.get("ic", {}), arm.get("spread", {})
        label = "**Kronos/engine**" if name == "engine" else name
        w(f"| {label} | {_n(a_ic.get('icir'))} | {_n(a_ic.get('meanIC'))} | "
          f"{_n(a_ic.get('tStat'))} | {_pct(a_sp.get('meanGrossPerRebalance'))} | "
          f"{_pct((a_sp.get('net') or {}).get('meanNetPerRebalance'))} |")
    w("")
    w("`random` is the true null — it establishes what this harness reports when "
      "there is provably no signal. `momentum_12_1` is the one that matters "
      "commercially: it is free, and a model that cannot beat it is not earning "
      "its compute.")
    w("")

    # ---- costs -----------------------------------------------------------
    w("## Decile spread and costs")
    w("")
    w(f"- Mean turnover per rebalance: **{_pct(spread.get('meanTurnover'))}**")
    w(f"- Cost drag per rebalance: **{_pct(spread.get('costDragPerRebalance'))}**")
    w(f"- Gross annualised: **{_pct(spread.get('annualisedGross'))}**")
    net = spread.get("net") or {}
    w(f"- Net annualised (impact {net.get('impactBps')} bps): "
      f"**{_pct(net.get('annualisedNet'))}**")
    w(f"- Round-trip cost assumption: **{net.get('roundTripBps')} bps**")
    w("")
    if spread.get("impactSensitivity"):
        w("Impact cost is a prior, not a measurement, and it is usually the "
          "largest single term. The result at each assumption:")
        w("")
        w("| Impact (bps) | Round trip (bps) | Net / rebalance | Net annualised |")
        w("|---|---|---|---|")
        for s in spread["impactSensitivity"]:
            w(f"| {s['impactBps']} | {s['roundTripBps']} | "
              f"{_pct(s['meanNetPerRebalance'])} | {_pct(s['annualisedNet'])} |")
        w("")
    w("> The decile spread is a **measure of ranking skill**, not a strategy this "
      "repo proposes trading. The short leg is not shortable in Indian equity "
      "delivery, so a real implementation would use single-stock futures with a "
      "different cost stack. The product here is the lean — which side of the "
      "chain to sell.")
    w("")

    # ---- integrity checks ------------------------------------------------
    nz = skill.get("neutralization", {})
    if nz:
        w("## Neutralisation")
        w("")
        w("| | Beta rank corr | Sector R² |")
        w("|---|---|---|")
        w(f"| Before | {_n(nz.get('before', {}).get('betaRankCorr'))} | "
          f"{_n(nz.get('before', {}).get('sectorR2'))} |")
        w(f"| After | {_n(nz.get('after', {}).get('betaRankCorr'))} | "
          f"{_n(nz.get('after', {}).get('sectorR2'))} |")
        w(f"| Bar | ≤ {nz.get('thresholds', {}).get('maxBetaRankCorr')} | "
          f"≤ {nz.get('thresholds', {}).get('maxSectorR2')} |")
        w("")
        w(nz.get("verdict", ""))
        w("")
        w("If the *after* row had not fallen, the ranking would be market beta or "
          "a sector bet wearing a stock-selection costume — and it would still "
          "look like a working model.")
        w("")

    ca = skill.get("corporateActions", {})
    if ca:
        w("## Corporate actions")
        w("")
        w(f"- Detected: **{ca.get('actionsDetected')}** across "
          f"{ca.get('symbolsAffected')} names "
          f"({ca.get('actionsPer100Symbols')} per 100 symbols)")
        w(f"- Large moves examined and kept as real returns: "
          f"{ca.get('largeMovesRejected')}")
        w("")
        w(ca.get("verdict", ""))
        w("")

    depth = skill.get("dataDepth", {})
    if depth:
        w("## Data depth (measured, not assumed)")
        w("")
        w(f"- Oldest bar: **{depth.get('oldestBar')}**")
        w(f"- Newest bar: **{depth.get('newestBar')}**")
        w(f"- Trading days: **{depth.get('tradingDays')}** "
          f"(~{depth.get('approxYears')} years, requested "
          f"{depth.get('requestedYears')})")
        w("")
        w(depth.get("note", ""))
        w("")

    cov = skill.get("universeCoverage", {})
    if cov:
        w("## Survivorship bias")
        w("")
        w(f"- Rebalances on point-in-time membership: **{cov.get('pointInTime')}** "
          f"of {cov.get('rebalances')}")
        w(f"- Rebalances using today's list for a past date: "
          f"**{cov.get('fallback')}**")
        w("")
        w(cov.get("note", ""))
        w("")

    return "\n".join(out) + "\n"


def _n(x) -> str:
    return "—" if x is None else f"{float(x):.3f}"


def _pct(x) -> str:
    return "—" if x is None else f"{float(x) * 100:.2f}%"
