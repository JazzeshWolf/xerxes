import { useEffect, useMemo, useState } from "preact/hooks";
import type { IndexKey, Snapshot, MarketData, StockScreener, StockCandidates, LiveNews } from "../lib/types";
import { INDEX_META } from "../lib/types";
import { rawUrl, pagesUrl, rawStockUrl } from "../lib/dataSource";
import { mergeLiveNews } from "../lib/outlook";

export interface Dash {
  snap: Snapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export interface Market {
  data: MarketData | null;
  refresh: () => void;
}

// URL builders now live in lib/dataSource.ts so the repo path and the branch
// names are declared once.
// Behaviour is unchanged:
//  - rawUrl: raw.githubusercontent, which sees each data commit within minutes
//    with no Pages redeploy (data commits are [skip ci]);
//  - pagesUrl: the copy bundled into the Pages deploy (may lag a code push);
//  - rawStockUrl: the dedicated, force-pushed stocks branch (no history growth),
//    with the JSON at the branch root. Production always resolves raw first.

export function useDashboard(index: IndexKey): Dash {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const file = INDEX_META[index].file;
    setLoading(true);
    setSnap(null);
    const get = (url: string) =>
      fetch(`${url}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`data fetch -> ${r.status}`);
        return r.json();
      });
    get(rawUrl(file))
      .catch(() => get(pagesUrl(file)))
      .then((j: Snapshot) => {
        if (!alive) return;
        setSnap(j);
        setError(null);
      })
      .catch((e) => alive && setError(String(e.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [index, tick]);

  // Auto-refresh every 5 minutes while the tab is open.
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return { snap, loading, error, refresh: () => setTick((x) => x + 1) };
}

/** Shared macro layer (events + news + drivers). Refetches on refresh(). */
export function useMarket(): Market {
  const [data, setData] = useState<MarketData | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const get = (url: string) =>
      fetch(`${url}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`market -> ${r.status}`);
        return r.json();
      });
    get(rawUrl("market"))
      .catch(() => get(pagesUrl("market")))
      .then((j: MarketData) => alive && setData(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]);
  return { data, refresh: () => setTick((x) => x + 1) };
}

const getJson = (url: string) =>
  fetch(`${url}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`fetch -> ${r.status}`);
    return r.json();
  });

// Optional on-demand refresh proxy (a Cloudflare Worker). When set, tapping a
// stock's Refresh fires a one-symbol rebuild in GitHub Actions and polls for the
// fresh snapshot. When unset, refresh just re-pulls the last published data.
const STOCK_REFRESH_URL = (import.meta.env.VITE_STOCK_REFRESH_URL ?? "").replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Re-pull every 5 min, and again whenever the app comes back to the
 *  foreground. The foreground half is the one that matters on a phone: a
 *  backgrounded PWA freezes its timers, so a Telegram alert → tap → app showed
 *  whatever it had loaded hours earlier, contradicting the alert. Throttled so
 *  quick app switches don't refetch every time. */
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const FOREGROUND_MIN_GAP_MS = 60 * 1000;
function useAutoRefresh(bump: () => void) {
  useEffect(() => {
    let last = Date.now();
    const fire = () => {
      last = Date.now();
      bump();
    };
    const id = setInterval(fire, AUTO_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= FOREGROUND_MIN_GAP_MS) fire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

export interface StockDash extends Dash {
  hardRefresh: () => void; // trigger a live rebuild (falls back to re-pull)
  refreshing: boolean; // a live rebuild is in flight
  refreshError: string | null;
  /** Live headlines/events/filings via the Worker's /news (falls back to re-pull). */
  fetchNews: () => void;
  newsFetching: boolean;
  newsError: string | null;
}

/** Whether the Worker is configured — live news and live rebuilds both need it. */
export const HAS_REFRESH_PROXY = Boolean(STOCK_REFRESH_URL);

/** Stock screener list + top premium-selling candidates. */
export function useStockScreener() {
  const [screener, setScreener] = useState<StockScreener | null>(null);
  const [candidates, setCandidates] = useState<StockCandidates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = (file: string) => getJson(rawStockUrl(file)).catch(() => getJson(pagesUrl(`stocks/${file}`)));
    Promise.all([load("index"), load("candidates").catch(() => null)])
      .then(([idx, cand]) => {
        if (!alive) return;
        setScreener(idx);
        setCandidates(cand);
        setError(null);
      })
      .catch((e) => alive && setError(String(e.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tick]);

  useAutoRefresh(() => setTick((x) => x + 1));

  // Live rebuild of the whole universe (the candidates list). If a proxy is
  // configured, trigger a full stocks run and poll until index.json's asOf
  // advances; otherwise just re-pull the last published copy.
  const hardRefresh = async () => {
    if (!STOCK_REFRESH_URL) {
      setTick((x) => x + 1);
      return;
    }
    setRefreshing(true);
    setRefreshError(null);
    const prevAsOf = screener?.asOf ?? "";
    try {
      const r = await fetch(`${STOCK_REFRESH_URL}/refresh`, { method: "POST" }); // no symbol → full run
      if (!r.ok) throw new Error(`couldn't start rebuild (${r.status})`);
      const deadline = Date.now() + 180000; // a full 150-stock run is slower than one name
      while (Date.now() < deadline) {
        await sleep(5000);
        try {
          const idx: StockScreener = await getJson(`${STOCK_REFRESH_URL}/data?file=index`);
          if (idx?.asOf && idx.asOf > prevAsOf) {
            setScreener(idx);
            try {
              setCandidates(await getJson(`${STOCK_REFRESH_URL}/data?file=candidates`));
            } catch {
              /* candidates optional */
            }
            setRefreshing(false);
            return;
          }
        } catch {
          /* keep polling */
        }
      }
      setRefreshError("Still rebuilding the universe — check back in a moment.");
    } catch (e) {
      setRefreshError(String((e as Error).message ?? e));
    } finally {
      setRefreshing(false);
    }
  };

  return { screener, candidates, loading, error, refresh: () => setTick((x) => x + 1), hardRefresh, refreshing, refreshError };
}

