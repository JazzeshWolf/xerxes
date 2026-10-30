// ---------------------------------------------------------------------------
// Premium Telegram notifications — a separate, louder format for the alerts
// that matter most, so they can't be mistaken for routine NEW / MOVED traffic.
//
// What sets it apart is the format, not the emoji (owner's brief, 2026-10-30):
//   1. a rendered IMAGE CARD (sendPhoto) — routine alerts are text-only
//   2. Telegram's animated message EFFECT on arrival (private chats only)
//   3. inline URL BUTTONS under the message
//   4. the message is PINNED, so it stays on top of the chat
//
// Which contracts qualify as premium is NOT decided yet; for now only the test
// path (`node scripts/premium.mjs --test`, Actions → Send test alert → premium)
// uses this. The card is SVG rendered with @resvg/resvg-js and the bundled
// Inter fonts (scripts/fonts, OFL), so the runner needs no browser and no
// system fonts.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MARGIN_PCT } from "./alerts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ["Inter-Regular.otf", "Inter-SemiBold.otf", "InterDisplay-Bold.otf"].map((f) => resolve(HERE, "fonts", f));
const SCREENER_URL = "https://jazzeshwolf.github.io/xerxes/";
// Telegram's built-in 🔥 effect. Effects only work in private chats; send()
// retries without it if Telegram rejects it.
const FIRE_EFFECT = "5104841245755180586";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inr = (n) => Math.round(n).toLocaleString("en-IN");
const k = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : inr(n));
const strikeTxt = (s) => Number(s).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const dm = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** One premium trade, in the fields the card and caption need. Pure. */
export function premiumFromCandidate(c, { source = "stocks", spot = null, lot = null } = {}) {
  const lotSize = lot ?? (c.creditPerLot && c.ltp ? Math.round(c.creditPerLot / c.ltp) : null);
  // distancePct is |strike − spot| ÷ spot; recover spot when the file isn't at hand.
  const d = (c.distancePct ?? 0) / 100;
  const s = spot ?? (c.type === "CE" ? c.strike / (1 + d) : c.strike / (1 - d));
  const credit = c.creditPerLot ?? (lotSize ? c.ltp * lotSize : null);
  const capital = s && lotSize ? MARGIN_PCT[source] * s * lotSize : null;
  return {
    source, symbol: c.symbol, name: c.name ?? c.symbol, strike: c.strike, type: c.type, expiry: c.expiry,
    dte: c.dte, ltp: c.ltp, lot: lotSize, spot: s, credit, capital,
    rom: credit != null && capital ? (credit / capital) * 100 : null,
    conviction: c.conviction, pop: c.pProfit ?? null, touch: c.probTouchF ?? null,
    cushion: c.cushionSigmaF ?? c.cushionSigma ?? null, distancePct: c.distancePct ?? null,
    iv: c.iv ?? null, forecastIv: c.iv && c.vrp ? c.iv / c.vrp : null, vrp: c.vrp ?? null,
    worst: c.cvar ?? null, oiLots: c.oiLots ?? null, spreadPct: c.spreadPct ?? null,
  };
}

