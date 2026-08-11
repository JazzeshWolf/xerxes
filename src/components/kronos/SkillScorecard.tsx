import type { RankerIndex, RankerSkill, SkillState } from "../../lib/ranker";
import { Card, Stat, Badge } from "../ui";

// ---------------------------------------------------------------------------
// The scorecard, and it comes FIRST on the page.
//
// The ordering is the argument. A ranker that opens with a decile table invites
// you to trade it and mentions its reliability somewhere below the fold. This
// one states what was measured before it shows you a single name, because the
// whole point of the build is that the ranking is only worth as much as its
// ICIR — and until the walk-forward has run, that number does not exist.
// ---------------------------------------------------------------------------

const pct = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`;
const num = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(x) ? "—" : x.toFixed(d);

const BANNER_TONE: Record<SkillState["tone"], string> = {
  up: "border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-300/90",
  warn: "border-amber-400/30 bg-amber-400/[0.07] text-amber-300/90",
  down: "border-rose-400/30 bg-rose-400/[0.07] text-rose-300/90",
};

export function SkillBanner({ state }: { state: SkillState }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${BANNER_TONE[state.tone]}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider">{state.headline}</div>
      <div className="text-[10px] leading-relaxed mt-1 opacity-90">{state.detail}</div>
    </div>
  );
}

export function SkillScorecard({
  index,
  skill,
  state,
}: {
  index: RankerIndex;
  skill: RankerSkill | null;
  state: SkillState;
}) {
  const v = skill?.verdict ?? index.skill;
  const eng = skill?.arms?.engine;
  const mom = skill?.arms?.momentum_12_1;
  const rnd = skill?.arms?.random;
  const icir = v?.icir ?? null;
  const bar = v?.bar ?? 0.3;

  return (
    <>
      <SkillBanner state={state} />

      <Card
        title="Measured skill"
        right={
          <span className="text-[9px] text-white/40 tnum">
            {skill ? `${skill.rebalances} rebalances` : "not measured"}
          </span>
        }
      >
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="ICIR"
            value={num(icir)}
            sub={`bar ${num(bar)}`}
            tone={icir == null ? null : icir >= bar ? "up" : "down"}
          />
          <Stat
            label="IC t-stat"
            value={num(eng?.ic?.tStat)}
            sub={eng?.ic?.n ? `n=${eng.ic.n}` : undefined}
          />
          <Stat
            label="Mean IC"
            value={num(eng?.ic?.meanIC, 3)}
            sub={eng?.ic?.stdIC != null ? `sd ${num(eng.ic.stdIC, 3)}` : undefined}
          />
        </div>

        <div className="text-[10px] text-white/45 mt-2 leading-relaxed">
          ICIR is the mean information coefficient divided by its standard deviation
          across rebalances. Mean IC alone says nothing: the same average from a
          signal that works every month and one that swings wildly are different
          products, and only the ratio tells them apart.
        </div>
      </Card>

      {/* The comparison that decides whether any of this is worth running. */}
      <Card title="Versus the benchmarks">
        {skill ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Stat
                label="Kronos ICIR"
                value={num(icir)}
                tone={icir == null ? null : icir >= bar ? "up" : "down"}
              />
              <Stat label="12-1 momentum" value={num(mom?.ic?.icir)} />
              <Stat
                label="Edge"
                value={num(v?.edgeOverMomentum)}
                tone={
                  v?.edgeOverMomentum == null
                    ? null
                    : v.edgeOverMomentum > 0
                      ? "up"
                      : "down"
                }
              />
            </div>
            <div className="text-[10px] text-white/45 mt-2 leading-relaxed">
              12-1 momentum is free — no model, no GPU, no pre-training. A ranker
              that only ties it has bought nothing for its compute.
              {rnd?.ic?.icir != null && (
                <>
                  {" "}The random benchmark scores {num(rnd.ic.icir)}, which is what
                  this harness reports when there is provably no signal.
                </>
              )}
            </div>
          </>
        ) : (
          <div className="text-[10px] text-white/45 leading-relaxed">
            No benchmark comparison yet — the walk-forward validation has not run.
            Until it does, there is nothing to say about whether this ranking beats
            plain momentum.
          </div>
        )}
      </Card>

      {skill?.arms?.engine?.spread && (
        <Card
          title="Decile spread"
          right={
            <span className="text-[9px] text-white/40">
              long top · short bottom
            </span>
          }
        >
          <div className="grid grid-cols-3 gap-3">
            <Stat
              label="Gross / rebalance"
              value={pct(eng?.spread?.meanGrossPerRebalance)}
              tone={(eng?.spread?.meanGrossPerRebalance ?? 0) > 0 ? "up" : "down"}
            />
            <Stat
              label="Net of costs"
              value={pct(eng?.spread?.net?.meanNetPerRebalance)}
              sub={
                eng?.spread?.net?.roundTripBps != null
                  ? `${eng.spread.net.roundTripBps} bps r/t`
                  : undefined
              }
              tone={(eng?.spread?.net?.meanNetPerRebalance ?? 0) > 0 ? "up" : "down"}
            />
            <Stat label="Turnover" value={pct(eng?.spread?.meanTurnover, 0)} />
          </div>
          <div className="text-[10px] text-white/45 mt-2 leading-relaxed">
            A skill measure, not a strategy on offer: the short leg is not
            shortable in Indian equity delivery, so trading this would mean
            single-stock futures with a different cost stack. Costs include
            brokerage, STT, exchange charges, GST, stamp duty and an impact-cost
            assumption — impact is the term usually left out, and usually the
            largest.
          </div>
        </Card>
      )}

      {/* Integrity checks. Shown, not buried: a ranking that is still beta in
          disguise looks exactly like a working one. */}
      {index.neutralization && (
        <Card title="Neutralisation check">
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Beta rank corr"
              value={num(index.neutralization.after?.betaRankCorr, 3)}
              sub={`before ${num(index.neutralization.before?.betaRankCorr, 3)}`}
              tone={index.neutralization.passed ? "up" : "down"}
            />
            <Stat
              label="Sector R²"
              value={num(index.neutralization.after?.sectorR2, 3)}
              sub={`before ${num(index.neutralization.before?.sectorR2, 3)}`}
              tone={index.neutralization.passed ? "up" : "down"}
            />
          </div>
          <div className="text-[10px] text-white/45 mt-2 leading-relaxed">
            Raw forecasts are dominated by market beta — if the model likes the
            index it likes everything, and the "ranking" is a leveraged index bet
            in disguise. These are the numbers after cross-sectional demeaning,
            beta-neutralisation and sector-neutralisation.{" "}
            {index.neutralization.passed ? (
              <span className="text-emerald-300/80">Both are inside their bars.</span>
            ) : (
              <span className="text-amber-300">
                One or both are still above their bar — treat these ranks as beta
                or sector exposure rather than stock selection.
              </span>
            )}
          </div>
        </Card>
      )}

      {index.corporateActions?.verdict && (
        <Card title="Corporate actions">
          <div className="flex items-center gap-2 mb-1.5">
            <Badge tone={index.corporateActions.actionsDetected ? "warn" : "neutral"}>
              {index.corporateActions.actionsDetected ?? 0} detected
            </Badge>
          </div>
          <div className="text-[10px] text-white/45 leading-relaxed">
            {index.corporateActions.verdict}
          </div>
          <div className="text-[10px] text-white/45 mt-1.5 leading-relaxed">
            Unadjusted splits and bonuses would print fake ±50% returns that land
            a name in the bottom decile with total confidence — the single most
            likely way this ranking silently produces garbage.
          </div>
        </Card>
      )}
    </>
  );
}
