import { useState } from "preact/hooks";
import type { Snapshot, ExpiryBlock, Verdict } from "../lib/types";
import { explainFactor } from "../lib/explain";
import { Card } from "./ui";

/**
 * Why the verdict: per-factor signal bars with live readings. Each row expands
 * into a plain-English explainer — what the factor is, what today's reading
 * means, and what it implies into the selected expiry.
 */
export function FactorsCard({ v, snap, exp }: { v: Verdict; snap: Snapshot; exp: ExpiryBlock }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = v.factors.filter((f) => f.present);
  if (!rows.length) return null;
  return (
    <Card title="Why — factor breakdown" right={<span className="text-[9px] text-white/50">tap a row to decode it</span>}>
      <div className="space-y-1">
        {rows.map((f) => {
          const s = f.s ?? 0;
          const w = Math.abs(s) * 50; // % of half-width
          const isOpen = open === f.key;
          const ex = isOpen ? explainFactor(f, snap, exp) : null;
          return (
            <div key={f.key}>
              <button className="w-full text-left py-1" onClick={() => setOpen(isOpen ? null : f.key)}>
                <div className="flex justify-between text-[10px]">
                  <span className="text-white/70">
                    <span className={`inline-block w-2 text-white/45 ${isOpen ? "rotate-90" : ""} transition-transform`}>›</span>{" "}
                    {f.label}
                  </span>
                  <span className="text-white/40 tnum">{f.reading}</span>
                </div>
                <div className="relative h-1.5 mt-0.5 rounded-full bg-white/[0.10]">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-white/35" /> {/* zero line: this axis is bipolar (−1…+1), so the midpoint is meaningful */}
                  <div
                    className={`absolute inset-y-0 rounded-full ${s >= 0 ? "bg-emerald-400/80" : "bg-rose-400/80"}`}
                    style={s >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                  />
                </div>
              </button>
              {ex && (
                <div className="mb-1.5 mt-0.5 rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-2 space-y-1.5">
                  <ExplainRow tag="What it is" text={ex.what} />
                  <ExplainRow tag="Right now" text={ex.read} />
                  <ExplainRow tag="Into expiry" text={ex.expiry} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-[9px] text-white/45 mt-2">
        Bar = signal strength × direction; weights redistribute when a factor's data is missing.
      </div>
    </Card>
  );
}

function ExplainRow({ tag, text }: { tag: string; text: string }) {
  return (
    <div className="text-[10px] leading-relaxed">
      <span className="uppercase tracking-wide text-[8px] text-white/50 mr-1">{tag}</span>
      <span className="text-white/70">{text}</span>
    </div>
  );
}
