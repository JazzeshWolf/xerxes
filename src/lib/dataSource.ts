// ---------------------------------------------------------------------------
// Where published data lives.
//
// The repo path and the data branches were previously inlined as string
// literals in `state/store.ts`. They are factored out here so there is one
// hardcoded "JazzeshWolf/xerxes" to change when anything moves.
//
// Two branches, two reasons:
//  - CODE_BRANCH   — the de-facto main branch. Index snapshots are committed
//                    here directly (small, a handful of files).
//  - STOCKS_BRANCH — force-pushed orphan. ~157 files rewritten per run would
//                    add ~7 MB of git objects per run to the code branch.
// ---------------------------------------------------------------------------

export const REPO = "JazzeshWolf/xerxes";

export const CODE_BRANCH = "claude/nifty-option-screener-93xv0y";
export const STOCKS_BRANCH = "stocks-data";

/** Primary source: raw.githubusercontent sees each data commit within minutes,
 *  with no Pages redeploy needed (data commits are `[skip ci]`). */
const raw = (branch: string, path: string) =>
  `https://raw.githubusercontent.com/${REPO}/${branch}/${path}`;

/** Index snapshots + macro layer, committed to the code branch. */
export const rawUrl = (file: string) => raw(CODE_BRANCH, `public/data/${file}.json`);

/** Fallback: the copy bundled into the Pages deploy (may lag a code push). */
export const pagesUrl = (file: string) => `${import.meta.env.BASE_URL}data/${file}.json`;

/** Stock screener data — JSON sits at the branch root on the orphan branch. */
export const rawStockUrl = (file: string) => raw(STOCKS_BRANCH, `${file}.json`);

/** Cache-busted JSON fetch. Shared so every caller fails the same way. */
export const getJson = (url: string) =>
  fetch(`${url}?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`fetch -> ${r.status}`);
    return r.json();
  });
