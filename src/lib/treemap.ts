// ---------------------------------------------------------------------------
// Squarified treemap layout (Bruls, Huizing & van Wijk, 2000) for the stock
// Outlook's sector heat map.
//
// Pure: values in, rectangles out, in whatever units the caller's box uses.
// The heat map lays out in a box with the card's aspect ratio and renders the
// result as percentages, so nothing has to measure the DOM.
// ---------------------------------------------------------------------------

export interface TreemapItem {
  key: string;
  value: number;
}

export interface TreemapRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst aspect ratio in a row laid along a side of length `side`. */
function worst(row: number[], side: number): number {
  const sum = row.reduce((a, v) => a + v, 0);
  if (sum <= 0 || side <= 0) return Infinity;
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Lay `items` out in a `width × height` box. Areas are proportional to
 * `value`; items with a non-positive or non-finite value are dropped. Output
 * order is largest first, which is also the reading order of the map.
 */
export function squarify(items: TreemapItem[], width: number, height: number): TreemapRect[] {
  const valid = items.filter((i) => Number.isFinite(i.value) && i.value > 0).sort((a, b) => b.value - a.value);
  const total = valid.reduce((a, i) => a + i.value, 0);
  if (!valid.length || !(width > 0) || !(height > 0)) return [];
  // Scale values to areas so the rows fill the box exactly.
  const scale = (width * height) / total;
  const areas = valid.map((i) => i.value * scale);

  const out: TreemapRect[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let i = 0;
  while (i < areas.length) {
    // Lay rows along the shorter side of what's left.
    const side = Math.min(w, h);
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) {
      row.push(areas[j]);
      j++;
    }
    const rowSum = row.reduce((a, v) => a + v, 0);
    if (w >= h) {
      // Column on the left, items stacked top to bottom.
      const colW = rowSum / h;
      let cy = y;
      row.forEach((a, k) => {
        const ih = a / colW;
        out.push({ key: valid[i + k].key, x, y: cy, w: colW, h: ih });
        cy += ih;
      });
      x += colW;
      w -= colW;
    } else {
      // Row along the top, items left to right.
      const rowH = rowSum / w;
      let cx = x;
      row.forEach((a, k) => {
        const iw = a / rowH;
        out.push({ key: valid[i + k].key, x: cx, y, w: iw, h: rowH });
        cx += iw;
      });
      y += rowH;
      h -= rowH;
    }
    i = j;
  }
  return out;
}

/**
 * Tile sizes for a sector: each name's average daily traded value. A name with
 * none yet (new listing, or an index.json published before the field existed)
 * gets the sector median so it still shows; if nobody has one, all tiles are
 * equal. `sized` says which of the two happened, for the legend.
 */
export function tileValues(rows: { key: string; adv?: number | null }[]): { items: TreemapItem[]; sized: boolean } {
  const known = rows.map((r) => r.adv).filter((v): v is number => v != null && Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!known.length) return { items: rows.map((r) => ({ key: r.key, value: 1 })), sized: false };
  const m = known.length >> 1;
  const median = known.length % 2 ? known[m] : (known[m - 1] + known[m]) / 2;
  return {
    items: rows.map((r) => ({ key: r.key, value: r.adv != null && r.adv > 0 ? r.adv : median })),
    sized: true,
  };
}
