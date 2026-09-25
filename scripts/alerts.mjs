// ---------------------------------------------------------------------------
// Telegram conviction alerts.
//
// Runs at the end of stocks.yml (source "stocks") and data.yml (source
// "indices"). Each run compares the fresh snapshot against the tracked set in
// the `alerts-state` branch and sends ONE Telegram message with everything that
// changed:
//
//   NEW      crossed the threshold (stocks >= 70, indices >= 60)
//   MOVED    tracked, still above, score changed
//   DROPPED  tracked, fell below the threshold → untracked
//   LEFT     tracked, no longer scored at all → untracked
//
// Every message notifies with sound — the owner asked for no silent messages,
// score moves included.
//
// Entry is gated on the DISPLAYED list only (stocks: candidates.json top 24 per
// expiry; indices: each expiry's candidate list). Once tracked, a stock is
// followed through its own file, which scores more strikes than the cross-
// universe list shows, so leaving the top 24 does not end tracking by itself.
//
// Delivery is at-least-once: state is written only after Telegram accepts the
// message, so a failed send is retried by the next run instead of vanishing.
// A missing state file "arms" instead: one message listing what is
// already above the bar, so switching alerts on neither floods nor hides it.
//
// The pure pieces (collect*, diff, format*, isMonthly) are unit-tested in
// alerts.test.mjs; main() is the thin I/O shell around them.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_THRESHOLDS = { stocks: 70, indices: 60 };
const SCREENER_URL = "https://jazzeshwolf.github.io/xerxes/";
const TG_LIMIT = 3900; // Telegram caps a message at 4096 chars; leave headroom.
const INDEX_FILES = { nifty: "NIFTY", banknifty: "BANKNIFTY", sensex: "SENSEX" };
// The heartbeat goes out on the first stock run at or after the close.
const CLOSE_IST_MINUTES = 15 * 60 + 30;

// --- time helpers ---------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export const istDate = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
export const istTime = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
const istMinutes = (d) => {
  const [h, m] = istTime(d).split(":").map(Number);
  return h * 60 + m;
};

/** Monthly = the LAST listed expiry of its month, and in the month's final 9
 *  days. Neither half works alone:
 *   - by date only, a weekly can sit 8 days from month end (NIFTY 22 Sep, a week
 *     before the 29 Sep monthly) while a holiday pulls a monthly back to the
 *     same distance (NIFTY Nov 2026: Tue 24 → Mon 23);
 *   - by list only, a truncated list could end the month on a weekly.
 *  The builder always keeps the monthlies, so "last listed in the month" is
 *  reliable, and the date window guards the truncation case. */
export function isMonthly(date, listed = [date]) {
  const [y, m, d] = date.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const laterSameMonth = listed.some((x) => x.slice(0, 7) === date.slice(0, 7) && x > date);
  return !laterSameMonth && d > daysInMonth - 9;
}

const key = (sym, expiry, strike, type) => `${sym}|${expiry}|${strike}|${type}`;

// --- collecting the current snapshot --------------------------------------

/**
 * Stocks. `candidates` is candidates.json; `stockFiles` maps file slug → that
 * stock's JSON. Returns every scored strike, flagging which ones are on the
 * displayed list (the only ones allowed to START tracking), plus the set of
 * symbols whose file was refreshed after `sinceAsOf`.
 */
export function collectStocks(candidates, stockFiles, sinceAsOf = null) {
  const rows = new Map();
  const fresh = new Set();
  for (const [slug, f] of Object.entries(stockFiles)) {
    if (!f || f.stale) continue;
    const sym = f.index ?? slug;
    if (!sinceAsOf || (f.asOf && f.asOf > sinceAsOf)) fresh.add(sym);
    for (const e of Object.values(f.expiries ?? {})) {
      for (const c of e.candidates ?? []) {
        if (c.conviction == null) continue;
        rows.set(key(sym, e.date, c.strike, c.type), {
          source: "stocks", symbol: sym, name: f.name, expiry: e.date, dte: e.dte,
          strike: c.strike, type: c.type, conviction: c.conviction, ltp: c.ltp,
          lot: f.lotSize, credit: Math.round(c.ltp * f.lotSize), kind: "Monthly", displayed: false,
        });
      }
    }
  }
  for (const block of candidates?.expiries ?? []) {
    for (const c of block.candidates ?? []) {
      const k = key(c.symbol, c.expiry, c.strike, c.type);
      const lot = c.creditPerLot && c.ltp ? Math.round(c.creditPerLot / c.ltp) : rows.get(k)?.lot;
      rows.set(k, {
        ...(rows.get(k) ?? {}),
        source: "stocks", symbol: c.symbol, name: c.name, expiry: c.expiry, dte: c.dte,
        strike: c.strike, type: c.type, conviction: c.conviction, ltp: c.ltp,
        lot, credit: c.creditPerLot ?? Math.round(c.ltp * (lot ?? 0)), kind: "Monthly",
        displayed: true, slot: block.slot,
      });
      fresh.add(c.symbol);
    }
  }
  return { rows, isFresh: (t) => fresh.has(t.symbol) };
}

