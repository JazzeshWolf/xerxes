import type { ComponentChildren } from "preact";
import type { Snapshot } from "../lib/types";
import { fmtExpiry } from "../lib/format";

/** Expiry dropdown — switches the chain/levels/metrics panels between expiries. */
export function ExpiryPicker({
  snap,
  value,
  onChange,
}: {
  snap: Snapshot;
  value: string;
  onChange: (e: string) => void;
}) {
  const expiries = Object.values(snap.expiries).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (expiries.length <= 1) {
    const only = expiries[0];
    return (
      <span className="text-[11px] text-white/50">
        {only ? `${fmtExpiry(only.date)} · ${only.dte}d` : "—"}
      </span>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      className="text-[11px] bg-white/[0.06] border border-white/15 rounded px-1.5 py-0.5 text-white/85"
    >
      {expiries.map((b) => (
        <option key={b.date} value={b.date}>
          {fmtExpiry(b.date)} · {b.label} · {b.dte}d
        </option>
      ))}
    </select>
  );
}

export function Card({ title, right, children }: { title?: string; right?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-3">
      {(title || right) && (
        <div className="flex items-baseline justify-between mb-2">
          {title && <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/50">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ComponentChildren; sub?: ComponentChildren; tone?: "up" | "down" | null }) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-white/90";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-white/40">{label}</div>
      <div className={`text-sm font-semibold tnum ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-white/40 tnum">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ComponentChildren; tone?: "up" | "down" | "warn" | "neutral" }) {
  const cls =
    tone === "up" ? "text-emerald-300/90 border-emerald-400/30" :
    tone === "down" ? "text-rose-300/90 border-rose-400/30" :
    tone === "warn" ? "text-amber-300/90 border-amber-400/30" :
    "text-white/50 border-white/20";
  return <span className={`text-[9px] uppercase tracking-wide border rounded px-1 py-0.5 ${cls}`}>{children}</span>;
}