/** The image card, as SVG (1200 × 900). Pure. */
export function premiumCardSvg(p, { label = "", when = "" } = {}) {
  const W = 1200, H = 900;
  const gold = "url(#gold)";
  const ring = (() => {
    const r = 104, cx = 1010, cy = 214, c = 2 * Math.PI * r;
    const f = Math.max(0, Math.min(1, (p.conviction ?? 0) / 100));
    return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1E212B" stroke-width="20"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${gold}" stroke-width="20" stroke-linecap="round"
      stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy + 33}" text-anchor="middle" font-family="Inter Display" font-weight="700" font-size="96" fill="#F6F2E8">${p.conviction ?? "–"}</text>
    <text x="${cx}" y="${cy + r + 52}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="16" letter-spacing="4" fill="#8B909D">CONVICTION</text>`;
  })();
  const tiles = [
    ["CREDIT / LOT", p.credit != null ? `₹${inr(p.credit)}` : "–", p.lot ? `₹${p.ltp} × ${inr(p.lot)}` : ""],
    ["RETURN ON MARGIN", p.rom != null ? `${p.rom.toFixed(1)}%` : "–", p.capital ? `on ₹${k(p.capital)} capital` : ""],
    ["CHANCE OF PROFIT", p.pop != null ? `${Math.round(p.pop * 100)}%` : "–", "expires worthless"],
    ["CUSHION", p.cushion != null ? `${p.cushion.toFixed(2)}σ` : "–", p.distancePct != null ? `${p.distancePct.toFixed(1)}% away` : ""],
  ].map(([lbl, val, sub], i) => {
    const x = 60 + i * 275;
    return `
    <rect x="${x}" y="420" width="255" height="176" rx="24" fill="#12141C" stroke="#232733"/>
    <text x="${x + 26}" y="462" font-family="Inter" font-weight="600" font-size="16" letter-spacing="2.5" fill="#8B909D">${esc(lbl)}</text>
    <text x="${x + 26}" y="534" font-family="Inter Display" font-weight="700" font-size="54" fill="#F6F2E8">${esc(val)}</text>
    <text x="${x + 26}" y="572" font-family="Inter" font-size="19" fill="#8B909D">${esc(sub)}</text>`;
  }).join("");
  const pop = p.pop ?? 0;
  const barW = 1080;
  const worstLine = p.worst != null
    ? `−₹${Math.abs(p.worst).toFixed(1)}/share${p.lot ? `  (−₹${k(Math.abs(p.worst) * p.lot)}/lot)` : ""}` : "–";
  const liq = [p.oiLots != null ? `${inr(p.oiLots)} lots OI` : null, p.spreadPct != null ? `${(p.spreadPct * 100).toFixed(1)}% spread` : null]
    .filter(Boolean).join(" · ") || "–";
  const action = `SELL ${strikeTxt(p.strike)} ${p.type}`;
  const actionW = 40 + action.length * 23;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FBE29A"/><stop offset="0.55" stop-color="#E2B552"/><stop offset="1" stop-color="#B07F22"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.86" cy="0.12" r="0.75">
      <stop offset="0" stop-color="#E2B552" stop-opacity="0.22"/><stop offset="0.6" stop-color="#E2B552" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="keep" x1="0" x2="1"><stop offset="0" stop-color="#2FBF8A"/><stop offset="1" stop-color="#5BE3B0"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#08090D"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="34" fill="none" stroke="${gold}" stroke-width="3"/>

  <text x="60" y="92" font-family="Inter" font-weight="600" font-size="22" letter-spacing="9" fill="${gold}">XERXES PREMIUM</text>
  <rect x="60" y="108" width="64" height="3" rx="1.5" fill="${gold}"/>
  ${label ? `<rect x="${W - 60 - (34 + label.length * 13)}" y="62" width="${34 + label.length * 13}" height="40" rx="20" fill="none" stroke="#E2B552" stroke-opacity="0.7"/>
  <text x="${W - 60 - (34 + label.length * 13) / 2}" y="89" text-anchor="middle" font-family="Inter" font-weight="600" font-size="17" letter-spacing="3" fill="#E2B552">${esc(label)}</text>` : ""}

  <text x="56" y="232" font-family="Inter Display" font-weight="700" font-size="128" fill="#F6F2E8">${esc(p.symbol)}</text>
  <text x="62" y="280" font-family="Inter" font-size="28" fill="#8B909D">${p.name && p.name !== p.symbol ? esc(p.name) : p.source === "indices" ? "Index option" : "Stock option"}</text>
  <rect x="60" y="306" width="${actionW}" height="64" rx="32" fill="${gold}"/>
  <text x="${60 + actionW / 2}" y="349" text-anchor="middle" font-family="Inter Display" font-weight="700" font-size="34" fill="#0B0B0F">${esc(action)}</text>
  <text x="${80 + actionW}" y="349" font-family="Inter" font-weight="600" font-size="28" fill="#D9D4C7">${esc(dm(p.expiry))}${p.dte != null ? `  ·  ${p.dte} days left` : ""}</text>
  ${ring}
  ${tiles}

  <text x="60" y="660" font-family="Inter" font-weight="600" font-size="16" letter-spacing="2.5" fill="#8B909D">MODEL ODDS TO EXPIRY</text>
  <rect x="60" y="676" width="${barW}" height="18" rx="9" fill="#3A1F24"/>
  <rect x="60" y="676" width="${(barW * pop).toFixed(1)}" height="18" rx="9" fill="url(#keep)"/>
  <text x="60" y="728" font-family="Inter" font-weight="600" font-size="21" fill="#5BE3B0">Keeps the premium ${Math.round(pop * 100)}%</text>
  <text x="${60 + barW}" y="728" text-anchor="end" font-family="Inter" font-size="21" fill="#C98A93">Strike touched before expiry ${p.touch != null ? Math.round(p.touch * 100) + "%" : "–"}</text>

  <rect x="60" y="760" width="${barW}" height="1" fill="#232733"/>
  <text x="60" y="806" font-family="Inter" font-size="21" fill="#8B909D">Worst 5%  <tspan fill="#F6F2E8" font-weight="600">${esc(worstLine)}</tspan></text>
  <text x="${60 + barW}" y="806" text-anchor="end" font-family="Inter" font-size="21" fill="#8B909D">Liquidity  <tspan fill="#F6F2E8" font-weight="600">${esc(liq)}</tspan></text>
  <text x="60" y="852" font-family="Inter" font-size="17" fill="#5C616D">Model estimates, not advice${when ? `  ·  ${esc(when)}` : ""}</text>
