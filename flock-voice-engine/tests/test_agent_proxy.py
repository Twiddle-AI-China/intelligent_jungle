"""同源 Agent 代理的网络边界测试。"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from server.agent_proxy import register_agent_routes
from server.app import build_app
from server.config import EngineConfig
from server.runtime_config import ResolvedAgent


class Upstream:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.app = web.Application()
        self.app.router.add_get("/v1/models", self.models)
        self.app.router.add_post("/v1/chat/completions", self.completions)

    async def models(self, request: web.Request) -> web.Response:
        self.requests.append({"route": "models", "authorization": request.headers.get("Authorization")})
        return web.json_response({"object": "list", "data": [{"id": "upstream-model"}]})

    async def completions(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        self.requests.append(
            {
                "route": "completions",
                "authorization": request.headers.get("Authorization"),
                "body": body,
            }
        )
        content = body.get("messages", [{}])[-1].get("content")
        if content == "slow":
            await asyncio.sleep(0.2)
        if body.get("stream"):
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await response.prepare(request)
            await response.write(b'data: {"delta":"one"}\n\n')
            await response.write(b'data: [DONE]\n\n')
            await response.write_eof()
            return response
        return web.json_response(
            {"choices": [{"message": {"content": '{"reason":"保持生态平衡"}'}}]}
        )


class AgentProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.upstream = Upstream()
        self.upstream_server = TestServer(self.upstream.app)
        await self.upstream_server.start_server()
        self.clients: list[TestClient] = []

    async def asyncTearDown(self) -> None:
        for client in self.clients:
            await client.close()
        await self.upstream_server.close()

    def upstream_base(self) -> str:
        return str(self.upstream_server.make_url("/v1")).rstrip("/")

    async def proxy(
        self,
        agent: ResolvedAgent | None,
        timeout_seconds: float = 1,
    ) -> tuple[TestClient, object]:
        app = web.Application(client_max_size=2 * 1024 * 1024)
        state = register_agent_routes(app, agent, timeout_seconds)
        client = TestClient(TestServer(app))
        await client.start_server()
        self.clients.append(client)
        return client, state

    async def test_local_forwards_without_authorization_and_replaces_model(self) -> None:
        client, state = await self.proxy(
            ResolvedAgent("local", self.upstream_base(), "bird_agent")
        )
        models = await client.get("/api/agent/v1/models")
        self.assertEqual(models.status, 200)
        response = await client.post(
            "/api/agent/v1/chat/completions",
            json={
                "model": "browser-must-not-select",
                "messages": [{"role": "user", "content": "state"}],
                "temperature": 0,
                "response_format": {"type": "json_schema", "json_schema": {"name": "decision"}},
            },
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(self.upstream.requests[0]["authorization"], None)
        forwarded = self.upstream.requests[1]
        self.assertEqual(forwarded["authorization"], None)
        self.assertEqual(forwarded["body"]["model"], "bird_agent")
        self.assertEqual(forwarded["body"]["response_format"]["type"], "json_schema")
        self.assertTrue(state.public_status()["available"])

    async def test_cloud_injects_server_key_but_public_status_is_sanitized(self) -> None:
        client, state = await self.proxy(
            ResolvedAgent(
                "cloud",
                self.upstream_base(),
                "deepseek-v4-flash",
                api_key="test-cloud-key",
            )
        )
        response = await client.post(
            "/api/agent/v1/chat/completions",
            json={"model": "ignored", "messages": [{"role": "user", "content": "state"}]},
        )
        self.assertEqual(response.status, 200)
        forwarded = self.upstream.requests[-1]
        self.assertEqual(forwarded["authorization"], "Bearer test-cloud-key")
        self.assertEqual(forwarded["body"]["model"], "deepseek-v4-flash")
        rendered = repr(state.public_status())
        self.assertNotIn("test-cloud-key", rendered)
        self.assertNotIn(self.upstream_base(), rendered)

    async def test_streaming_response_is_passed_through_byte_for_byte(self) -> None:
        client, _ = await self.proxy(ResolvedAgent("local", self.upstream_base(), "bird_agent"))
        response = await client.post(
            "/api/agent/v1/chat/completions",
            json={"stream": True, "messages": [{"role": "user", "content": "state"}]},
        )
        self.assertEqual(response.status, 200)
        self.assertTrue(response.headers["Content-Type"].startswith("text/event-stream"))
        self.assertEqual(
            await response.read(),
            b'data: {"delta":"one"}\n\ndata: [DONE]\n\n',
        )

    async def test_rules_mode_is_explicitly_unavailable_for_browser_fallback(self) -> None:
        client, state = await self.proxy(None)
        response = await client.get("/api/agent/v1/models")
        self.assertEqual(response.status, 503)
        payload = await response.json()
        self.assertEqual(payload["error"]["type"], "rules_mode")
        self.assertEqual(state.public_status()["mode"], "rules")

    async def test_timeout_is_504_and_does_not_expose_upstream(self) -> None:
        client, state = await self.proxy(
            ResolvedAgent("local", self.upstream_base(), "bird_agent"),
            timeout_seconds=0.02,
        )
        response = await client.post(
            "/api/agent/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "slow"}]},
        )
        self.assertEqual(response.status, 504)
        payload = await response.json()
        self.assertEqual(payload["error"]["type"], "upstream_timeout")
        rendered = repr(payload) + repr(state.public_status())
        self.assertNotIn(self.upstream_base(), rendered)

    async def test_main_audio_app_exposes_sanitized_runtime_status(self) -> None:
        app = build_app(
            EngineConfig(backend="synth", pool_size=2),
            agent=None,
            agent_timeout_seconds=1,
        )
        client = TestClient(TestServer(app))
        await client.start_server()
        self.clients.append(client)

        response = await client.get("/api/runtime-status")
        self.assertEqual(response.status, 200)
        payload = await response.json()
        self.assertEqual(payload["audio"]["requestedBackend"], "synth")
        self.assertEqual(payload["audio"]["loadedBackend"], "synth-s")
        self.assertEqual(payload["audio"]["mode"], "fallback")
        self.assertEqual(payload["agent"]["mode"], "rules")
        models = await client.get("/api/agent/v1/models")
        self.assertEqual(models.status, 503)

    async def test_strict_backend_rejects_silent_synth_fallback(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "missing-neural-backend"):
            build_app(
                EngineConfig(backend="missing-neural-backend", strict_backend=True),
                agent=None,
            )


if __name__ == "__main__":
    unittest.main()
