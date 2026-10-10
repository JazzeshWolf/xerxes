import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "./index.js";

// The live /news route is what the stock News tab's "Fetch latest news" button
// calls. These tests stub the network: Google News answers with one relevant
// and one unrelated headline, NSE refuses (as it usually does from a cloud IP).
const RSS = `<rss><channel>
<item><title>BHEL bags Rs 2,000 crore order from NTPC - Moneycontrol</title><link>https://example.com/a</link>
<pubDate>${new Date(Date.now() - 3600e3).toUTCString()}</pubDate><description>BHEL shares rise</description><source url="https://moneycontrol.com">Moneycontrol</source></item>
<item><title>Sensex ends flat - Mint</title><link>https://example.com/b</link>
<pubDate>${new Date(Date.now() - 3600e3).toUTCString()}</pubDate><description>markets</description><source url="https://livemint.com">Mint</source></item>
</channel></rss>`;

function stubNetwork() {
  const fetchMock = vi.fn(async (url) => {
    const u = String(url);
    if (u.startsWith("https://news.google.com/")) return new Response(RSS, { status: 200 });
    return new Response("blocked", { status: 403 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const env = { ALLOW_ORIGIN: "https://jazzeshwolf.github.io" };

describe("worker /news", () => {
  it("returns the company's live headlines without any GitHub token", async () => {
    const fetchMock = stubNetwork();
    const res = await worker.fetch(new Request("https://w.example/news?symbol=bhel"), env, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOW_ORIGIN);
    const j = await res.json();
    expect(j.symbol).toBe("BHEL");
    // The relevance guard runs here exactly as in the build: Sensex chatter is dropped.
    expect(j.news.map((n) => n.title)).toEqual(["BHEL bags Rs 2,000 crore order from NTPC"]);
    expect(j.news[0].trusted).toBe(true);
    // NSE refused, and the response says so rather than claiming "no events".
    expect(j.nseOk).toBe(false);
    expect(Date.parse(j.newsAsOf)).toBeGreaterThan(Date.now() - 60e3);
    // Nothing went to GitHub.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("api.github.com"))).toBe(false);
  });

  it("rejects symbols outside the universe instead of querying for them", async () => {
    const fetchMock = stubNetwork();
    const res = await worker.fetch(new Request("https://w.example/news?symbol=NOTASTOCK"), env, {});
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
