import { useState } from "preact/hooks";
import type { CandidateRowData, ConvictionBand } from "../lib/types";
import { fmt, fmtOi, fmtPct, fmtExpiry } from "../lib/format";

export const BAND_TONE: Record<ConvictionBand, string> = {
  HIGH: "text-emerald-300 border-emerald-400/40 bg-emerald-400/10",
  MEDIUM: "text-sky-300 border-sky-400/35 bg-sky-400/10",
  LOW: "text-white/45 border-white/15 bg-white/[0.04]",
};

/**
 * One ranked sell candidate: a tappable summary line that expands into the
 * factor breakdown behind its score.
 *
 * Shared by the stock screener's cross-universe list and the index dashboard's
 * per-instrument card, which is why `kind` exists. Both render the same row —
 * `kind="index"` only drops what an index has no data for (symbol, company
 * name, physical settlement) and adds back the Δ / OI / cushion figures the
 * index's old table used to carry in columns. The stock output is unchanged.
 */
export function CandidateRow({
  c,
  creditPerLot,
  kind = "stock",
  onOpen,
}: {
  c: CandidateRowData;
  creditPerLot: number | null;
  kind?: "stock" | "index";
  /** Opens the instrument ON THIS CANDIDATE'S EXPIRY — see `openInstrument`. */
  onOpen?: (file: string, name: string, expiry?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const band = c.band ?? null;
  // Real-world P(expire OTM) when the builder computed one; otherwise the old
  // risk-neutral 1−|delta|, so pre-upgrade files still render something honest.
  const pKeep = c.pProfit ?? c.probProfit;
  const cushion = c.cushionSigmaF ?? c.cushionSigma;
  const factors = (c.factors ?? []).filter((f) => f.present);
  const isIndex = kind === "index";
  // Narrowed by destructuring rather than asserted — an index candidate has no
  // file or name to open, so there is nothing to navigate to.
  const { file, name, symbol } = c;
  // The expiry travels with the tap. A screener candidate is a specific strike
  // on a specific expiry, and the near and next lists are entirely different
  // trades — opening the stock on its default expiry showed a different strike
  // than the row that was tapped.
  const openInstrument = onOpen && file && name ? () => onOpen(file, name, c.expiry) : null;
  const credit = <>₹{fmt(creditPerLot)}</>;

  return (
    <div className={open ? "rounded-lg bg-white/[0.03] border border-white/[0.07]" : ""}>
      <div className="flex items-center gap-1.5 py-1 px-1 text-[11px]">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-1.5 text-left min-w-0 active:opacity-70"
          aria-label={`Why ${symbol ?? ""} ${c.type} ${c.strike}`}
        >
          {band && (
            <span className={`shrink-0 w-8 text-center text-[10px] font-bold tnum border rounded px-0.5 py-0.5 ${BAND_TONE[band]}`}>
              {c.conviction}
            </span>
          )}
          {symbol && <span className="w-[62px] shrink-0 font-semibold text-white/90 truncate">{symbol}</span>}
          <span className={`shrink-0 tnum ${c.type === "PE" ? "text-emerald-300/90" : "text-rose-300/90"}`}>
            {c.type}
          </span>
          <span className="w-11 shrink-0 tnum text-white/80">{fmt(c.strike)}</span>
          <span className="flex-1 min-w-0 tnum text-white/45 text-right truncate">
            {Math.round(pKeep * 100)}%
            {isIndex ? (
              <>
                {/* Coloured here, unlike the stock list: index edge is negative
                    across the board whenever IV sits under forecast RV, and an
                    uncoloured "−0.6%" reads as neutral when it is the opposite. */}
                {c.edgePct != null && (
                  <>
                    {" · "}
                    <span className={c.edgePct > 0 ? "text-emerald-300/80" : "text-rose-300/80"}>
                      {fmtPct(c.edgePct * 100, 1)}
                    </span>
                  </>
                )}
                {cushion != null ? ` · ${cushion.toFixed(1)}σ` : ""}
              </>
            ) : (
              <>
                {c.edgePct != null ? ` · ${fmtPct(c.edgePct * 100, 1)}` : cushion != null ? ` · ${cushion.toFixed(1)}σ` : ""}
                {c.deliveryRisk ? " ⚠" : ""}
              </>
            )}
          </span>
        </button>
        {openInstrument ? (
          <button
            onClick={openInstrument}
            className="w-[56px] shrink-0 tnum text-white/70 text-right truncate active:opacity-70"
            aria-label={`Open ${symbol}`}
          >
            {credit}
          </button>
        ) : (
          <span className="w-[56px] shrink-0 tnum text-white/70 text-right truncate">{credit}</span>
        )}
      </div>

      {open && (
        <div className="px-2.5 pb-2 space-y-1.5">
          <div className="text-[9px] text-white/50 leading-relaxed">
            {isIndex ? (
              <>
                {/* No expiry or dte here — the index card's header already
                    states them, and repeating them wastes the line. Δ and OI
                    take that space instead, so nothing the old table showed in
                    columns is lost. */}
                IV {c.iv != null ? `${(c.iv * 100).toFixed(1)}%` : "—"}
                {c.delta != null ? ` · Δ ${Math.abs(c.delta).toFixed(2)}` : ""}
                {c.oi != null ? ` · OI ${fmtOi(c.oi)}` : ""}
                {c.fair != null ? ` · fair ₹${c.fair} vs ₹${c.ltp}` : ""}
              </>
            ) : (
              <>
                {name} · {fmtExpiry(c.expiry ?? null)} ({c.dte}d) · IV {c.iv != null ? `${(c.iv * 100).toFixed(1)}%` : "—"}
                {c.vrp != null ? ` · IV/RV ${c.vrp}×` : ""}
                {c.ivRank != null ? ` · IVR ${c.ivRank}` : ""}
                {c.fair != null ? ` · fair ₹${c.fair} vs ₹${c.ltp}` : ""}
              </>
            )}
          </div>

          {factors.length > 0 && (
            <div className="space-y-1">
              {factors.map((f) => (
                <div key={f.key}>
                  <div className="flex justify-between gap-2 text-[10px]">
                    <span className="text-white/70 shrink-0">
                      {f.label}
                      {/* Weight as TEXT, not a mark on the bar. An earlier version
                          drew a tick at `left: weight%`, but the bar's axis is the
                          factor's score — putting weight on it plotted two
                          unrelated quantities on one scale. */}
                      <span className="ml-1 text-white/45 tnum">{Math.round(f.weight * 100)}%</span>
                    </span>
                    <span className="text-white/45 tnum truncate">{f.reading}</span>
                  </div>
                  <div className="relative h-1.5 mt-0.5 rounded-full bg-white/[0.08]">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-sky-400/80"
                      style={{ width: `${Math.round((f.s ?? 0) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              <div className="text-[9px] text-white/45 leading-relaxed pt-0.5">
                Bar = how well this candidate scores on the factor. The % after each
                label is its share of the blend — shares are redistributed when a
                factor has no data, so they always total 100.
              </div>
            </div>
          )}

          {(c.cvar != null || c.tailReliance != null) && (
            <div className="flex items-center justify-between text-[9px] text-white/40 tnum">
              <span>
                {c.cvar != null ? `worst 5%: ₹${c.cvar.toFixed(1)}/sh` : ""}
                {c.worst != null ? ` · worst case ₹${c.worst.toFixed(0)}/sh` : ""}
              </span>
              {c.tailReliance != null && (
                <span className={c.tailReliance > 0.7 ? "text-amber-300/70" : ""}>
                  {Math.round(c.tailReliance * 100)}% tail-priced
                </span>
              )}
            </div>
          )}

          {c.notes?.length ? (
            <div className="text-[9px] text-amber-300/80 leading-relaxed">⚠ {c.notes.join(" · ")}</div>
          ) : null}

          {c.deliveryRisk && (
            <div className="text-[9px] text-amber-300/80 leading-relaxed">
              Physical settlement: an ITM short is assigned into delivery and margin steps up to
              ~40% of contract value in the days before expiry.
            </div>
          )}

          <div className="flex items-center justify-between pt-0.5">
            <span className="text-[9px] text-white/45 tnum">
              OI-adj · risk-neutral {Math.round(c.probProfit * 100)}% vs forecast {Math.round(pKeep * 100)}%
              {c.probTouchF != null ? ` · touch ${Math.round(c.probTouchF * 100)}%` : ""}
            </span>
            {openInstrument && (
              <button
                onClick={openInstrument}
                className="text-[9px] px-2 py-0.5 rounded-full border border-white/20 text-white/70 active:bg-white/[0.08]"
              >
                Open {symbol} →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
