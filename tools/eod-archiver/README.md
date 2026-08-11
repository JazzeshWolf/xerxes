# Xerxes EOD archive

Preserves one end-of-day snapshot per trading day from the
[Xerxes options screener](https://github.com/JazzeshWolf/xerxes).

## Why this exists

Upstream publishes to the `stocks-data` branch with `peaceiris force_orphan: true`.
That branch holds **exactly one commit** — every build replaces it. The moment
today's build runs, yesterday's snapshot is gone permanently, from everywhere.

There is no other copy. This archive is it. Two consequences run through every
design decision here:

- **A missed day is unrecoverable.** There is no backfill source to go back to.
- **This repo must never rewrite its own history.** No force-push, no
  `force_orphan`, no rebase of published commits — reproducing upstream's bug on
  the only surviving copy of the data would be the single worst outcome. A test
  (`test/archive.test.mjs`) fails the build if `--force` or `force_orphan`
  appears anywhere in the scripts or workflow.

## Deploying

The archiver has to run somewhere that is awake on weekday afternoons IST. A
laptop cron misses days when the machine is asleep, and missed days cannot be
recovered — so it runs as a GitHub Action.

```bash
# from this directory
gh repo create xerxes-eod-archive --private --source=. --remote=origin --push
```

Or manually: create a **private** repo, then

```bash
git init && git add -A && git commit -m "Initial commit: Xerxes EOD archiver"
git remote add origin git@github.com:<you>/xerxes-eod-archive.git
git push -u origin main
```

Then check **Settings → Actions → General → Workflow permissions** is set to
*Read and write permissions*, so the job can commit its own snapshots. Nothing
else to configure — the sources are public, so there are no secrets and no
tokens to expire.

Verify with **Actions → EOD archive → Run workflow**. Outside market hours it
will correctly report `MISSED_DAY … PRE_CLOSE` or `STALE_UPSTREAM` rather than
archiving mid-session prices; that is the job working, not failing.

## Schedule

Cron `35 10 * * 1-5` — 10:35 UTC / 16:05 IST, Mon–Fri.

| | UTC | IST |
|---|---|---|
| Market close | 10:00 | 15:30 |
| Upstream `stocks.yml` final build (`15 4-10 * * 1-5`) | 10:15 | 15:45 |
| **This job** | **10:35** | **16:05** |
| Upstream `data.yml` final build (`7,…,57 3-10 * * 1-5`) | 10:57 | 16:27 |

The 10:15 UTC stock build lands 15 minutes after the close, which is what makes
it carry closing prices — that is the snapshot worth keeping. We fire 20 minutes
later so we are never racing the publish.

GitHub's scheduler is best-effort and routinely fires 10–30 minutes late. That
is tolerable because the job **verifies `asOf` rather than trusting the clock**,
and retries for another 30 minutes if the data isn't there yet.

Indices are captured at run time, i.e. from their ~10:27 UTC build rather than
their 10:57 UTC final one. Both are after the 10:00 UTC close, so both carry
closing prices; the index snapshot is simply not the last one of the day.

## Capture logic

1. Shallow-clone both sources.
2. Read `index.json` `asOf` and require that its **date is today (UTC)** and its
   **time is at or after 10:00 UTC**. A failed upstream build leaves the
   *previous* day's files in place looking perfectly valid — only `asOf` gives
   it away. A pre-close `asOf` means mid-session prices, not a close.
3. If either check fails, retry every 5 minutes, up to 6 times.
4. Still failing → write a `missed_days` row, commit that, and **exit 0**. A
   market holiday is an expected outcome, not a job failure; a red X every
   holiday just trains everyone to ignore the alerts that matter.
5. Skip entirely if the day is already captured, so re-runs are safe.

`FORCE_INTRADAY=1` overrides the pre-close check for a single run. It exists for
the case where upstream's final build failed and a mid-session snapshot is
better than nothing — a deliberate, per-run operator decision.

## Layout

```
archive/YYYY-MM-DD/stocks/*.json.gz     157 symbols + index.json + candidates.json
archive/YYYY-MM-DD/indices/*.json.gz    nifty, banknifty, sensex, market
archive/YYYY-MM-DD/meta.json            asOf, file counts, upstream HEAD shas
xerxes.db                               normalised SQLite, repo root
```

~1.9 MB per trading day. Files are written once and never rewritten, so git
stores each day's blobs exactly once.

**`archive/` is the source of truth; `xerxes.db` is a derived index.** If the
schema changes or a mapping turns out to be wrong, nothing is lost — edit
`scripts/normalise.mjs` and run `npm run rebuild`.

### Two invariants that keep the database committable

A 6 MB SQLite file rewritten daily would normally be ruinous in git. Measured
over 6 daily commits, the DB grew to 34.5 MB while the entire pack stayed at
**6.9 MB**, because git delta-compresses it almost perfectly. That depends on
two things:

- **The primary key leads with `trade_date`**, so each day's rows append to the
  end of the B-tree instead of shuffling existing pages.
- **Never `VACUUM` the committed database.** It rewrites every page, which
  collapses delta compression and turns each subsequent commit into a full
  multi-megabyte blob. Rebuild with `npm run rebuild` instead.

## Schema

`snapshots`, keyed `(trade_date, symbol, expiry, strike, type)`.

Rows come from the **option chain**, not the candidate list: only chain rows
carry `volume`, and a strike that is a ranked candidate today may drop off the
list tomorrow — keying off the chain keeps an unbroken price path for every
strike from entry to expiry. Candidate fields (`conviction`, `edge_pct`,
`p_profit`, …) are layered onto the matching strike and are NULL elsewhere.

Two column notes that will otherwise bite:

- **`edge_pct` is in percent units** (`4.09` = 4.09% of the margin proxy).
  Upstream stores it as a fraction; it is multiplied by 100 on the way in.
- **`p_profit` is the real-world probability** (`pProfit`, at forecast vol plus
  drift), *not* upstream's `probProfit`, which is the risk-neutral `1−|Δ|` proxy
  and carries no information by construction. Likewise `cushion_sigma` and
  `prob_touch` take the forecast-vol variants (`cushionSigmaF`, `probTouchF`),
  because the IV-based ones are circular for a seller: high IV makes a strike
  look safe precisely because it is priced as risky.

`src` marks provenance — `'archive'` (captured, full field coverage) or
`'backfill'` (hand-transcribed, candidate fields only). **Any analysis assuming
full coverage must filter `src = 'archive'`.**

Supporting tables: `missed_days` (why a day has no snapshot) and `runs` (what
each successful capture contained). A gap in `snapshots` with *no* matching
`missed_days` row means the job never ran at all — that is the failure mode to
watch for, and the reason both tables exist.

## Known data limits

Encoded as comments in `scripts/normalise.mjs`. Do not try to work around them.

- **`spot.history` is empty in every stock file.** There is no intraday high/low
  anywhere in this source, so `prob_touch` can **never** be validated from this
  archive. Do not build that test — it would only measure its own assumption.
  (Index files do carry daily closes, but daily closes are not intraday
  extremes.)
- **`ivRank` / `ivPercentile` are null everywhere.** Upstream needs 20 points of
  `ivHistory` and currently holds 4. Conviction is running on **6 of its 7
  factors**, with the `ivRank` weight redistributed pro-rata. Flag any analysis
  before ~20 archived trading days as *partial-factor*; `npm run report` prints
  the countdown and the warning. `vrp` carries related information from day one.
- **Data is ~10 minutes delayed**, and the 15:45 IST build is a post-close
  snapshot, **not a settlement print**. Do not treat `ltp` as a settlement price.

## Backfill

`scripts/backfill.mjs` holds three snapshots transcribed by hand before this
archiver existed — 2026-08-07, 2026-08-10, and a 2026-08-11 05:30 UTC price
mark. **They exist nowhere else on earth.** Treat that file as primary data, not
as code: do not tidy the literals, and do not drop a row for looking sparse.

Backfill rows use a fill-NULLs-only merge, so a real capture on the same key
always wins and replaying is a no-op. Where the 08-11 mark overlaps that day's
full capture, the capture supersedes it — later, closer to the close, and
machine-derived.

## Commands

```bash
npm test           # 13 tests, no dependencies
npm run archive    # capture today (what the Action runs)
npm run backfill   # re-apply the hand-transcribed snapshots (idempotent)
npm run rebuild    # regenerate xerxes.db from archive/ + backfill
npm run report     # coverage, recent days, missed days
```

Environment overrides: `TRADE_DATE`, `DRY_RUN=1`, `FORCE_INTRADAY=1`,
`MIN_ASOF_UTC`, `RETRIES`, `RETRY_MINUTES`, `SOURCE_REPO`, `STOCKS_BRANCH`,
`INDICES_BRANCH`, `ARCHIVE_DIR`, `DB_PATH`.

### Catching up a missed day

You can't. That is the point — upstream keeps no history. `TRADE_DATE` only
helps if the data still happens to be the current `stocks-data` commit (i.e.
same day, before the next build).

## A correction to the original brief

The brief said indices live on branch `main`. **The upstream repo has no `main`
branch.** Its de-facto trunk — the target of both Pages deploys and data commits
— is `claude/nifty-option-screener-93xv0y`, confirmed with `git ls-remote`. That
is the default in `scripts/archive.mjs`, with `main` and `master` as automatic
fallbacks in case it is ever renamed, and an `INDICES_BRANCH` override.

## Not built yet, on purpose

**No analysis layer.** One expiry across ~7 independent underlyings proves
nothing about whether the conviction score works. Revisit at ~50 independent
outcomes — roughly 4–8 monthly cycles. Until then this repo only collects.
