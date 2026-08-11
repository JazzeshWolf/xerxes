"""
Every hand-set constant in the NSE F&O ranker lives here, labelled with why it
holds the value it holds.

The rule this module exists to enforce: no magic number anywhere else in the
package. If a number was chosen by a human rather than measured from data, it
belongs in this file with a sentence explaining the choice. Several of these are
*priors*, not fitted parameters -- they are marked PRIOR and should be read with
the same scepticism the repo already applies to `sellConviction`'s weights.

This module imports nothing but the standard library, so it is safe to import
from the pure-math modules that must work without torch.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Kronos model + inference
# ---------------------------------------------------------------------------

#: HuggingFace repo ids. Kronos-large is NOT released; mini/small/base are.
#: Start on small (24.7M) per the build spec -- mini is the fallback if the
#: runner budget bites, because breadth must never be traded away first.
KRONOS_MODEL = "NeoQuasar/Kronos-small"
KRONOS_TOKENIZER = "NeoQuasar/Kronos-Tokenizer-base"

#: The mini pairing, for the documented fallback ladder (see README).
#: mini has a 2048 context but pairs with the 2k tokenizer, not the base one.
KRONOS_MINI_MODEL = "NeoQuasar/Kronos-mini"
KRONOS_MINI_TOKENIZER = "NeoQuasar/Kronos-Tokenizer-2k"

#: Kronos is not on PyPI -- `from model import ...` needs the repo on
#: PYTHONPATH. Pinned so a Kronos push can never silently change our forecasts.
#: Verify with: git -C nse-ranker/vendor/Kronos rev-parse HEAD
KRONOS_REPO = "https://github.com/shiyu-coder/Kronos.git"
#: Resolved with `git ls-remote https://github.com/shiyu-coder/Kronos.git HEAD`
#: on 2026-08-11. Bump deliberately, never automatically: an upstream change to
#: the tokenizer or the sampling loop would silently alter every forecast, and
#: the whole point of the skill report is knowing what produced the numbers.
KRONOS_COMMIT = "67b630e67f6a18c9e9be918d9b4337c960db1e9a"

#: Model context, in *bars*. Kronos-small's window is 512; we feed the full
#: window because the cross-sectional signal is the point and truncating history
#: costs us nothing on the runner (batching dominates, not sequence length).
MAX_CONTEXT = 512

#: Bars of history handed to the engine per name. Equal to MAX_CONTEXT so every
#: series in a batch is the same length -- `predict_batch` requires that.
LOOKBACK_BARS = 512

#: Forecast horizon in trading days. 21 ~= one calendar month, which matches the
#: monthly expiry the option-selling decision is usually made against.
PRED_LEN = 21

#: Sampling. Kronos is probabilistic; a point forecast would throw away the
#: distribution the cone and the percentile both need.
SAMPLE_COUNT = 30
TEMPERATURE = 1.0  # T in predict(); 1.0 = the model's own calibration
TOP_P = 0.9

#: Kronos's `predict(..., sample_count=N)` AVERAGES its N sampled paths and
#: returns one series -- it does not hand back the distribution. That average is
#: the right low-variance estimator for RANKING, so it stays the signal. To draw
#: a cone we need genuine spread, which means extra single-sample passes. Kept
#: small and run only in the daily job (never in the backtest, which needs only
#: the ranking signal) so the runner budget goes to breadth instead.
KRONOS_PATH_SAMPLES = 8

#: Names per `predict_batch` call. Batching is what makes 190 names feasible on
#: a 2-core runner; too large a batch just risks the runner's memory limit.
KRONOS_BATCH_SIZE = 32

#: Minimum bars a name needs before we will forecast it at all. Below this the
#: history is too short for a 512-context model to be meaningful, and the name
#: is dropped from that date's universe rather than fed a padded series.
MIN_BARS = 260  # ~1 trading year

# ---------------------------------------------------------------------------
# Universe
# ---------------------------------------------------------------------------

#: Sector groupings come from scripts/stocks-universe.mjs -- the repo's existing
#: TRADING grouping (PSU and private banks together because they move together),
#: not GICS. Single source of truth; parsed, never duplicated.
SECTORS_SOURCE = "scripts/stocks-universe.mjs"

#: A sector needs this many names on a date before it gets its own dummy in the
#: sector-neutralisation regression. Below it, the names are pooled into OTHER:
#: regressing on a 1-name sector would just delete that name's signal entirely.
MIN_SECTOR_SIZE = 3

#: Guard rails on the derived universe. NSE F&O single stocks have sat in the
#: 180-220 band for years; falling outside it means the instrument-master parse
#: broke, and we would rather fail loudly than rank a broken universe.
UNIVERSE_MIN = 100
UNIVERSE_MAX = 400

# ---------------------------------------------------------------------------
# Corporate actions  (the most likely way this build silently produces garbage)
# ---------------------------------------------------------------------------

#: A one-day move beyond this is treated as *suspect* and tested against the
#: known split/bonus ratio grid. Real single-day equity moves above 25% happen
#: (rarely), so detection additionally requires the move to land near a round
#: corporate-action ratio -- see corpactions.py.
CA_SUSPECT_RETURN = 0.25

#: Ratios we recognise, as (price multiplier). A 2:1 split halves the price, a
#: 1:1 bonus halves it too, 3:1 split -> 1/3, and so on. Consolidations (reverse
#: splits) multiply price up, hence the >1 entries.
CA_RATIOS = (
    1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 2 / 3, 3 / 4, 2 / 5, 3 / 5, 5 / 6,
    2.0, 3.0, 5.0, 10.0,
)

#: How close the observed price ratio must sit to a grid ratio to count as that
#: corporate action. 3.5% absorbs the genuine market move on the ex-date without
#: being loose enough to catch an ordinary large gap.
CA_RATIO_TOLERANCE = 0.035

#: Ratios that a genuine one-day crash or rally could plausibly imitate. A -33%
#: day looks exactly like a 2:3 split on close-to-close alone, so these require
#: corroboration (whole-bar shift or a volume jump) before we rewrite history.
#: The rest -- halving, thirding, 10x -- are far outside any real session.
CA_AMBIGUOUS_RATIOS = (2 / 3, 3 / 4, 2 / 5, 3 / 5, 5 / 6)

#: On a split the WHOLE bar reprices, so the day's high also sits at the new
#: level. On a crash the high is typically near the previous close. This is the
#: discriminator that keeps a genuine -33% session from being "corrected" away.
#: Slack multiplier on the ratio test applied to the high (or low, on reverse
#: splits) -- looser than the close test because the ex-date still trades.
CA_RANGE_SLACK = 3.0

#: Volume confirmation. On a split the price collapses but traded *value* does
#: not, so share volume jumps by roughly the split factor. Not required (some
#: feeds restate volume too), but when present it raises confidence.
CA_VOLUME_CONFIRM = 1.5

# ---------------------------------------------------------------------------
# Neutralisation
# ---------------------------------------------------------------------------

#: Trading days used to estimate each name's beta against the equal-weight
#: universe return. One year: long enough to be stable, short enough to track a
#: changing beta.
BETA_WINDOW = 252

#: Beta is winsorised into this band before neutralising. An unclipped beta from
#: a thin or newly-listed name can be wild, and one bad beta distorts the whole
#: cross-sectional regression.
BETA_CLIP = (0.0, 3.0)

#: Post-neutralisation acceptance bars. If |corr(rank, beta)| or the sector R^2
#: is still above these, the ranking IS beta or sector in disguise and the
#: pipeline says so loudly rather than shipping it quietly.
MAX_BETA_CORR_AFTER = 0.20
MAX_SECTOR_R2_AFTER = 0.15

# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

DECILES = 10

#: Winsorise the neutralised score at these cross-sectional quantiles before
#: ranking. Ranking is itself robust to outliers, but the *scores* are shown in
#: the UI and a single absurd value wrecks the colour scale.
SCORE_WINSOR = (0.01, 0.99)

# ---------------------------------------------------------------------------
# Costs  (Indian retail, round trip, in basis points of traded value)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CostModel:
    """Round-trip cost components in bps of traded notional.

    Defaults model equity *delivery* at a discount broker, which is what the
    decile-spread benchmark notionally trades. Read the README before treating
    the decile spread as a tradeable strategy: the short leg is not shortable in
    delivery in India, so a real implementation is single-stock futures, with a
    different (generally cheaper on STT, dearer on rollover) cost stack.
    """

    #: Flat per-order brokerage, in bps. Discount brokers charge 0 on delivery.
    brokerage_bps: float = 0.0
    #: STT: 0.1% on buy AND 0.1% on sell for delivery = 20 bps round trip.
    stt_bps: float = 20.0
    #: NSE equity transaction charge ~0.00297% per side.
    exchange_bps: float = 0.594
    #: SEBI turnover fee, Rs 10 per crore per side.
    sebi_bps: float = 0.02
    #: Stamp duty 0.015%, buy side only.
    stamp_bps: float = 1.5
    #: GST 18%, levied on brokerage + exchange + SEBI (not on STT or stamp).
    gst_rate: float = 0.18
    #: PRIOR. Impact is the term people forget and usually the largest one.
    #: 20 bps round trip sits mid-range for liquid F&O names; the spec's band is
    #: 15-30 bps. Sensitivity to this is reported by the backtest.
    impact_bps: float = 20.0

    def round_trip_bps(self) -> float:
        taxed = self.brokerage_bps + self.exchange_bps + self.sebi_bps
        return (
            self.brokerage_bps
            + self.stt_bps
            + self.exchange_bps
            + self.sebi_bps
            + self.stamp_bps
            + taxed * self.gst_rate
            + self.impact_bps
        )


COSTS = CostModel()

#: Impact values the backtest re-runs at, so the headline number is never a
#: single un-stressed guess.
IMPACT_SENSITIVITY_BPS = (10.0, 20.0, 30.0)

# ---------------------------------------------------------------------------
# Validation and the bar the UI is gated on
# ---------------------------------------------------------------------------

#: Rebalance spacing in trading days for the walk-forward. Equal to PRED_LEN so
#: forecast horizon and holding period match -- overlapping windows would
#: autocorrelate the IC series and inflate ICIR, which is the number we care
#: most about not fooling ourselves on.
REBALANCE_EVERY = PRED_LEN

#: PRIOR, and the single most important number in this file. The Kronos tab
#: labels its ranks UNVALIDATED until measured ICIR clears this.
#: 0.30 annualised-equivalent for a monthly rebalance is a modest, honest bar:
#: comfortably below published cross-sectional equity results, comfortably above
#: noise for the ~30-60 rebalances a few years of history affords.
MIN_ICIR = 0.30

#: And it must beat plain 12-1 momentum by at least this much ICIR. A model that
#: merely ties momentum is not worth the compute -- say so plainly.
MIN_ICIR_EDGE_OVER_MOMENTUM = 0.05

#: Minimum rebalance dates before any skill claim is made at all. Below this the
#: t-stat is not interpretable and the tab stays unvalidated regardless of ICIR.
MIN_REBALANCES = 24

#: Bootstrap (null) engine. Block length balances two things measured in this
#: repo already: blocks buy terminal dispersion, but no block length recovers
#: excess kurtosis at long horizons. horizon/3 bounded [5, 15] mirrors
#: analytics.mjs `terminalSample`.
BOOTSTRAP_BLOCK_DIVISOR = 3
BOOTSTRAP_BLOCK_BOUNDS = (5, 15)
BOOTSTRAP_PATHS = 400
#: Fixed seed: the null must be reproducible or it is not a benchmark.
BOOTSTRAP_SEED = 20260811

# ---------------------------------------------------------------------------
# Benchmarks
# ---------------------------------------------------------------------------

#: 12-1 momentum: 12 months of return skipping the most recent month, the
#: standard construction (Jegadeesh-Titman), skip-month included because the
#: 1-month reversal effect otherwise contaminates it.
MOMENTUM_LOOKBACK = 252
MOMENTUM_SKIP = 21
#: Short-term reversal horizon.
REVERSAL_LOOKBACK = 5

# ---------------------------------------------------------------------------
# Upstox data layer
# ---------------------------------------------------------------------------

UPSTOX_BASE = "https://api.upstox.com/v2"
UPSTOX_INSTRUMENTS_NSE = (
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
)
UPSTOX_INSTRUMENTS_ALL = (
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz"
)

#: The asset CDN intermittently 403s GitHub runners (documented in CLAUDE.md and
#: already handled in scripts/upstox.mjs). Same retry posture here.
FETCH_ATTEMPTS = 3
FETCH_BACKOFF_SEC = 2.0
#: Politeness delay between per-symbol history calls.
FETCH_SPACING_SEC = 0.12

#: Calendar years of daily candles requested. Upstox's true depth is *measured*
#: at run time and written into the report -- this is only the ask.
HISTORY_YEARS = 6

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

#: Published to a dedicated force-pushed branch, mirroring `stocks-data`, so the
#: code branch never accumulates a rewritten payload per run.
DATA_BRANCH = "ranker-data"
OUT_DIR = "public/data/ranker"
INDEX_FILE = "index.json"
SKILL_FILE = "skill.json"

#: Sample paths kept per name for the UI cone. All 30 would triple the payload
#: for a chart that cannot resolve them; the quantile bands carry the shape.
KEEP_SAMPLE_PATHS = 8

#: Recent bars shipped per name for the detail view's OHLCV strip.
KEEP_RECENT_BARS = 60


@dataclass(frozen=True)
class RunConfig:
    """Per-run knobs the CLI can override without touching the constants above."""

    engine: str = "bootstrap"  # "bootstrap" | "kronos"
    pred_len: int = PRED_LEN
    lookback: int = LOOKBACK_BARS
    sample_count: int = SAMPLE_COUNT
    universe_limit: int | None = None  # smoke tests only; never in production
    seed: int = BOOTSTRAP_SEED
    costs: CostModel = field(default_factory=lambda: COSTS)