</svg>`;
}

/** SVG → PNG bytes. resvg is loaded lazily so importing this file costs nothing. */
export async function renderPng(svg) {
  const { Resvg } = await import("@resvg/resvg-js");
  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng();
}

/** Caption under the card (Telegram caps captions at 1024 chars). Pure. */
export function premiumCaption(p, { test = false } = {}) {
  const lines = [
    `<b>XERXES PREMIUM</b>${test ? "  ·  <i>test of the new format, sample trade</i>" : ""}`,
    "",
    `<blockquote><b>Sell ${esc(p.symbol)} ${strikeTxt(p.strike)} ${p.type} · ${dm(p.expiry)}</b>\n` +
      `₹${p.ltp} × ${p.lot ? inr(p.lot) : "–"} = <b>₹${p.credit != null ? inr(p.credit) : "–"}</b> credit per lot</blockquote>`,
    "",
    "<b>Why it stands out</b>",
    `<blockquote expandable>Conviction ${p.conviction ?? "–"} · ROM ${p.rom != null ? p.rom.toFixed(1) + "%" : "–"} · POP ${p.pop != null ? Math.round(p.pop * 100) + "%" : "–"}\n` +
      (p.iv != null && p.forecastIv != null
        ? `IV ${(p.iv * 100).toFixed(0)}% vs forecast ${(p.forecastIv * 100).toFixed(0)}% (${p.vrp.toFixed(2)}×)\n` : "") +
      (p.cushion != null
        ? `${p.cushion.toFixed(2)}σ cushion: the ${p.symbol} price has to ${p.type === "CE" ? "rise" : "fall"} ${p.distancePct?.toFixed(1)}% to reach the strike\n` : "") +
      `Liquidity: ${p.oiLots != null ? inr(p.oiLots) + " lots OI" : "–"}${p.spreadPct != null ? `, ${(p.spreadPct * 100).toFixed(1)}% bid/ask spread` : ""}</blockquote>`,
    p.worst != null ? `<b>Risk</b>  worst 5%: −₹${Math.abs(p.worst).toFixed(1)}/share${p.lot ? ` (−₹${k(Math.abs(p.worst) * p.lot)}/lot)` : ""}` : "",
  ];
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n").trim();
}

/** Inline URL buttons under the card. Pure. */
export function premiumButtons(p) {
  const chain = p.source === "stocks"
    ? `https://www.nseindia.com/get-quotes/derivatives?symbol=${encodeURIComponent(p.symbol)}`
    : "https://www.nseindia.com/option-chain";
  return { inline_keyboard: [[{ text: "Open in Xerxes", url: SCREENER_URL }, { text: "NSE option chain", url: chain }]] };
}

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description ?? res.status}`);
  return j.result;
}

/** Card + caption + buttons + effect, then pin. Pin failure is a warning only. */
export async function sendPremium(p, { test = false, when = "" } = {}) {
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!process.env.TELEGRAM_BOT_TOKEN || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const png = await renderPng(premiumCardSvg(p, { label: test ? "TEST" : "", when }));
  const form = (effect) => {
    const f = new FormData();
    f.set("chat_id", chat);
    f.set("photo", new Blob([png], { type: "image/png" }), "xerxes-premium.png");
    f.set("caption", premiumCaption(p, { test }));
    f.set("parse_mode", "HTML");
    f.set("reply_markup", JSON.stringify(premiumButtons(p)));
    if (effect) f.set("message_effect_id", effect);
    return f;
  };
  let msg;
  try {
    msg = await tg("sendPhoto", form(FIRE_EFFECT));
  } catch (e) {
    if (!/effect/i.test(e.message)) throw e;
    console.log(`message effect rejected (${e.message}); sending without it`);
    msg = await tg("sendPhoto", form(null));
  }
  try {
    await tg("pinChatMessage", { chat_id: chat, message_id: msg.message_id, disable_notification: true });
  } catch (e) {
    console.log(`::warning::premium sent but not pinned: ${e.message}`);
  }
  return msg;
}

/** A fixed sample, used when the live candidates file can't be fetched. */
const SAMPLE = {
  symbol: "RVNL", name: "Rail Vikas Nigam", strike: 200, type: "CE", expiry: "2026-11-23", dte: 24, ltp: 1.68,
  creditPerLot: 3234, conviction: 65, pProfit: 0.923, probTouchF: 0.174, cushionSigmaF: 1.44, distancePct: 11.32,
  iv: 0.3906, vrp: 1.21, cvar: -9.51, oiLots: 857, spreadPct: 0.018,
};

async function main() {
  if (!process.argv.includes("--test")) {
    console.error("usage: node scripts/premium.mjs --test");
    process.exit(2);
  }
  // The test card uses the screener's current #1 stock idea so the layout is
  // judged on real numbers; it is labelled TEST and is not a signal.
  let c = SAMPLE;
  try {
    const res = await fetch("https://raw.githubusercontent.com/JazzeshWolf/xerxes/stocks-data/candidates.json");
    const j = await res.json();
    const all = (j.expiries ?? []).flatMap((e) => e.candidates ?? []);
    if (all.length) c = all.reduce((a, b) => (b.conviction > a.conviction ? b : a));
  } catch (e) {
    console.log(`live candidates unavailable (${e.message}); using the built-in sample`);
  }
  const when = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " IST";
  const msg = await sendPremium(premiumFromCandidate(c), { test: true, when });
  console.log(`premium test sent: ${c.symbol} ${c.strike} ${c.type} ${c.expiry} (message ${msg.message_id})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
