import type { Verdict } from "../lib/types";
import { Card } from "./ui";

/** Why the verdict: per-factor signal bars with their live readings. */
export function FactorsCard({ v }: { v: Verdict }) {
  const rows = v.factors.filter((f) => f.present);
  if (!rows.length) return null;
  return (
    <Card title="Why — factor breakdown">
      <div className="space-y-2">
        {rows.map((f) => {
          const s = f.s ?? 0;
          const w = Math.abs(s) * 50; // % of half-width
          return (
            <div key={f.key}>
              <div className="flex justify-between text-[10px]">
                <span className="text-white/70">{f.label}</span>
                <span className="text-white/40 tnum">{f.reading}</span>
              </div>
              <div className="relative h-1.5 mt-0.5 rounded-full bg-white/[0.06]">
                <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
                <div
                  className={`absolute inset-y-0 rounded-full ${s >= 0 ? "bg-emerald-400/80" : "bg-rose-400/80"}`}
                  style={s >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[9px] text-white/25 mt-2">
        Bar = signal strength × direction; weights redistribute when a factor's data is missing.
      </div>
    </Card>
  );
}