/** One stock's full snapshot (same shape the index dashboard renders). */
export function useStock(file: string): StockDash {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Blank only when switching stocks. A background re-pull of the same stock
  // keeps the old snapshot on screen, so it doesn't flash "Loading" or reset
  // the chosen expiry/tab under the user.
  useEffect(() => setSnap(null), [file]);
  // Live news is per stock; never let one name's answer sit on another.
  const [live, setLive] = useState<LiveNews | null>(null);
  const [newsFetching, setNewsFetching] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  useEffect(() => {
    setLive(null);
    setNewsError(null);
  }, [file]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    getJson(rawStockUrl(file))
      .catch(() => getJson(pagesUrl(`stocks/${file}`)))
      .then((j: Snapshot) => {
        if (!alive) return;
        setSnap(j);
        setError(null);
      })
      .catch((e) => alive && setError(String(e.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [file, tick]);

  useAutoRefresh(() => setTick((x) => x + 1));

  // Live rebuild: ask the proxy to rebuild this one symbol in GitHub Actions,
  // then poll the (fresh, uncached) proxy read until the snapshot's asOf advances.
  const hardRefresh = async () => {
    const symbol = snap?.index;
    if (!STOCK_REFRESH_URL || !symbol) {
      setTick((x) => x + 1); // no proxy configured → just re-pull the published copy
      return;
    }
    setRefreshing(true);
    setRefreshError(null);
    const prevAsOf = snap?.asOf ?? "";
    try {
      const r = await fetch(`${STOCK_REFRESH_URL}/refresh?symbol=${encodeURIComponent(symbol)}`, { method: "POST" });
      if (!r.ok) throw new Error(`couldn't start refresh (${r.status})`);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await sleep(4000);
        try {
          const fresh: Snapshot = await getJson(`${STOCK_REFRESH_URL}/data?file=${encodeURIComponent(file)}`);
          if (fresh?.asOf && fresh.asOf > prevAsOf) {
            setSnap(fresh);
            setRefreshing(false);
            return;
          }
        } catch {
          /* keep polling */
        }
      }
      setRefreshError("Still building — give it a moment and tap Refresh again.");
    } catch (e) {
      setRefreshError(String((e as Error).message ?? e));
    } finally {
      setRefreshing(false);
    }
  };

  // "Fetch latest news": ask the Worker for this company's headlines, NSE
  // calendar and filings LIVE (a few seconds, no Actions run, no Upstox), and
  // overlay them on the published snapshot. The overlay survives the 5-minute
  // auto re-pull for as long as it is newer than what was published.
  const fetchNews = async () => {
    const symbol = snap?.index;
    if (!STOCK_REFRESH_URL || !symbol) {
      setTick((x) => x + 1); // no Worker → the best we can do is re-pull
      return;
    }
    setNewsFetching(true);
    setNewsError(null);
    try {
      const r = await fetch(`${STOCK_REFRESH_URL}/news?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`news service answered ${r.status}`);
      const j: LiveNews = await r.json();
      setLive(j);
      if (!j.news?.length) setNewsError("Google News returned nothing just now — showing the last published headlines.");
    } catch (e) {
      setNewsError(`Couldn't fetch live news (${String((e as Error).message ?? e)}). Showing the last published copy.`);
    } finally {
      setNewsFetching(false);
    }
  };

  const merged = useMemo(() => (snap ? mergeLiveNews(snap, live) : null), [snap, live]);

  return {
    snap: merged,
    loading,
    error,
    refresh: () => setTick((x) => x + 1),
    hardRefresh,
    refreshing,
    refreshError,
    fetchNews,
    newsFetching,
    newsError,
  };
}
