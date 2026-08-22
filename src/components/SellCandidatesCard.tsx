import { useState } from "preact/hooks";
import type { Snapshot, ExpiryBlock } from "../lib/types";
import { fmtExpiry } from "../lib/format";
import { Card, Badge } from "./ui";
import { CandidateRow } from "./CandidateRow";

const MAX_ROWS = 12;
type Side = "ALL" | "PE" | "CE";

/**
 * The index dashboard's lead card: the strikes worth selling on the selected
 * expiry, ranked by conviction, mixing calls and puts the way the stock
 * screener's list does.
 *
 * It does NOT choose the expiry. `ExpiryChooser` inside `SpotStrip` owns that
 * for the whole page — every other card keys off the same block — so a second
 * selector here would fight it. The expiry is stated, not offered.
 */
export function SellCandidatesCard({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const [side, setSide] = useState<Side>("ALL");
  const all = exp.candidates;
  const nPut = all.filter((c) => c.type === "PE").length;
  const nCall = all.length - nPut;
  const rows = side === "ALL" ? all : all.filter((c) => c.type === side);
  const shown = rows.slice(0, MAX_ROWS);
  const lot = snap.lotSize;

  // The per-expiry verdict, not `snap.verdict` — the top-level one is the
  // NEAREST expiry's (build-data.mjs writes it that way for back-compat), so on
  // any other selection it would badge a favoured side computed from a
  // different horizon than the strikes listed below it.
  const v = exp.verdict ?? snap.verdict;
  const favored: "PE" | "CE" | null =
    v.verdict === "BULLISH" ? "PE" : v.verdict === "BEARISH" ? "CE" : null;

  // Only claim "nothing here pays" when we actually priced something. All-null
  // edges mean the forecast was unavailable, which is a different statement.
  const priced = all.filter((c) => c.edgePct != null);
  const noPositiveEdge = priced.length > 0 && priced.every((c) => (c.edgePct ?? 0) <= 0);

  const chips: { key: Side; label: string; n: number }[] = [
    { key: "ALL", label: "All", n: all.length },
    { key: "PE", label: "Puts", n: nPut },
    { key: "CE", label: "Calls", n: nCall },
  ];

  return (
    <Card
      title="Sell candidates"
      right={<span className="text-[9px] text-white/40">ranked by conviction</span>}
    >
      <div className="text-[10px] text-white/40 tnum mb-2">
        {exp.label} expiry · {fmtExpiry(exp.date)} · {exp.dte}d
      </div>

      <div className="flex gap-1 mb-2">
        {chips.map((ch) => (
          <button
            key={ch.key}
            onClick={() => setSide(ch.key)}
            className={`text-[10px] px-2 py-0.5 rounded border ${
              side === ch.key ? "border-white/40 text-white" : "border-white/10 text-white/40"
            }`}
          >
            {ch.label} <span className="tnum">{ch.n}</span>
          </button>
        ))}
      </div>

      {favored && (
        <div className="mb-2">
          <Badge tone={favored === "PE" ? "up" : "down"}>
            verdict favors selling {favored === "PE" ? "puts" : "calls"}
          </Badge>{" "}
          {side !== "ALL" && side !== favored && (
            <Badge tone="warn">you're viewing the against-verdict side</Badge>
          )}
        </div>
      )}

      {noPositiveEdge && (
        <div className="mb-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-300/80">
          Every strike here prices below fair value on our vol forecast, so selling any of them is
          negative expectancy today. Ranked anyway, best-first, so you can see how close it gets.
        </div>
      )}

      {!all.length ? (
        <div className="text-[11px] text-white/40 py-3 text-center leading-relaxed">
          No strike cleared the seller's filters on this expiry (Δ ≤ 0.25, premium ≥ min). Near-dated
          index chains offer little worth selling — try a further expiry above.
        </div>
      ) : (
        <>
          {all.length <= 6 && (
            <div className="mb-2 text-[10px] leading-relaxed text-amber-300/80">
              Only {all.length} strike{all.length === 1 ? "" : "s"} cleared the filters at {exp.dte}d.
              That is normal on a near expiry, not a data problem.
            </div>
          )}

          <div className="text-[9px] text-white/45 mb-1.5">
            score · side · strike · P(keep) · edge · cushion · credit/lot — tap a row for the breakdown
          </div>

          <div className="space-y-1">
            {shown.map((c) => (
              <CandidateRow
                key={`${c.type}${c.strike}`}
                c={c}
                kind="index"
                creditPerLot={lot != null ? c.ltp * lot : null}
              />
            ))}
            {!shown.length && (
              <div className="text-[11px] text-white/40 py-3 text-center">
                No {side === "PE" ? "puts" : "calls"} cleared the filters at this expiry.
              </div>
            )}
          </div>
        </>
      )}

      <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
        {rows.length > MAX_ROWS && <>Showing the top {MAX_ROWS} of {rows.length} by conviction. </>}
        Conviction is absolute, not a rank within this list: HIGH 70+, MEDIUM 50+. An all-LOW list
        means nothing here is compelling right now — when index IV sits below forecast realized vol,
        most strikes carry negative expected edge. The volatility premium card quantifies it.
        {lot ? ` Credit shown is one lot (${lot}).` : ""}
      </div>
    </Card>
  );
}
