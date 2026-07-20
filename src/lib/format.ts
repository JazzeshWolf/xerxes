export function fmt(n: number | null | undefined, d = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Indian-style compact OI: 1.2Cr / 34.5L / 12k. */
export function fmtOi(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const s =
    a >= 1e7 ? `${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr` :
    a >= 1e5 ? `${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L` :
    a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : String(Math.round(a));
  return n < 0 ? `-${s}` : signed && n > 0 ? `+${s}` : s;
}

export function fmtPct(n: number | null | undefined, d = 1, signed = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n.toFixed(d);
  return `${signed && n > 0 ? "+" : ""}${s}%`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** "2026-07-21" -> "Tue 21 Jul" */
export function fmtExpiry(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
