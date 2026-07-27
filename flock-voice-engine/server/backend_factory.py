"""永久音频后端工厂；legacy app 与 Phase 5 worker 共用。"""
from __future__ import annotations

import importlib
import pkgutil
from typing import Any

from .backends.base import AudioBackend, SilentBackend
from .backends.synth import SynthBackend
from .config import EngineConfig


def discover_backends() -> dict[str, type[AudioBackend]]:
    package = importlib.import_module("server.backends")
    registry: dict[str, type[AudioBackend]] = {}
    for module_info in pkgutil.iter_modules(package.__path__):
        if module_info.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{package.__name__}.{module_info.name}")
        except Exception as error:  # 可选神经后端依赖可能未安装
            print(f"[warn] 后端模块 {module_info.name} 导入失败({error.__class__.__name__}: {error}),跳过", flush=True)
            continue
        for attribute in vars(module).values():
            if isinstance(attribute, type) and issubclass(attribute, AudioBackend) and attribute is not AudioBackend:
                registry[attribute.backend_id] = attribute
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
    if ":" in name:
        module_name, _, class_name = name.partition(":")
        try:
            factory = getattr(importlib.import_module(module_name), class_name)
        except (ImportError, AttributeError) as error:
            print(f"[warn] 无法加载 {name}({error}),回落到程序合成兜底", flush=True)
            return SynthBackend(**kwargs)
    else:
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
