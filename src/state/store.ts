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

/** Stock screener list + top premium-selling candidates. */
export function useStockScreener() {
  const [screener, setScreener] = useState<StockScreener | null>(null);
  const [candidates, setCandidates] = useState<StockCandidates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
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
  return { screener, candidates, loading, error, refresh: () => setTick((x) => x + 1) };
}

/** One stock's full snapshot (same shape the index dashboard renders). */
export function useStock(file: string): Dash {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
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
  return { snap, loading, error, refresh: () => setTick((x) => x + 1) };
}
