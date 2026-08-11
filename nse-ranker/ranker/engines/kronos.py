"""
Kronos forecast engine.

Kronos (github.com/shiyu-coder/Kronos, MIT, AAAI 2026, arXiv 2508.02739) is a
decoder-only transformer over hierarchically-tokenised OHLCV candles, pre-trained
on 12B+ K-lines. Its strongest published result is cross-sectional stock ranking,
which is exactly the task this service uses it for.

## !! This module has never been executed !!

It was written in a sandbox whose egress policy blocks huggingface.co outright
(a 403 on CONNECT, logged proxy-side -- not a transient failure and not
route-aroundable). Weights could not be downloaded, so the code below is written
against the documented API and has NOT been run. The first real execution is the
GitHub Actions run, where egress is open.

Everything here is therefore built to fail loudly and specifically rather than
to fail plausibly:

* the model import is checked with a clear message naming PYTHONPATH, because
  Kronos is not on PyPI and `from model import ...` needs the vendored repo;
* `predict_batch`'s exact signature is the one documented upstream, but if it
  does not match we fall back to looping `predict` with a warning rather than
  crashing a 200-name run;
* the returned object's shape is normalised defensively, since a list of
  DataFrames and an array are both plausible.

If a run fails, the message should tell you which of these it was.

## The sampling subtlety that shapes this file

`predict(..., sample_count=N)` **averages** its N sampled paths and returns one
series -- it does not hand back the distribution. Averaging is the right,
low-variance estimator for a *ranking*, so it stays the signal. But it leaves no
spread to draw a cone from, so the dispersion comes from a small number of extra
single-sample passes, run only in the daily job. The backtest never needs them
(it consumes `median_return` alone), which keeps the runner budget on breadth.
"""

from __future__ import annotations

import datetime as dt
import sys

import numpy as np

from .. import config as C
from ..upstox import Bar
from .base import Engine, Forecast


class KronosUnavailable(RuntimeError):
    """Raised when the model, tokenizer or vendored repo cannot be loaded."""


