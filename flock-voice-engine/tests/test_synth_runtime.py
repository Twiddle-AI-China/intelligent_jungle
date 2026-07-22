"""无 GPU 环境下对发行验证器做真实 HTTP/WS 冒烟。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

from aiohttp.test_utils import TestServer

ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ENGINE_ROOT.parent
sys.path.insert(0, str(ENGINE_ROOT))
sys.path.insert(0, str(REPOSITORY_ROOT))

from scripts.verify_runtime import verify_runtime
from server.app import build_app
from server.config import EngineConfig


class SynthRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_verifier_observes_health_status_and_nonzero_pcm(self) -> None:
        app = build_app(
            EngineConfig(
                host="127.0.0.1",
                port=8090,
                backend="synth",
                pool_size=2,
                block_samples=512,
            ),
            agent=None,
        )
        server = TestServer(app)
        await server.start_server()
        try:
            summary = await verify_runtime(
                str(server.make_url("/")).rstrip("/"),
                require_neural=False,
                require_static=False,
                require_agent=False,
            )
        finally:
            await server.close()

        self.assertEqual(summary["backend"], "synth-s")
        self.assertEqual(summary["agentMode"], "rules")
        self.assertGreater(summary["pcmPeak"], 0)
        self.assertTrue(summary["pcmFinite"])


if __name__ == "__main__":
    unittest.main()
