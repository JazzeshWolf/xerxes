import type { ComponentChildren } from "preact";
import type { Snapshot, ExpiryBlock } from "../lib/types";
import { buildNarrative } from "../lib/narrative";
import { PriceLevelsChart, VixChart } from "./Charts";
import { Card } from "./ui";

/** Plain-English synthesis of the whole snapshot — the "what's going on" read. */
export function HolisticTab({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const n = buildNarrative(snap, exp);
  return (
    <div className="space-y-3">
      <PriceLevelsChart snap={snap} exp={exp} />
      <Section title="What's going on" items={n.whatsGoingOn} />
      <Section title="How to read it" items={n.howToRead} />
      <Section title="Where it's likely headed" items={n.whereHeaded} />
      <Section title="What would change the view" items={n.whatFlips} bullet />
      <VixChart snap={snap} />
      <p className="text-[9px] text-white/25 px-1">
        Generated from the live snapshot by a fixed rule set — no forecasting model. Trust the levels and
        the structure, not a single sentence.
      </p>
    </div>
  );
}

function Section({ title, items, bullet }: { title: string; items: string[]; bullet?: boolean }) {
  if (!items.length) return null;
  return (
    <Card title={title}>
      <div className="space-y-1.5">
        {items.map((t, i) => (
          <div key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-white/75">
            {bullet && <span className="text-white/30 mt-0.5">•</span>}
            <span>{rich(t)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Minimal **bold** renderer (the narrative marks key phrases with **…**). */
function rich(s: string): ComponentChildren {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="text-white/95 font-semibold">{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