class KronosEngine(Engine):
    name = "kronos"

    def __init__(
        self,
        model_id: str = C.KRONOS_MODEL,
        tokenizer_id: str = C.KRONOS_TOKENIZER,
        vendor_path: str | None = None,
        max_context: int = C.MAX_CONTEXT,
        sample_count: int = C.SAMPLE_COUNT,
        batch_size: int = C.KRONOS_BATCH_SIZE,
        path_samples: int = C.KRONOS_PATH_SAMPLES,
        device: str = "cpu",
    ):
        self.model_id = model_id
        self.tokenizer_id = tokenizer_id
        self.vendor_path = vendor_path
        self.max_context = max_context
        self.sample_count = sample_count
        self.batch_size = batch_size
        self.path_samples = path_samples
        self.device = device
        self._predictor = None

    # -- loading ------------------------------------------------------------

    def _load(self):
        if self._predictor is not None:
            return self._predictor
        if self.vendor_path and self.vendor_path not in sys.path:
            sys.path.insert(0, self.vendor_path)
        try:
            from model import Kronos, KronosTokenizer, KronosPredictor  # type: ignore
        except ImportError as exc:
            raise KronosUnavailable(
                "Could not `from model import Kronos, ...`. Kronos is not on PyPI: "
                "the repo must be cloned to nse-ranker/vendor/Kronos and that path "
                f"put on PYTHONPATH (tried: {self.vendor_path!r}). Original: {exc}"
            ) from exc
        try:
            tokenizer = KronosTokenizer.from_pretrained(self.tokenizer_id)
            model = Kronos.from_pretrained(self.model_id)
        except Exception as exc:  # noqa: BLE001
            raise KronosUnavailable(
                f"Could not load {self.model_id} / {self.tokenizer_id} from "
                f"HuggingFace: {exc}. On a runner this usually means the HF cache "
                "step failed or the hub is unreachable."
            ) from exc
        self._predictor = KronosPredictor(
            model, tokenizer, device=self.device, max_context=self.max_context
        )
        return self._predictor

    # -- forecasting --------------------------------------------------------

    def forecast(
        self, series: dict[str, list[Bar]], pred_len: int, with_paths: bool = False
    ) -> dict[str, Forecast]:
        predictor = self._load()
        symbols = sorted(series)
        out: dict[str, Forecast] = {}

        for start in range(0, len(symbols), self.batch_size):
            chunk = symbols[start: start + self.batch_size]
            try:
                out.update(self._forecast_chunk(predictor, chunk, series, pred_len, with_paths))
            except Exception as exc:  # noqa: BLE001
                # One bad batch must not lose the other 180 names -- breadth is
                # the edge, so we degrade rather than abort.
                print(f"kronos: batch {chunk[0]}..{chunk[-1]} failed: {exc}")
                for s in chunk:
                    bars = series[s]
                    out[s] = Forecast(
                        symbol=s, median_return=float("nan"),
                        last_close=float(bars[-1].c) if bars else float("nan"),
                        engine=self.name,
                    )
        return out

    def _forecast_chunk(self, predictor, chunk, series, pred_len, with_paths) -> dict[str, Forecast]:
        import pandas as pd

        df_list, x_ts, y_ts, last_closes = [], [], [], {}
        for sym in chunk:
            bars = series[sym][-self.max_context:]
            last_closes[sym] = float(bars[-1].c)
            df_list.append(
                pd.DataFrame(
                    {
                        "open": [b.o for b in bars],
                        "high": [b.h for b in bars],
                        "low": [b.l for b in bars],
                        "close": [b.c for b in bars],
                        "volume": [b.v for b in bars],
                    }
                )
            )
            hist = pd.Series(pd.to_datetime([b.t for b in bars]))
            x_ts.append(hist)
            y_ts.append(pd.Series(_future_days(bars[-1].t, pred_len)))

        # The ranking signal: the averaged path. Documented API, batched.
        central = self._call(predictor, df_list, x_ts, y_ts, pred_len, self.sample_count)

        # Dispersion for the cone: extra single-sample passes, best effort. A
        # failure here costs the chart, never the ranking.
        samples: list[list[np.ndarray]] = []
        if with_paths and self.path_samples > 0:
            for _ in range(self.path_samples):
                try:
                    samples.append(self._call(predictor, df_list, x_ts, y_ts, pred_len, 1))
                except Exception as exc:  # noqa: BLE001
                    print(f"kronos: path sample failed ({exc}) -- cone will be omitted")
                    break

        out: dict[str, Forecast] = {}
        for i, sym in enumerate(chunk):
            last = last_closes[sym]
            closes = central[i]
            if closes is None or len(closes) == 0 or not np.isfinite(closes[-1]) or last <= 0:
                out[sym] = Forecast(symbol=sym, median_return=float("nan"),
                                    last_close=last, engine=self.name)
                continue

            point = float(closes[-1]) / last - 1.0
            paths = [(np.asarray(s[i], dtype=float) / 1.0).tolist() for s in samples if s[i] is not None]
            terminal = np.array(
                [p[-1] / last - 1.0 for p in paths if len(p) and np.isfinite(p[-1])],
                dtype=float,
            )

            if terminal.size >= 3:
                fc = self._terminal_stats(sym, terminal, last, paths, self.name,
                                          all_paths=np.asarray(paths, dtype=float))
                # The averaged path is the better ranking estimator, so it stays
                # the published median even though the quantiles come from the
                # smaller sample around it. The band's midline is that same
                # averaged path, so the chart and the headline cannot disagree.
                fc.median_return = point
                if fc.band:
                    fc.band["mid"] = closes.tolist()
                out[sym] = fc
            else:
                # No usable dispersion: publish the central path as the midline
                # and no band, rather than drawing a cone from one sample.
                out[sym] = Forecast(
                    symbol=sym, median_return=point, last_close=last,
                    paths=[closes.tolist()], band={"mid": closes.tolist()},
                    n_samples=self.sample_count, engine=self.name,
                )
        return out

    def _call(self, predictor, df_list, x_ts, y_ts, pred_len, sample_count) -> list:
        """Call predict_batch, falling back to a predict() loop.

        Returns a list (one entry per input series) of 1-D close arrays.
        """
        try:
            res = predictor.predict_batch(
                df_list=df_list,
                x_timestamp_list=x_ts,
                y_timestamp_list=y_ts,
                pred_len=pred_len,
                T=C.TEMPERATURE,
                top_p=C.TOP_P,
                sample_count=sample_count,
                verbose=False,
            )
        except (AttributeError, TypeError) as exc:
            # Signature drift or no predict_batch on this version. Looping is
            # far slower, so make the reason unmissable in the log.
            print(
                f"kronos: predict_batch unusable ({exc}); falling back to a "
                "per-name predict() loop -- expect a much slower run."
            )
            res = [
                predictor.predict(
                    df=df, x_timestamp=x, y_timestamp=y, pred_len=pred_len,
                    T=C.TEMPERATURE, top_p=C.TOP_P, sample_count=sample_count,
                    verbose=False,
                )
                for df, x, y in zip(df_list, x_ts, y_ts)
            ]
        return [_closes_of(r) for r in res]


def _closes_of(result) -> np.ndarray | None:
    """Pull the close series out of whatever predict returned.

    Tolerates a DataFrame, a dict, or a bare array, because the exact return
    type could not be verified in the build sandbox.
    """
    if result is None:
        return None
    close = None
    if hasattr(result, "columns"):          # DataFrame
        for name in ("close", "Close", "c"):
            if name in result.columns:
                close = np.asarray(result[name], dtype=float)
                break
        if close is None:
            close = np.asarray(result.iloc[:, 3], dtype=float)  # o,h,l,c order
    elif isinstance(result, dict):
        close = np.asarray(result.get("close"), dtype=float)
    else:
        arr = np.asarray(result, dtype=float)
        close = arr[:, 3] if arr.ndim == 2 and arr.shape[1] >= 4 else arr.ravel()
    return close


def _future_days(last_iso: str, n: int) -> list[dt.datetime]:
    """`n` weekday timestamps after `last_iso`.

    NSE holidays are not modelled: these timestamps feed the model's temporal
    features only, and being a day out around a holiday perturbs a feature
    rather than misaligning the forecast, which is indexed by position.
    """
    d = dt.datetime.strptime(last_iso[:10], "%Y-%m-%d")
    out: list[dt.datetime] = []
    while len(out) < n:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            out.append(d)
    return out
