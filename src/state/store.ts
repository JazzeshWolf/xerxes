import { useEffect, useState } from "preact/hooks";
import type { IndexKey, Snapshot, MarketData, StockScreener, StockCandidates } from "../lib/types";
import { INDEX_META } from "../lib/types";

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

const BRANCH = "claude/nifty-option-screener-93xv0y";
// Primary: raw.githubusercontent — sees each data commit within minutes, no
// Pages redeploy needed (data commits are [skip ci]). Fallback: the copy
// bundled into the Pages deploy (may lag until the next code push).
const rawUrl = (file: string) =>
  `https://raw.githubusercontent.com/JazzeshWolf/xerxes/${BRANCH}/public/data/${file}.json`;
const pagesUrl = (file: string) => `${import.meta.env.BASE_URL}data/${file}.json`;

// Stock data lives on a dedicated, force-pushed branch (no history growth), with
// the JSON at the branch root. Primary source is that branch via raw; the Pages
// copy is only a local-dev fallback (production always resolves raw first).
const STOCKS_BRANCH = "stocks-data";
const rawStockUrl = (file: string) =>
  `https://raw.githubusercontent.com/JazzeshWolf/xerxes/${STOCKS_BRANCH}/${file}.json`;

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

export interface StockDash extends Dash {
  hardRefresh: () => void; // trigger a live rebuild (falls back to re-pull)
  refreshing: boolean; // a live rebuild is in flight
  refreshError: string | null;
}

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
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSnap(null);
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

  return { snap, loading, error, refresh: () => setTick((x) => x + 1), hardRefresh, refreshing, refreshError };
}
