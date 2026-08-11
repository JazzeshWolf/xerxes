import { coneFor, type RankerDetail, type RankerRow, type SkillState } from "../../lib/ranker";
import { useRankerDetail } from "../../state/rankerStore";
import { fmt, fmtPct } from "../../lib/format";
import { C } from "../../lib/palette";
import { Card, Stat, Badge } from "../ui";

// ---------------------------------------------------------------------------
// Per-name detail: sample-path cone, forecast distribution, recent OHLCV.
//
// Hand-rolled SVG in the style of Charts.tsx — the app has no chart library and
// is not getting one. Note the same constraint that file documents: SVG
// presentation attributes cannot take `var()`, so colours go through
// `style={{ fill: … }}` reading `lib/palette.ts`.
//
// This view is deliberately the LAST thing in the tab. A per-name cone is the
// most seductive object here and the least meaningful: the whole design rests on
// breadth, so no single name's forecast is supposed to carry weight. The copy
// says so rather than letting a pretty chart imply otherwise.
// ---------------------------------------------------------------------------

const W = 340, H = 130, PAD = { t: 10, r: 40, b: 14, l: 6 };

export function NameDetail({
  row,
  total,
  state,
  onBack,
}: {
  row: RankerRow;
  total: number;
  state: SkillState;
  onBack: () => void;
}) {
  const { detail, loading } = useRankerDetail(row.symbol);

  return (
    <>
      <button onClick={onBack} className="flex items-center gap-1.5 px-1 active:opacity-70">
        <span className="text-white/40 text-sm">←</span>
        <span className="text-sm text-white/70">Back to ranks</span>
      </button>

      <Card
        title={row.symbol}
        right={
          <Badge tone={row.lean === "bullish" ? "up" : row.lean === "bearish" ? "down" : "neutral"}>
            decile {row.decile}
          </Badge>
        }
      >
        <div className="text-[11px] text-white/60 mb-2">
          {row.name} · {row.sector}
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Stat label="Rank" value={`${row.rank}`} sub={`of ${total}`} />
          <Stat
            label="Forecast"
            value={fmtPct(row.forecastReturn * 100, 1)}
            tone={row.forecastReturn > 0 ? "up" : "down"}
          />
          <Stat label="Percentile" value={fmt(row.percentile * 100, 0)} />
          <Stat label="Beta" value={fmt(row.beta, 2)} />
        </div>
        <div className="text-[10px] text-white/45 mt-2 leading-relaxed">
          {state.actionable ? (
            row.implication
          ) : (
            <>
              <Badge tone="warn">Unproven</Badge> {row.implication} — but measured
              skill has not cleared the bar, so this is not yet a basis for a trade.
            </>
          )}
        </div>
      </Card>

      {loading && <div className="text-center text-white/40 py-8 text-sm">Loading detail…</div>}

      {detail && <ConeChart detail={detail} lastClose={row.lastClose} />}
      {detail && <DistributionCard detail={detail} />}
      {detail?.recent?.length ? <RecentBars detail={detail} /> : null}

      {!loading && !detail && (
        <div className="text-center text-white/40 py-8 text-sm">
          No detail published for this name.
          <div className="text-[10px] mt-2 text-white/45">
            The rank above is still valid — detail files are written per name and
            may lag a run.
          </div>
        </div>
      )}

      <div className="text-[10px] text-white/45 leading-relaxed px-1">
        One name's forecast is not the product. The ranking works — if it works at
        all — because it is applied across the whole universe at once:
        IR ≈ IC × √breadth. An IC of 0.03 on this stock is noise; the same IC
        across ~190 stocks is a strategy. Never size a position on this chart.
      </div>
    </>
  );
}

