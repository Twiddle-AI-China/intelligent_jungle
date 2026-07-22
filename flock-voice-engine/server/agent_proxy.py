"""同源 OpenAI 兼容 Agent 代理。

浏览器只知道 ``/api/agent``。本模块根据服务端已解析配置选择本地或云端上游，
并确保云端密钥不会出现在浏览器可见配置、响应或状态接口中。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from aiohttp import ClientError, ClientSession, ClientTimeout, web

from .runtime_config import ResolvedAgent

MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024


@dataclass
class AgentProxyState:
    """代理的可观测状态；私有字段不参与 repr。"""

    mode: str
    available: bool = False
    last_error: str | None = None
    _session: ClientSession | None = field(default=None, repr=False)

    def public_status(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "configured": self.mode != "rules",
            "available": self.available,
            "lastError": self.last_error,
        }


AGENT_PROXY_STATE = web.AppKey("agent_proxy_state", AgentProxyState)


def _error(status: int, error_type: str, message: str) -> web.Response:
    return web.json_response(
        {"error": {"type": error_type, "message": message}},
        status=status,
    )


def register_agent_routes(
    app: web.Application,
    agent: ResolvedAgent | None,
    timeout_seconds: float,
) -> AgentProxyState:
    """注册同源代理路由并返回脱敏状态对象。"""

    state = AgentProxyState(mode="rules" if agent is None else agent.mode)
    app[AGENT_PROXY_STATE] = state

    async def session_context(application: web.Application):
        if agent is not None:
            state._session = ClientSession(timeout=ClientTimeout(total=timeout_seconds))
        yield
        if state._session is not None:
            await state._session.close()
            state._session = None

    async def forward(request: web.Request, endpoint: str) -> web.StreamResponse:
        if agent is None:
            return _error(503, "rules_mode", "当前使用确定性规则，不调用网络 Agent")
        if state._session is None:
            state.last_error = "proxy_not_ready"
            return _error(503, "proxy_not_ready", "Agent 代理尚未就绪")

        headers = {"Accept": request.headers.get("Accept", "application/json")}
        if agent.mode == "cloud" and agent.api_key:
            headers["Authorization"] = f"Bearer {agent.api_key}"

        request_kwargs: dict[str, Any] = {"headers": headers}
        if request.method == "POST":
            try:
                body = await request.json()
            except Exception:  # aiohttp 可因 MIME 或 JSON 语法抛不同异常
                return _error(400, "invalid_json", "请求体必须是 JSON object")
            if not isinstance(body, dict):
                return _error(400, "invalid_json", "请求体必须是 JSON object")
            body["model"] = agent.model
            request_kwargs["json"] = body

        url = f"{agent.base_url}/{endpoint}"
        try:
            async with state._session.request(request.method, url, **request_kwargs) as upstream:
                state.available = 200 <= upstream.status < 400
                state.last_error = None if state.available else f"upstream_http_{upstream.status}"
                response_headers: dict[str, str] = {}
                content_type = upstream.headers.get("Content-Type")
                if content_type:
                    response_headers["Content-Type"] = content_type
                cache_control = upstream.headers.get("Cache-Control")
                if cache_control:
                    response_headers["Cache-Control"] = cache_control
                response = web.StreamResponse(status=upstream.status, headers=response_headers)
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await response.write(chunk)
                await response.write_eof()
                return response
        except asyncio.TimeoutError:
            state.available = False
            state.last_error = "upstream_timeout"
            return _error(504, "upstream_timeout", "Agent 上游请求超时")
        except ClientError:
            state.available = False
            state.last_error = "upstream_unavailable"
            return _error(502, "upstream_unavailable", "Agent 上游不可用")

    async def models(request: web.Request) -> web.StreamResponse:
        return await forward(request, "models")

    async def completions(request: web.Request) -> web.StreamResponse:
        return await forward(request, "chat/completions")

    app.cleanup_ctx.append(session_context)
    app.router.add_get("/api/agent/v1/models", models)
    app.router.add_post("/api/agent/v1/chat/completions", completions)
    return state
