"""
Forecast engines.

`base` and `bootstrap` are imported eagerly -- they are pure numpy and must stay
importable with no torch, no weights and no network, because the entire test
suite depends on that.

`kronos` is imported LAZILY through `get_engine`. Importing it eagerly would
drag torch into every `import ranker` and break the pure-math tests on any
machine without a model stack, which is precisely the coupling the build spec
rules out.
"""

from __future__ import annotations

from .base import Engine, Forecast
from .bootstrap import BootstrapEngine

__all__ = ["Engine", "Forecast", "BootstrapEngine", "get_engine"]


def get_engine(name: str, **kwargs) -> Engine:
    """Resolve an engine by name. Only "kronos" pulls in torch."""
    key = (name or "").lower()
    if key in ("bootstrap", "baseline", "null"):
        return BootstrapEngine(
            **{k: v for k, v in kwargs.items() if k in ("paths", "seed")}
        )
    if key == "kronos":
        from .kronos import KronosEngine  # noqa: PLC0415 - deliberately lazy

        allowed = (
            "model_id", "tokenizer_id", "vendor_path", "max_context",
            "sample_count", "batch_size", "path_samples", "device",
        )
        return KronosEngine(**{k: v for k, v in kwargs.items() if k in allowed})
    raise ValueError(f"unknown engine {name!r} (expected 'bootstrap' or 'kronos')")
