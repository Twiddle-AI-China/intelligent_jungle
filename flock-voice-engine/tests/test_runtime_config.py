"""独立发行版单文件运行配置契约。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from server.runtime_config import RuntimeConfigError, load_runtime_config


def base_config() -> dict[str, object]:
    return {
        "http": {"host": "0.0.0.0", "port": 8090},
        "audio": {
            "backend": "brave-voices",
            "device": "cuda",
            "poolSize": 5,
            "blockSamples": 4096,
        },
        "agent": {
            "mode": "local",
            "timeoutSeconds": 60,
            "local": {
                "baseUrl": "http://host.docker.internal:8081/v1/",
                "model": "bird_agent",
            },
            "cloud": {
                "baseUrl": "",
                "model": "",
                "apiKeyEnv": "LCS_AGENT_API_KEY",
            },
        },
    }


class RuntimeConfigTests(unittest.TestCase):
    def load(self, payload: dict[str, object], environ: dict[str, str] | None = None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return load_runtime_config(path, environ={} if environ is None else environ)

    def test_local_mode_reuses_current_bird_agent_contract(self) -> None:
        settings = self.load(base_config())
        self.assertEqual(settings.engine.backend, "brave-voices")
        self.assertEqual(settings.engine.device, "cuda")
        self.assertEqual(settings.engine.pool_size, 5)
        self.assertEqual(settings.engine.block_samples, 4096)
        self.assertTrue(settings.engine.strict_backend)
        self.assertEqual(settings.timeout_seconds, 60)
        self.assertIsNotNone(settings.agent)
        self.assertEqual(settings.agent.mode, "local")
        self.assertEqual(settings.agent.base_url, "http://host.docker.internal:8081/v1")
        self.assertEqual(settings.agent.model, "bird_agent")
        self.assertIsNone(settings.agent.api_key)

    def test_rules_mode_ignores_empty_provider_sections(self) -> None:
        payload = base_config()
        payload["agent"] = {
            "mode": "rules",
            "timeoutSeconds": 5,
            "local": {"baseUrl": "", "model": ""},
            "cloud": {"baseUrl": "", "model": "", "apiKeyEnv": "LCS_AGENT_API_KEY"},
        }
        settings = self.load(payload)
        self.assertIsNone(settings.agent)
        self.assertEqual(settings.agent_mode, "rules")

    def test_cloud_mode_requires_server_environment_key_and_hides_it_from_repr(self) -> None:
        payload = base_config()
        payload["agent"]["mode"] = "cloud"
        payload["agent"]["cloud"] = {
            "baseUrl": "https://api.deepseek.com/v1",
            "model": "deepseek-v4-flash",
            "apiKeyEnv": "LCS_AGENT_API_KEY",
        }
        with self.assertRaisesRegex(RuntimeConfigError, "LCS_AGENT_API_KEY"):
            self.load(payload)

        settings = self.load(payload, {"LCS_AGENT_API_KEY": "test-cloud-secret"})
        self.assertEqual(settings.agent.mode, "cloud")
        self.assertEqual(settings.agent.api_key, "test-cloud-secret")
        self.assertNotIn("test-cloud-secret", repr(settings))

    def test_unknown_keys_are_rejected_at_every_level(self) -> None:
        payload = base_config()
        payload["audio"]["silentFallback"] = True
        with self.assertRaisesRegex(RuntimeConfigError, "silentFallback"):
            self.load(payload)

    def test_selected_provider_requires_http_url_and_model(self) -> None:
        for url in ("host.docker.internal:8081/v1", "file:///tmp/model"):
            payload = base_config()
            payload["agent"]["local"]["baseUrl"] = url
            with self.subTest(url=url), self.assertRaises(RuntimeConfigError):
                self.load(payload)

        payload = base_config()
        payload["agent"]["local"]["model"] = ""
        with self.assertRaises(RuntimeConfigError):
            self.load(payload)

    def test_invalid_mode_and_audio_bounds_fail_at_startup(self) -> None:
        payload = base_config()
        payload["agent"]["mode"] = "automatic"
        with self.assertRaisesRegex(RuntimeConfigError, "automatic"):
            self.load(payload)

        for key, value in (("poolSize", 0), ("blockSamples", 16)):
            payload = base_config()
            payload["audio"][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeConfigError):
                self.load(payload)

    def test_repository_paths_do_not_use_old_production_mounts(self) -> None:
        from server.paths import LOAD_LOG_PATH, MODEL_DIR

        for path in (MODEL_DIR, LOAD_LOG_PATH):
            rendered = str(path).replace("\\", "/")
            self.assertNotIn("/data/model_weights", rendered)
            self.assertNotIn("/home/rolf", rendered)
            self.assertNotIn("/srv/deploy", rendered)


if __name__ == "__main__":
    unittest.main()
