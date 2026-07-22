"""独立发行版的单文件运行配置。

配置文件只保存无密钥参数。云端密钥在启动时从 ``apiKeyEnv`` 指定的环境变量
读取，并存入 ``repr=False`` 字段，避免异常日志或调试输出把它带出来。
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .config import DEFAULT_SAMPLE_RATE, EngineConfig


class RuntimeConfigError(ValueError):
    """运行配置不完整、类型错误或违反公开契约。"""


@dataclass(frozen=True)
class ResolvedAgent:
    """当前真正启用的 Agent 上游；密钥永不参与对象打印。"""

    mode: str
    base_url: str
    model: str
    api_key: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class RuntimeSettings:
    """后端启动时已经验证完成的全部设置。"""

    engine: EngineConfig
    agent_mode: str
    agent: ResolvedAgent | None
    timeout_seconds: float


def _object(value: Any, label: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeConfigError(f"{label} 必须是 JSON object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise RuntimeConfigError(f"{label} 包含未知字段: {', '.join(unknown)}")
    return value


def _string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise RuntimeConfigError(f"{label} 必须是字符串")
    cleaned = value.strip()
    if not allow_empty and not cleaned:
        raise RuntimeConfigError(f"{label} 不能为空")
    return cleaned


def _integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeConfigError(f"{label} 必须是整数")
    return value


def _positive_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeConfigError(f"{label} 必须是数字")
    result = float(value)
    if result <= 0:
        raise RuntimeConfigError(f"{label} 必须大于 0")
    return result


def _provider_object(value: Any, label: str, *, cloud: bool) -> dict[str, Any]:
    allowed = {"baseUrl", "model", "apiKeyEnv"} if cloud else {"baseUrl", "model"}
    return _object(value, label, allowed)


def _provider_url(value: Any, label: str) -> str:
    url = _string(value, label).rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeConfigError(f"{label} 必须是 http/https URL")
    return url


def load_runtime_config(
    path: str | Path,
    environ: Mapping[str, str] | None = None,
) -> RuntimeSettings:
    """读取并严格验证 ``config/runtime.json``。"""

    config_path = Path(path)
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeConfigError(f"无法读取运行配置 {config_path}: {error.__class__.__name__}") from error

    root = _object(raw, "根配置", {"http", "audio", "agent"})
    http = _object(root.get("http"), "http", {"host", "port"})
    audio = _object(
        root.get("audio"),
        "audio",
        {"backend", "device", "poolSize", "blockSamples", "sampleRate"},
    )
    agent_raw = _object(
        root.get("agent"),
        "agent",
        {"mode", "timeoutSeconds", "local", "cloud"},
    )

    engine = EngineConfig(
        host=_string(http.get("host"), "http.host"),
        port=_integer(http.get("port"), "http.port"),
        sample_rate=_integer(audio.get("sampleRate", DEFAULT_SAMPLE_RATE), "audio.sampleRate"),
        block_samples=_integer(audio.get("blockSamples"), "audio.blockSamples"),
        pool_size=_integer(audio.get("poolSize"), "audio.poolSize"),
        backend=_string(audio.get("backend"), "audio.backend"),
        device=_string(audio.get("device"), "audio.device"),
        strict_backend=True,
    )
    try:
        engine.validate()
    except ValueError as error:
        raise RuntimeConfigError(str(error)) from error

    mode = _string(agent_raw.get("mode"), "agent.mode")
    if mode not in {"local", "cloud", "rules"}:
        raise RuntimeConfigError(f"agent.mode 不支持: {mode}")
    timeout_seconds = _positive_number(agent_raw.get("timeoutSeconds"), "agent.timeoutSeconds")

    local = _provider_object(agent_raw.get("local", {}), "agent.local", cloud=False)
    cloud = _provider_object(agent_raw.get("cloud", {}), "agent.cloud", cloud=True)
    selected: ResolvedAgent | None = None
    env = os.environ if environ is None else environ

    if mode == "local":
        selected = ResolvedAgent(
            mode=mode,
            base_url=_provider_url(local.get("baseUrl"), "agent.local.baseUrl"),
            model=_string(local.get("model"), "agent.local.model"),
        )
    elif mode == "cloud":
        key_name = _string(cloud.get("apiKeyEnv"), "agent.cloud.apiKeyEnv")
        key = env.get(key_name, "").strip()
        if not key:
            raise RuntimeConfigError(f"cloud 模式缺少环境变量 {key_name}")
        selected = ResolvedAgent(
            mode=mode,
            base_url=_provider_url(cloud.get("baseUrl"), "agent.cloud.baseUrl"),
            model=_string(cloud.get("model"), "agent.cloud.model"),
            api_key=key,
        )

    return RuntimeSettings(
        engine=engine,
        agent_mode=mode,
        agent=selected,
        timeout_seconds=timeout_seconds,
    )
