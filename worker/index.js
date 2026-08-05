// ---------------------------------------------------------------------------
// Xerxes stock-refresh proxy — a tiny Cloudflare Worker (free tier).
//
// The site is static (GitHub Pages) and the Upstox token lives only in GitHub
// Actions, so the browser can't recompute a stock on its own. This Worker is the
// one small piece of glue that lets the page do an on-demand refresh:
//
//   POST /refresh?symbol=INDIGO  → fires the `stocks.yml` workflow for that one
//                                  symbol (rebuilds it in ~30–60s).
//   GET  /data?file=INDIGO       → returns that stock's freshly-published JSON,
//                                  read via the GitHub Contents API (authenticated,
//                                  always fresh — sidesteps raw.githubusercontent's
//                                  ~5-min CDN cache, which query strings don't bust).
//
// It holds a fine-grained GitHub PAT (this repo only: Actions read/write,
// Contents read) as the `GH_PAT` secret. Nothing else is exposed. Config lives in
// wrangler.toml [vars]; see README.md for one-time setup.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });
    // Allow the characters that appear in NSE symbols / file slugs (A-Z 0-9 & _ -).
    const clean = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9&_-]/g, "").slice(0, 24);
    const gh = (path, init = {}) =>
      fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.GH_PAT}`,
          Accept: init.accept || "application/vnd.github+json",
          "User-Agent": "xerxes-stock-refresh",
          ...(init.headers || {}),
        },
      });

    try {
      // Trigger a one-symbol rebuild.
      if (url.pathname === "/refresh" && request.method === "POST") {
        const symbol = clean(url.searchParams.get("symbol"));
        if (!symbol) return json({ error: "symbol required" }, 400);
        const r = await gh(`/repos/${env.REPO}/actions/workflows/stocks.yml/dispatches`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref: env.CODE_BRANCH, inputs: { symbol } }),
        });
        if (r.status === 204) return json({ ok: true, symbol });
        return json({ error: "dispatch failed", status: r.status, detail: await r.text() }, 502);
      }

      // Fresh read of a published stock file (for post-trigger polling).
      if (url.pathname === "/data" && request.method === "GET") {
        const file = clean(url.searchParams.get("file"));
        if (!file) return json({ error: "file required" }, 400);
        const r = await gh(`/repos/${env.REPO}/contents/${file}.json?ref=${env.DATA_BRANCH}`, {
          accept: "application/vnd.github.raw",
        });
        if (r.status === 404) return json({ error: "not found" }, 404);
        if (!r.ok) return json({ error: "read failed", status: r.status }, 502);
        return new Response(await r.text(), {
          status: 200,
          headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
        });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
