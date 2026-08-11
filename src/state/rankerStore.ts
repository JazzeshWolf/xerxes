import { useEffect, useState } from "preact/hooks";
import { getJson, pagesUrl, rawRankerUrl } from "../lib/dataSource";
import { parseIndex, parseSkill, type RankerDetail, type RankerIndex, type RankerSkill } from "../lib/ranker";

// ---------------------------------------------------------------------------
// Kronos ranker data. Mirrors `useDashboard()` in store.ts — same fallback
// ladder (raw.githubusercontent first, Pages copy second), same cache-busting,
// same alive-guard on unmount.
//
// The one deliberate difference: a fetch that succeeds but returns something
// unparseable is treated as NO DATA, not as an error. `parseIndex` returning
// null puts the tab in its empty state rather than surfacing a stack trace, and
// crucially it can never render a partial ranking. A truncated mid-publish JSON
// is the realistic case, and half a decile table is worse than none.
// ---------------------------------------------------------------------------

export interface RankerDash {
  index: RankerIndex | null;
  skill: RankerSkill | null;
  loading: boolean;
  /** Set only when the ranker has never published; not for parse failures. */
  missing: boolean;
  error: string | null;
  refresh: () => void;
}

const load = (file: string) =>
  getJson(rawRankerUrl(file)).catch(() => getJson(pagesUrl(`ranker/${file}`)));

export function useRanker(): RankerDash {
  const [index, setIndex] = useState<RankerIndex | null>(null);
  const [skill, setSkill] = useState<RankerSkill | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    // The skill report is optional and failing to fetch it is not an error --
    // it just leaves the tab in its "skill not yet measured" state, which is
    // the honest default.
    Promise.all([load("index"), load("skill").catch(() => null)])
      .then(([rawIndex, rawSkill]) => {
        if (!alive) return;
        const parsed = parseIndex(rawIndex);
        setIndex(parsed);
        setSkill(parseSkill(rawSkill));
        setMissing(parsed === null);
        setError(parsed === null ? "Published ranker data could not be read." : null);
      })
      .catch(() => {
        if (!alive) return;
        setIndex(null);
        setSkill(null);
        setMissing(true);
        setError(null); // never published yet is an empty state, not a failure
      })
      .finally(() => alive && setLoading(false));

    return () => {
      alive = false;
    };
  }, [tick]);

  return { index, skill, loading, missing, error, refresh: () => setTick((x) => x + 1) };
}

/** One name's detail payload — sample paths and recent bars. Optional by design. */
export function useRankerDetail(symbol: string | null) {
  const [detail, setDetail] = useState<RankerDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setDetail(null);
    load(symbol)
      .then((j) => alive && setDetail(j as RankerDetail))
      .catch(() => alive && setDetail(null)) // detail is a nicety; the rank is the product
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [symbol]);

  return { detail, loading };
}
