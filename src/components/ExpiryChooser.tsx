import type { Snapshot, ExpiryBlock } from "../lib/types";
import { fmtExpiry } from "../lib/format";

/**
 * Two-level expiry chooser: pick the CADENCE (weekly / monthly), then which one
 * (this week, next week, the week after — or this month, next month, the month
 * after).
 *
 * This replaces a raw dropdown of ISO dates. "Tue, 25 Aug · 17d" tells you when
 * a contract dies but not which decision you're making; a seller thinks in "am I
 * writing this week or this month", so the control is shaped that way.
 *
 * Deliberately stateless — the cadence is DERIVED from whichever expiry is
 * selected, so the tabs stay correct when the selection is changed from
 * somewhere else (the horizon dials on the verdict card do exactly that).
 * Tapping a cadence tab jumps to the nearest expiry of that cadence.
 *
 * Only cadences that actually exist are offered: BANKNIFTY has no weeklies, and
 * SENSEX's far monthlies are often not listed on BSE, so a short list is the
 * honest answer rather than a bug.
 */
const WEEKLY_LABELS = ["This week", "Next week", "Week after"];
const MONTHLY_LABELS = ["This month", "Next month", "Month after"];

const ordinalLabel = (cadence: "weekly" | "monthly", i: number) =>
  cadence === "weekly"
    ? WEEKLY_LABELS[i] ?? `Week ${i + 1}`
    : MONTHLY_LABELS[i] ?? `Month ${i + 1}`;

export function ExpiryChooser({
  snap,
  value,
  onChange,
}: {
  snap: Snapshot;
  value: string;
  onChange: (e: string) => void;
}) {
  const blocks = Object.values(snap.expiries).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!blocks.length) return null;

  const groups: Record<"weekly" | "monthly", ExpiryBlock[]> = {
    weekly: blocks.filter((b) => b.label === "weekly"),
    monthly: blocks.filter((b) => b.label === "monthly"),
  };
  const available = (["weekly", "monthly"] as const).filter((k) => groups[k].length);
  if (!available.length) return null;

  const selected = blocks.find((b) => b.date === value);
  const cadence = (selected?.label as "weekly" | "monthly") ?? available[0];
  const list = groups[cadence].length ? groups[cadence] : groups[available[0]];

  return (
    <div className="space-y-1.5">
      {available.length > 1 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-white/40 shrink-0">Expiry</span>
          <div className="flex gap-1">
            {available.map((k) => (
              <button
                key={k}
                onClick={() => onChange(groups[k][0].date)}
                className={`text-[10px] px-2.5 py-0.5 rounded-full border capitalize ${
                  k === cadence
                    ? "border-white/45 text-white bg-white/[0.08]"
                    : "border-white/12 text-white/55"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-1">
        {list.map((b, i) => {
          const active = b.date === value;
          return (
            <button
              key={b.date}
              onClick={() => onChange(b.date)}
              className={`flex-1 min-w-0 rounded-lg border px-1.5 py-1 text-left ${
                active ? "border-white/35 bg-white/[0.08]" : "border-white/10 bg-white/[0.02] opacity-65"
              }`}
            >
              <div className="text-[10px] font-semibold text-white/85 truncate">
                {ordinalLabel(cadence, i)}
              </div>
              <div className="text-[9px] text-white/40 tnum truncate">
                {fmtExpiry(b.date)} · {b.dte}d
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
