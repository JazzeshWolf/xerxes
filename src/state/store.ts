import { useEffect, useState } from "preact/hooks";
import type { IndexKey, Snapshot } from "../lib/types";
import { INDEX_META } from "../lib/types";

export interface Dash {
  snap: Snapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const BRANCH = "claude/nifty-option-screener-93xv0y";
// Primary: raw.githubusercontent — sees each data commit within minutes, no
// Pages redeploy needed (data commits are [skip ci]). Fallback: the copy
// bundled into the Pages deploy (may lag until the next code push).
const rawUrl = (file: string) =>
  `https://raw.githubusercontent.com/JazzeshWolf/xerxes/${BRANCH}/public/data/${file}.json`;
const pagesUrl = (file: string) => `${import.meta.env.BASE_URL}data/${file}.json`;

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