/**
 * Indices. `indexFiles` maps NIFTY/BANKNIFTY/SENSEX → snapshot JSON. An index
 * counts as fresh only when its asOf moved past the one this state last saw, so
 * a failed build (which leaves the old committed file in place) raises nothing.
 */
export function collectIndices(indexFiles, lastAsOf = {}) {
  const rows = new Map();
  const fresh = new Set();
  const asOf = {};
  for (const [sym, f] of Object.entries(indexFiles)) {
    if (!f || f.stale || !f.asOf) continue;
    asOf[sym] = f.asOf;
    if (!lastAsOf[sym] || f.asOf > lastAsOf[sym]) fresh.add(sym);
    const listed = Object.values(f.expiries ?? {}).map((e) => e.date);
    for (const e of Object.values(f.expiries ?? {})) {
      for (const c of e.candidates ?? []) {
        if (c.conviction == null) continue;
        rows.set(key(sym, e.date, c.strike, c.type), {
          source: "indices", symbol: sym, name: f.name, expiry: e.date, dte: e.dte,
          strike: c.strike, type: c.type, conviction: c.conviction, ltp: c.ltp,
          lot: f.lotSize, credit: Math.round(c.ltp * f.lotSize),
          kind: isMonthly(e.date, listed) ? "Monthly" : "Weekly", displayed: true,
        });
      }
    }
  }
  return { rows, isFresh: (t) => fresh.has(t.symbol), asOf, anyFresh: fresh.size > 0 };
}

// --- the diff ---------------------------------------------------------------

const snapshotOf = (r) => ({
  source: r.source, symbol: r.symbol, name: r.name, expiry: r.expiry, strike: r.strike, type: r.type,
  conviction: r.conviction, ltp: r.ltp, lot: r.lot, kind: r.kind,
});

/**
 * Compare tracked state with the current rows. Pure: returns the events and
 * the next tracked map, never mutates its inputs.
 */
export function diff(tracked, current, { threshold, today, isFresh }) {
  const next = {};
  const events = [];
  for (const [k, t] of Object.entries(tracked)) {
    if (t.expiry < today) continue; // expired: drop quietly
    if (!isFresh(t)) {
      next[k] = t; // no fresh data for this name this run — hold, say nothing
      continue;
    }
    const r = current.get(k);
    if (!r) {
      events.push({ kind: "LEFT", from: t.conviction, row: t, expiring: t.expiry === today });
    } else if (r.conviction < threshold) {
      events.push({ kind: "DROPPED", from: t.conviction, row: r });
    } else {
      if (r.conviction !== t.conviction) events.push({ kind: "MOVED", from: t.conviction, row: r });
      next[k] = snapshotOf(r);
    }
  }
  for (const [k, r] of current) {
    if (k in tracked || !r.displayed || r.conviction < threshold || r.expiry < today) continue;
    // A contract that just dropped out this run is not re-entered in the same run.
    if (events.some((e) => key(e.row.symbol, e.row.expiry, e.row.strike, e.row.type) === k)) continue;
    events.push({ kind: "NEW", row: r });
    next[k] = snapshotOf(r);
  }
  const order = { NEW: 0, DROPPED: 1, LEFT: 2, MOVED: 3 };
  events.sort((a, b) => order[a.kind] - order[b.kind] || b.row.conviction - a.row.conviction);
  return { events, tracked: next };
}

// --- formatting -------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dm = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

export function tierMark(source, conv) {
  if (source !== "stocks") return "";
  return conv >= 80 ? "🔥" : conv >= 75 ? "⭐" : "";
}

