/**
 * Theme-aware colours for the hand-rolled SVG charts.
 *
 * These are `var()` references, not literals: the values live in style.css and
 * swap with `data-theme`, so charts repaint with the rest of the app and never
 * need to know which theme is live. They must be applied via `style={{ … }}`
 * rather than `fill=`/`stroke=` attributes — browsers don't resolve `var()` in
 * SVG presentation attributes.
 */
/** `token` at `a` (0–1) opacity, resolved at paint time so it follows the theme. */
export const mix = (token: string, a: number) =>
  `color-mix(in oklab, ${token} ${+(a * 100).toFixed(2)}%, transparent)`;

/** Blend two theme tokens — `t` (0–1) is how far along `from → to` to land.
 *  Interpolates in sRGB, matching a component-wise lerp of the two hexes. */
export const blend = (from: string, to: string, t: number) =>
  `color-mix(in srgb, ${to} ${+(t * 100).toFixed(2)}%, ${from})`;

export const C = {
  bull: "var(--x-c-bull)",
  bear: "var(--x-c-bear)",
  /** Deeper red used for fills that need to read as bearish under a wash. */
  bearDeep: "var(--x-c-bear-deep)",
  warn: "var(--x-c-warn)",
  info: "var(--x-c-info)",
  /** Expected-move band behind the plot. */
  infoWash: mix("var(--x-c-info-wash)", 0.1),
  proj: "var(--x-c-proj)",
  today: "var(--x-c-today)",
  /** Dial arc mid-point (bearish ← here → bullish). */
  mid: "var(--x-mid)",
  /** OI bars: calls are written against, puts are support. */
  oiCall: "var(--x-c-oi-call)",
  oiPut: "var(--x-c-oi-put)",
  /** Axis rules and tick labels — ink at low alpha, tuned per theme. */
  axis: "var(--x-axis)",
  axisLine: "var(--x-axis-line)",
  gridLine: "var(--x-grid-line)",
  /** Payoff shading opacities (theme-tuned; used as stop-opacity). */
  plStrong: "var(--x-pl-strong)",
  plWeak: "var(--x-pl-weak)",
  /** Halo that lifts a label off the plot marks underneath it. */
  glow: "0 0 4px rgb(var(--x-glow))",
  glowStrong: "0 0 4px rgb(var(--x-glow) / 0.95)",
} as const;