/** Sample-path cone: 10-90 band, median line, and the individual draws behind. */
function ConeChart({ detail, lastClose }: { detail: RankerDetail; lastClose: number }) {
  const paths = detail.paths ?? [];
  const cone = coneFor(detail);
  if (!cone) return null;

  const steps = cone.mid.length;
  const lo = Math.min(cone.min, lastClose) * 0.995;
  const hi = Math.max(cone.max, lastClose) * 1.005;
  const x = (i: number) => PAD.l + (i / Math.max(1, steps - 1)) * (W - PAD.r - PAD.l);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);

  // Out along the upper band, back along the lower one, closed — one filled
  // polygon rather than two strokes with a gap between them.
  const band =
    cone.hi.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("") +
    cone.lo
      .map((_, i) => steps - 1 - i)
      .map((j) => `L${x(j).toFixed(1)},${y(cone.lo[j]).toFixed(1)}`)
      .join("") +
    "Z";
  const line = (arr: number[]) =>
    arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  return (
    <Card title="Forecast cone">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          <path d={band} style={{ fill: C.infoWash }} />
          {/* Illustrative draws behind the band, clipped to the band's length so
              a longer path can never run past the plot. */}
          {paths.slice(0, 8).map((p, k) => (
            <path key={k} d={line(p.slice(0, steps))} fill="none" style={{ stroke: C.info }} strokeWidth="0.5" opacity="0.28" />
          ))}
          <path d={line(cone.mid)} fill="none" style={{ stroke: C.info }} strokeWidth="1.6" />
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(lastClose)}
            y2={y(lastClose)}
            style={{ stroke: C.warn }}
            strokeWidth="0.75"
            strokeDasharray="3 3"
            opacity="0.7"
          />
        </svg>
        <span
          className="absolute right-0 tnum text-[9px] leading-none font-bold"
          style={{ top: `${(y(cone.mid[steps - 1]) / H) * 100}%`, transform: "translateY(-50%)", color: C.info }}
        >
          {fmt(cone.mid[steps - 1], 0)}
        </span>
      </div>
      <div className="text-[10px] text-white/45 mt-1 leading-relaxed">
        Sampled price paths over the forecast horizon: the shaded band is the
        10th-90th percentile across draws, the solid line the median, the dashed
        line today's close. The band is wide because the model is genuinely
        uncertain about any one name — which is the point, and why the ranking
        rather than the level is what gets used.
      </div>
    </Card>
  );
}

/** Terminal-return quantiles as a simple horizontal scale. */
function DistributionCard({ detail }: { detail: { quantiles: Record<string, number> } }) {
  const q = detail.quantiles ?? {};
  const keys = ["q05", "q25", "q50", "q75", "q95"].filter((k) => Number.isFinite(q[k]));
  if (keys.length < 3) return null;

  const vals = keys.map((k) => q[k]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pos = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;

  return (
    <Card title="Forecast distribution">
      <div className="relative h-9">
        <div className="absolute left-0 right-0 top-4 h-px bg-white/15" />
        <div
          className="absolute top-3.5 h-1 rounded"
          style={{
            left: `${pos(q.q25 ?? lo)}%`,
            width: `${Math.max(2, pos(q.q75 ?? hi) - pos(q.q25 ?? lo))}%`,
            background: C.infoWash,
          }}
        />
        {keys.map((k) => (
          <div key={k} className="absolute" style={{ left: `${pos(q[k])}%`, transform: "translateX(-50%)" }}>
            <div
              className="w-px h-3 mx-auto"
              style={{ background: k === "q50" ? C.info : "rgba(255,255,255,0.3)", marginTop: "10px" }}
            />
            <div className="text-[8px] text-white/45 tnum mt-0.5 whitespace-nowrap">
              {fmtPct(q[k] * 100, 0)}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-white/45 mt-1 leading-relaxed">
        Terminal return at the 5th, 25th, 50th, 75th and 95th percentiles across
        sampled paths. The spread between the 5th and 95th is the honest measure
        of how little any single forecast pins down.
      </div>
    </Card>
  );
}

function RecentBars({
  detail,
}: {
  detail: { recent: { t: string; o: number; h: number; l: number; c: number }[] };
}) {
  const bars = detail.recent.slice(-60);
  if (bars.length < 5) return null;
  const hi = Math.max(...bars.map((b) => b.h));
  const lo = Math.min(...bars.map((b) => b.l));
  const bw = (W - PAD.l - PAD.r) / bars.length;
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);

  return (
    <Card title="Recent price">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {bars.map((b, i) => {
          const cx = PAD.l + i * bw + bw / 2;
          const up = b.c >= b.o;
          const col = up ? C.bull : C.bear;
          return (
            <g key={b.t}>
              <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} style={{ stroke: col }} strokeWidth="0.6" opacity="0.65" />
              <line
                x1={cx}
                x2={cx}
                y1={y(Math.max(b.o, b.c))}
                y2={y(Math.min(b.o, b.c))}
                style={{ stroke: col }}
                strokeWidth={Math.max(1.2, bw * 0.6)}
              />
            </g>
          );
        })}
      </svg>
      <div className="text-[10px] text-white/45 mt-1 leading-relaxed">
        The last {bars.length} sessions, corporate-action adjusted — the same
        series the model was fed.
      </div>
    </Card>
  );
}