// Telegram has no table markup, so each section is a <pre> block with padded
// columns: monospace keeps them aligned. Rows are kept to ~34 characters so
// they fit a phone held upright without wrapping, which would break the
// alignment. Emoji go only at a row's END, where their double width can't
// shift a later column.

const ROWS_PER_BLOCK = 30;

/** Render rows as an aligned monospace table. `align` is "l"/"r" per column. */
export function table(head, rows, align) {
  const all = [head, ...rows.filter((r) => r.cells).map((r) => r.cells)];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const fmt = (cells) =>
    cells.map((c, i) => (align[i] === "r" ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join(" ").trimEnd();
  return [fmt(head), ...rows.map((r) => {
    if (r.divider) return r.divider;
    return fmt(r.cells) + (r.mark ? " " + r.mark : "");
  })].join("\n");
}

const num = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-IN") : Number(n).toFixed(2));
const lakh = (n) => Math.round(n).toLocaleString("en-IN");
const ctr = (r) => `${r.symbol} ${r.strike}${r.type}`;
const expiryLabel = (r) => `${dm(r.expiry)}${r.source === "indices" ? ` · ${r.kind.toLowerCase()}` : ""}`;

/** Rows grouped under a "── 27 Oct · monthly ──" divider per expiry. */
function grouped(events, cells) {
  const byExp = new Map();
  for (const e of events) {
    const k = expiryLabel(e.row);
    if (!byExp.has(k)) byExp.set(k, []);
    byExp.get(k).push(e);
  }
  const rows = [];
  for (const [label, evs] of [...byExp].sort((x, y) => x[1][0].row.expiry.localeCompare(y[1][0].row.expiry))) {
    rows.push({ divider: `── ${label} ──` });
    for (const e of evs) rows.push(cells(e));
  }
  return rows;
}

function sections(events, threshold) {
  const pick = (...kinds) => events.filter((e) => kinds.includes(e.kind));
  const out = [];
  const add = (title, head, align, rows) => {
    if (!rows.length) return;
    // Long sections become several <pre> blocks so a message split never
    // lands inside one.
    for (let i = 0; i < rows.length; i += ROWS_PER_BLOCK) {
      const part = rows.slice(i, i + ROWS_PER_BLOCK);
      out.push(`${i === 0 ? title : title + " (cont.)"}\n<pre>${esc(table(head, part, align))}</pre>`);
    }
  };
  const nw = pick("NEW");
  add(`🔔 <b>NEW</b> (${nw.length})`, ["Contract", "Conv", "Prem", "₹/lot"], ["l", "r", "r", "r"],
    grouped(nw, (e) => ({ cells: [ctr(e.row), e.row.conviction, num(e.row.ltp), lakh(e.row.credit)], mark: tierMark(e.row.source, e.row.conviction) })));
  const mv = pick("MOVED");
  add(`↕️ <b>MOVED</b> (${mv.length})`, ["Contract", "Was", "Now", "Prem"], ["l", "r", "r", "r"],
    grouped(mv, (e) => ({ cells: [ctr(e.row), e.from, e.row.conviction, num(e.row.ltp)], mark: e.row.conviction > e.from ? "⬆️" : "⬇️" })));
  const ex = pick("DROPPED", "LEFT");
  add(`🔻 <b>NO LONGER TRACKED</b> (${ex.length})`, ["Contract", "Was", "Now", "Why"], ["l", "r", "r", "l"],
    grouped(ex, (e) => ({ cells: [ctr(e.row), e.from, e.kind === "DROPPED" ? e.row.conviction : "–",
      e.kind === "DROPPED" ? `<${threshold}` : e.expiring ? "expiry" : "off list"] })));
  return out;
}

/** One message per run (split only if Telegram's length cap forces it). */
export function formatMessages(events, { source, threshold, when, armed = false }) {
  if (!events.length && !armed) return [];
  const label = source === "stocks" ? `Stocks ≥ ${threshold}` : `Indices ≥ ${threshold}`;
  const header = [`<b>Xerxes · ${label}</b> · ${when} IST`];
  if (armed)
    header.push(events.length
      ? `✅ Alerts armed. Already above the bar and now tracked (${events.length}):`
      : "✅ Alerts armed. Nothing above the bar right now.");
  if (source === "indices" && events.some((e) => e.kind === "NEW"))
    header.push("<i>⚠ Index 60+ tier: few settled results so far, still unproven</i>");
  if (source === "stocks" && events.some((e) => e.kind === "NEW" && e.row.conviction >= 75))
    header.push("<i>⭐ 75+   🔥 80+</i>");
  const footer = `<a href="${SCREENER_URL}">Open screener</a>`;
  const out = [];
  let cur = header.join("\n");
  for (const block of sections(events, threshold)) {
    if (cur.length + block.length + footer.length + 4 > TG_LIMIT) {
      out.push(cur.trimEnd());
      cur = header[0] + " (cont.)";
    }
    cur += "\n\n" + block;
  }
  out.push(cur.trimEnd() + "\n\n" + footer);
  return out;
}

export function formatHeartbeat(stocksState, indicesState, today) {
  const row = (label, s) => {
    const d = s?.day?.date === today ? s.day : { runs: 0, NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 };
    return { cells: [label, d.runs, d.NEW, d.MOVED, d.DROPPED + d.LEFT, Object.keys(s?.tracked ?? {}).length] };
  };
  const last = (s) => (s?.day?.date === today && s.lastRunAt ? istTime(new Date(s.lastRunAt)) : "—");
  const s = stocksState?.day?.date === today ? stocksState.day.runs : 0;
  const i = indicesState?.day?.date === today ? indicesState.day.runs : 0;
  const ok = s > 0 && i > 0;
  const t = table(["", "Runs", "New", "Moves", "Exits", "Now"], [row("Stocks", stocksState), row("Indices", indicesState)],
    ["l", "r", "r", "r", "r", "r"]);
  return [
    `${ok ? "✓" : "⚠️"} <b>Xerxes alerts · end of day ${dm(today)}</b>`,
    `<pre>${esc(t)}</pre>`,
    `Last run: stocks ${last(stocksState)} · indices ${last(indicesState)} IST`,
    ok ? "" : "\nOne feed ran zero times today — check cron-job.org and the Actions tab.",
  ].join("\n").trimEnd();
}

// --- state bookkeeping ------------------------------------------------------

export function bumpDay(state, events, today, nowIso) {
  const day = state.day?.date === today ? { ...state.day } : { date: today, runs: 0, NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 };
  day.runs += 1;
  for (const e of events) day[e.kind] += 1;
  return { ...state, day, lastRunAt: nowIso };
}

/** Invented sample for `--mock`: three stocks (71, 76, 72) and three index
 *  options (60, 63, 65) crossing the bar. */
export function mockEvents() {
  const stock = (symbol, strike, type, conviction, ltp, lot) => ({ kind: "NEW", row: {
    source: "stocks", symbol, expiry: "2026-10-27", strike, type, conviction, ltp, lot,
    credit: Math.round(ltp * lot), kind: "Monthly" } });
  const index = (symbol, expiry, strike, type, conviction, ltp, lot, kind) => ({ kind: "NEW", row: {
    source: "indices", symbol, expiry, strike, type, conviction, ltp, lot,
    credit: Math.round(ltp * lot), kind } });
  return [
    ["stocks", 70, [
      stock("WIPRO", 190, "CE", 71, 1.09, 3000),
      stock("IEX", 125, "CE", 76, 1.32, 4350),
      stock("BANKBARODA", 250, "CE", 72, 2.5, 2925),
    ].sort((a, b) => b.row.conviction - a.row.conviction)],
    ["indices", 60, [
      index("NIFTY", "2026-10-27", 21600, "PE", 65, 48.7, 65, "Monthly"),
      index("SENSEX", "2026-10-01", 76000, "CE", 63, 250, 20, "Weekly"),
      index("BANKNIFTY", "2026-10-27", 52000, "PE", 60, 112.4, 30, "Monthly"),
    ]],
  ];
}

// --- I/O --------------------------------------------------------------------

async function sendTelegram(text) {
  if (process.env.ALERTS_DRY_RUN === "1") {
    console.log(`--- message ---\n${text}\n`);
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat, text, parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  // Never echo the URL: it carries the token, and Actions logs on a public
  // repo are public.
  if (!res.ok || !body.ok) throw new Error(`Telegram rejected the message: ${res.status} ${body.description ?? ""}`);
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const dry = process.env.ALERTS_DRY_RUN === "1";
  if (!dry && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    console.log("::warning::TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alerts skipped.");
    return;
  }
  if (process.argv.includes("--mock")) {
    // Rendered by the real formatter so the owner sees exactly what a live
    // alert looks and sounds like. Contracts and prices are invented.
    const when = istTime(new Date());
    for (const [source, threshold, events] of mockEvents()) {
      const [m] = formatMessages(events, { source, threshold, when });
      await sendTelegram("🧪 <b>MOCK ALERT (test only, not real)</b>\n\n" + m);
    }
    console.log("Mock alerts sent.");
    return;
  }
  if (process.argv.includes("--test")) {
    await sendTelegram("✅ <b>Xerxes alerts connected</b>\nThis chat will receive conviction alerts.");
    console.log("Test message sent.");
    return;
  }

  const source = arg("source");
  const stateDir = arg("state-dir", "_alerts");
  if (!["stocks", "indices"].includes(source)) throw new Error("--source must be stocks or indices");
  const envMin = Number(process.env[source === "stocks" ? "ALERT_MIN_CONV_STOCK" : "ALERT_MIN_CONV_INDEX"]);
  const threshold = Number.isFinite(envMin) && envMin > 0 ? envMin : DEFAULT_THRESHOLDS[source];

  const now = process.env.ALERTS_NOW ? new Date(process.env.ALERTS_NOW) : new Date();
  const today = istDate(now);
  const statePath = resolve(stateDir, `${source}.json`);
  const prev = readJson(statePath);

  let collected;
  let asOfUpdate;
  if (source === "stocks") {
    const dir = arg("data", "public/data/stocks");
    const candidates = readJson(resolve(dir, "candidates.json"));
    const index = readJson(resolve(dir, "index.json"));
    if (!candidates || !index) throw new Error(`no candidates.json/index.json under ${dir}`);
    const files = {};
    for (const s of index.stocks ?? index.rows ?? []) {
      const slug = s.file ?? s.symbol;
      if (slug) files[slug] = readJson(resolve(dir, `${slug}.json`));
    }
    collected = collectStocks(candidates, files, prev?.lastAsOf ?? null);
    asOfUpdate = index.asOf;
    if (prev?.lastAsOf && index.asOf <= prev.lastAsOf) {
      console.log(`Stocks asOf ${index.asOf} not newer than last alert run — nothing to do.`);
      return;
    }
  } else {
    const dir = arg("data", "public/data");
    const files = {};
    for (const [f, sym] of Object.entries(INDEX_FILES)) files[sym] = readJson(resolve(dir, `${f}.json`));
    collected = collectIndices(files, prev?.lastAsOf ?? {});
    if (!collected.anyFresh) {
      console.log("No index snapshot newer than the last alert run — nothing to do.");
      return;
    }
    asOfUpdate = { ...(prev?.lastAsOf ?? {}), ...collected.asOf };
  }

  const { events, tracked } = diff(prev?.tracked ?? {}, collected.rows, {
    threshold, today, isFresh: collected.isFresh,
  });

  let state = { version: 1, ...(prev ?? {}), tracked, lastAsOf: asOfUpdate };
  if (!prev) {
    // First ever run: announce the starting set in ONE message rather
    // than a loud NEW per contract, so switching alerts on never floods — but
    // nothing already above the bar is swallowed either.
    const msgs = formatMessages(events, { source, threshold, when: istTime(now), armed: true });
    for (const m of msgs) await sendTelegram(m);
    console.log(`First run for ${source}: armed, tracking ${Object.keys(tracked).length} contracts at ≥ ${threshold}.`);
    state = bumpDay(state, [], today, now.toISOString());
  } else {
    const msgs = formatMessages(events, { source, threshold, when: istTime(now) });
    for (const m of msgs) await sendTelegram(m);
    const tally = events.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
    console.log(`${source}: ${events.length} events ${JSON.stringify(tally)}, ${Object.keys(tracked).length} tracked, ${msgs.length} message(s) sent.`);
    state = bumpDay(state, events, today, now.toISOString());
  }

  // End-of-day heartbeat, piggybacking on the stock job so it runs on the real
  // scheduler (cron-job.org) rather than GitHub's unreliable cron. If the
  // stock job stops, the heartbeat stops too — which is the signal.
  if (source === "stocks" && istMinutes(now) >= CLOSE_IST_MINUTES && state.heartbeatDate !== today) {
    const indicesState = readJson(resolve(stateDir, "indices.json"));
    await sendTelegram(formatHeartbeat(state, indicesState, today));
    state.heartbeatDate = today;
    console.log("Heartbeat sent.");
  }

  writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
