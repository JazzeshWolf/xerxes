import { useEffect, useState } from "preact/hooks";
import type { Snapshot } from "../lib/types";

export interface Dash {
  snap: Snapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Primary: raw.githubusercontent — sees each data commit within minutes, no
// Pages redeploy needed (data commits are [skip ci]). Fallback: the copy
// bundled into the Pages deploy (may lag until the next code push).
const RAW_URL =
  "https://raw.githubusercontent.com/JazzeshWolf/xerxes/claude/nifty-option-screener-93xv0y/public/data/nifty.json";
const PAGES_URL = `${import.meta.env.BASE_URL}data/nifty.json`;

export function useDashboard(): Dash {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const get = (url: string) =>
      fetch(`${url}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`data fetch -> ${r.status}`);
        return r.json();
      });
    get(RAW_URL)
      .catch(() => get(PAGES_URL))
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
  }, [tick]);

  // Auto-refresh every 5 minutes while the tab is open.
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return { snap, loading, error, refresh: () => setTick((x) => x + 1) };
}
