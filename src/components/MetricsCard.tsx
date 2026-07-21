import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Snapshot, ExpiryBlock } from "../lib/types";
import { fmt, fmtOi, fmtPct } from "../lib/format";
import { explainPcr, explainAtmIv, explainStraddle, explainOiFlowToday, explainSkew, type Explain } from "../lib/explain";
import { Card, Stat } from "./ui";

/**
 * PCR, OI flow, IV state and the expected move band — every number carries a
 * one-line dynamic interpretation, and tapping a block expands the full
 * plain-English explainer (what it is / what this value means / into expiry).
 */
export function MetricsCard({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const [open, setOpen] = useState<string | null>(null);
  const m = exp.metrics;
  const spot = snap.spot.price;
  const dte = exp.dte;
  const em = m.expectedMove;
  const flow = m.oiFlow;

  const exPcr = explainPcr(m.pcrOi, dte);
  const exIv = explainAtmIv(m, dte);
  const exStr = explainStraddle(m, spot, dte);
  const exFlow = explainOiFlowToday(flow, dte);
  const exSkew = explainSkew(m.skew, dte);

  const toggle = (k: string) => setOpen(open === k ? null : k);

  return (
    <Card title="Positioning & vol" right={<span className="text-[9px] text-white/35">tap a block to decode it</span>}>
      <div className="grid grid-cols-3 gap-2">
        <Tappable onTap={() => toggle("pcr")} active={open === "pcr"}>
          <Stat
            label="PCR (OI)"
            value={fmt(m.pcrOi, 2)}
            sub={pcrOneLiner(m.pcrOi)}
            tone={m.pcrOi != null ? (m.pcrOi > 1.1 ? "up" : m.pcrOi < 0.8 ? "down" : null) : null}
          />
        </Tappable>
        <Tappable onTap={() => toggle("iv")} active={open === "iv"}>
          <Stat
            label="ATM IV"
            value={m.atmIv != null ? fmtPct(m.atmIv * 100, 1, false) : "—"}
            sub={ivOneLiner(m)}
          />
        </Tappable>
        <Tappable onTap={() => toggle("straddle")} active={open === "straddle"}>
          <Stat label="Straddle" value={m.straddle != null ? fmt(m.straddle) : "—"} sub="market's priced move" />
        </Tappable>
      </div>
      {open === "pcr" && exPcr && <ExplainBox ex={exPcr} />}
      {open === "iv" && exIv && <ExplainBox ex={exIv} />}
      {open === "straddle" && exStr && <ExplainBox ex={exStr} />}

      {flow && (
        <>
          <Tappable onTap={() => toggle("flow")} active={open === "flow"}>
            <div className="grid grid-cols-2 gap-2 mt-3 pt-2 border-t border-white/[0.06]">
              <Stat label="Put OI today" value={fmtOi(flow.putOiChg, true)} sub="writing = support" tone={flow.putOiChg > 0 ? "up" : "down"} />
              <Stat label="Call OI today" value={fmtOi(flow.callOiChg, true)} sub="writing = ceiling" tone={flow.callOiChg > 0 ? "down" : "up"} />
            </div>
          </Tappable>
          {open === "flow" && exFlow && <ExplainBox ex={exFlow} />}
        </>
      )}

      {em != null && em > 0 && (
        <div className="mt-3 pt-2 border-t border-white/[0.06]">
          <div className="flex justify-between text-[10px] text-white/40 mb-1">
            <span>Expected move to expiry (±1σ)</span>
            <span className="tnum">±{fmt(em)} pts ({fmt((em / spot) * 100, 1)}%)</span>
          </div>
          <div className="relative h-5 rounded bg-white/[0.05]">
            <div className="absolute inset-y-0 rounded bg-sky-400/20" style={{ left: "15%", right: "15%" }} />
            <div className="absolute inset-y-0 w-px bg-sky-300" style={{ left: "50%" }} />
            <span className="absolute text-[9px] text-white/60 tnum top-1/2 -translate-y-1/2" style={{ left: "16%" }}>
              {fmt(spot - em)}
            </span>
            <span className="absolute text-[9px] text-white/60 tnum top-1/2 -translate-y-1/2 right-[16%]">
              {fmt(spot + em)}
            </span>
          </div>
          <div className="text-[10px] text-white/45 mt-1">
            The market itself expects spot to stay inside this band by expiry — strikes outside it are where sellers get paid to disagree.
          </div>
          {m.skew != null && (
            <>
              <Tappable onTap={() => toggle("skew")} active={open === "skew"}>
                <div className="text-[10px] text-white/45 mt-1.5">
                  Skew: {m.skew > 0.005 ? "puts bid — downside fear priced" : m.skew < -0.005 ? "calls bid — upside chase" : "flat"}
                  <span className="tnum"> ({fmt(m.skew * 100, 1)} vol pts)</span>
                </div>
              </Tappable>
              {open === "skew" && exSkew && <ExplainBox ex={exSkew} />}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// One-line dynamic interpretations shown under the big numbers.
function pcrOneLiner(pcr: number | null): string | undefined {
  if (pcr == null) return undefined;
  if (pcr >= 1.1) return "put-heavy → support";
  if (pcr > 0.9) return "balanced";
  return "call-heavy → capped";
}
function ivOneLiner(m: ExpiryBlock["metrics"]): string | undefined {
  if (m.atmIv == null) return undefined;
  if (m.ivRank != null) return m.ivRank >= 60 ? `IV rank ${fmt(m.ivRank)} — rich` : m.ivRank <= 30 ? `IV rank ${fmt(m.ivRank)} — cheap` : `IV rank ${fmt(m.ivRank)}`;
  if (m.rv20 != null) {
    const ratio = m.atmIv / m.rv20;
    return ratio > 1.25 ? "above realized — rich" : ratio < 0.85 ? "below realized — cheap" : "≈ realized vol";
  }
  return undefined;
}

function Tappable({ children, onTap, active }: { children: ComponentChildren; onTap: () => void; active: boolean }) {
  return (
    <button onClick={onTap} className={`block w-full text-left rounded ${active ? "bg-white/[0.03]" : ""}`}>
      {children}
    </button>
  );
}

function ExplainBox({ ex }: { ex: Explain }) {
  return (
    <div className="mt-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-2 space-y-1.5">
      <Row tag="What it is" text={ex.what} />
      <Row tag="Right now" text={ex.read} />
      <Row tag="Into expiry" text={ex.expiry} />
    </div>
  );
}
function Row({ tag, text }: { tag: string; text: string }) {
  return (
    <div className="text-[10px] leading-relaxed">
      <span className="uppercase tracking-wide text-[8px] text-white/35 mr-1">{tag}</span>
      <span className="text-white/70">{text}</span>
    </div>
  );
}
