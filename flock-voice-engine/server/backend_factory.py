"""永久音频后端工厂；legacy app 与 Phase 5 worker 共用。"""
from __future__ import annotations

from typing import Any

from .backends.base import AudioBackend, SilentBackend
from .backends.synth import SynthBackend
from .config import EngineConfig


def discover_backends() -> dict[str, type[AudioBackend]]:
    registry: dict[str, type[AudioBackend]] = {}
    # Production closure must be statically auditable. Optional implementations remain
    # lazy/catchable, but their module names are explicit rather than discovered at runtime.
    candidates: list[type[AudioBackend]] = []
    try:
        from .backends.brave import BraveBackend
        candidates.append(BraveBackend)
    except Exception as error:  # optional neural dependencies may be absent
        print(f"[warn] backend brave import failed ({error.__class__.__name__}: {error})", flush=True)
    try:
        from .backends.brave_voices import MultiVoiceBraveBackend
        candidates.append(MultiVoiceBraveBackend)
    except Exception as error:  # optional neural dependencies may be absent
        print(f"[warn] backend brave-voices import failed ({error.__class__.__name__}: {error})", flush=True)
    for backend in candidates:
        try:
            if issubclass(backend, AudioBackend) and backend is not AudioBackend:
                registry[backend.backend_id] = backend
        except TypeError:
            continue
    return registry


def make_backend(config: EngineConfig, *, asset_bundle=None) -> AudioBackend:
    kwargs: dict[str, Any] = {
        "sample_rate": config.sample_rate,
        "pool_size": config.pool_size,
        "block_samples": config.block_samples,
    }
    name = config.backend
    if name == "silent":
        return SilentBackend(**kwargs)
    if name == "synth":
        return SynthBackend(**kwargs)
    factory = discover_backends().get(name)
    if factory is None:
        print(f"[warn] 后端 '{name}' 未注册,回落到程序合成兜底", flush=True)
        return SynthBackend(**kwargs)
    if config.model_path is not None:
        kwargs["model_path"] = config.model_path
    kwargs["device"] = config.device
    try:
        if name == "brave-voices":
            if asset_bundle is not None:
                kwargs["asset_bundle"] = asset_bundle
        return factory(**kwargs)
    except TypeError as error:
        print(f"[warn] {factory.__name__} 构造签名不匹配({error}),回落到程序合成兜底", flush=True)
        return SynthBackend(**{key: kwargs[key] for key in ("sample_rate", "pool_size", "block_samples")})
