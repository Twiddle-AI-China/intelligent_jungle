"""验证已运行的独立发行版 HTTP、Agent 与实时 PCM。"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

import aiohttp
import numpy as np


class VerificationError(RuntimeError):
    """运行实例不满足发行契约。"""


async def _json(
    session: aiohttp.ClientSession,
    url: str,
    expected_status: int = 200,
) -> dict[str, Any]:
    async with session.get(url) as response:
        if response.status != expected_status:
            raise VerificationError(f"{url} 返回 HTTP {response.status}，期望 {expected_status}")
        try:
            payload = await response.json()
        except (aiohttp.ContentTypeError, json.JSONDecodeError) as error:
            raise VerificationError(f"{url} 没有返回合法 JSON") from error
    if not isinstance(payload, dict):
        raise VerificationError(f"{url} JSON 根节点不是 object")
    return payload


async def verify_runtime(
    base_url: str,
    *,
    require_neural: bool = True,
    require_static: bool = True,
    require_agent: bool = True,
) -> dict[str, Any]:
    """验证服务并返回可打印摘要；失败时抛出 ``VerificationError``。"""

    base = base_url.rstrip("/")
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        health = await _json(session, f"{base}/healthz")
        decoder = await _json(session, f"{base}/api/decoder-status")
        runtime = await _json(session, f"{base}/api/runtime-status")

        if health.get("ok") is not True:
            raise VerificationError("healthz 未报告 ok=true")
        if not isinstance(decoder.get("models"), list) or not decoder["models"]:
            raise VerificationError("decoder-status 缺少模型自述")
        audio = runtime.get("audio")
        agent = runtime.get("agent")
        if not isinstance(audio, dict) or not isinstance(agent, dict):
            raise VerificationError("runtime-status 缺少 audio/agent")

        if require_neural:
            if health.get("backend") != "brave-voices":
                raise VerificationError(f"实际后端不是 brave-voices: {health.get('backend')}")
            if audio.get("mode") != "neural" or audio.get("loadedBackend") != "brave-voices":
                raise VerificationError("runtime-status 未确认生产神经音源")
            if decoder.get("poolSize") != 5 or decoder.get("blockSamples") != 4096:
                raise VerificationError("生产参数必须是 poolSize=5、blockSamples=4096")
            rows = decoder["models"][0].get("rowsBySpecies", {})
            if rows.get("pad") != [1, 4]:
                raise VerificationError(f"pad 行映射必须是 [1, 4]，实际是 {rows.get('pad')}")

        if require_static:
            for path in (
                "/",
                "/src/main.js",
                "/_client/voice-client.js",
                "/_client/pcm-player-worklet.js",
                "/runtime-config.js",
            ):
                async with session.get(f"{base}{path}") as response:
                    if response.status != 200:
                        raise VerificationError(f"静态资源 {path} 返回 HTTP {response.status}")
                    await response.read()

        if require_agent:
            mode = agent.get("mode")
            expected = 503 if mode == "rules" else 200
            async with session.get(f"{base}/api/agent/v1/models") as response:
                if response.status != expected:
                    raise VerificationError(
                        f"Agent 模式 {mode} 的 models 路由返回 {response.status}，期望 {expected}"
                    )
                await response.read()

        peak = 0.0
        finite = True
        async with session.ws_connect(f"{base}/decoder?split=1", max_msg_size=0) as socket:
            ready_message = await asyncio.wait_for(socket.receive(), timeout=10)
            if ready_message.type is not aiohttp.WSMsgType.TEXT:
                raise VerificationError("WebSocket 首帧不是 ready JSON")
            ready = json.loads(ready_message.data)
            if ready.get("type") != "ready":
                raise VerificationError("WebSocket 未返回 ready")

            await socket.send_json({
                "type": "note",
                "voice": 0,
                "midi": 48,
                "velocity": 0.9,
                "durationSeconds": 0.8,
                "timbre": "bass",
            })
            for _ in range(40):
                message = await asyncio.wait_for(socket.receive(), timeout=10)
                if message.type is aiohttp.WSMsgType.BINARY:
                    block = np.frombuffer(message.data, dtype="<f4")
                    if block.size == 0:
                        continue
                    finite = finite and bool(np.isfinite(block).all())
                    peak = max(peak, float(np.max(np.abs(block))))
                    if finite and peak > 1e-6:
                        break
                elif message.type in {
                    aiohttp.WSMsgType.CLOSE,
                    aiohttp.WSMsgType.CLOSED,
                    aiohttp.WSMsgType.ERROR,
                }:
                    raise VerificationError("收到有效 PCM 前 WebSocket 已关闭")

        if not finite:
            raise VerificationError("PCM 包含 NaN 或 Inf")
        if peak <= 1e-6:
            raise VerificationError("未收到非零 PCM，音源可能静默降级")

    return {
        "backend": health.get("backend"),
        "agentMode": agent.get("mode"),
        "pcmPeak": peak,
        "pcmFinite": finite,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="验收 Intelligent Jungle 运行实例")
    parser.add_argument("base_url", nargs="?", default="http://127.0.0.1:8090")
    parser.add_argument("--allow-fallback", action="store_true")
    parser.add_argument("--skip-static", action="store_true")
    parser.add_argument("--skip-agent", action="store_true")
    args = parser.parse_args()
    try:
        summary = asyncio.run(
            verify_runtime(
                args.base_url,
                require_neural=not args.allow_fallback,
                require_static=not args.skip_static,
                require_agent=not args.skip_agent,
            )
        )
    except (VerificationError, aiohttp.ClientError, asyncio.TimeoutError) as error:
        print(f"验收失败: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("独立发行版运行验收通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
