"""神经音源 Release 下载器测试。"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.model_assets import (
    AssetVerificationError,
    install_assets,
    verify_assets,
)


class ModelAssetTests(unittest.TestCase):
    DATA = b"deterministic-neural-audio-checkpoint"

    def manifest(self, directory: Path) -> Path:
        path = directory / "manifest.json"
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "releaseTag": "test-tag",
                    "baseUrl": "https://assets.invalid/test-tag",
                    "assets": [
                        {
                            "filename": "voice.pt",
                            "bytes": len(self.DATA),
                            "sha256": hashlib.sha256(self.DATA).hexdigest(),
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_valid_existing_asset_skips_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "models"
            output.mkdir()
            (output / "voice.pt").write_bytes(self.DATA)

            def forbidden_runner(command, check):
                self.fail(f"不应调用 curl: {command}, check={check}")

            installed = install_assets(self.manifest(root), output, runner=forbidden_runner)
            self.assertEqual(installed, [output / "voice.pt"])

    def test_partial_download_uses_curl_resume_and_atomic_final_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "models"
            output.mkdir()
            part = output / "voice.pt.part"
            part.write_bytes(self.DATA[:8])
            calls: list[list[str]] = []

            def runner(command, check):
                calls.append(command)
                self.assertTrue(check)
                self.assertIn("-C", command)
                self.assertEqual(command[command.index("-C") + 1], "-")
                target = Path(command[command.index("--output") + 1])
                target.write_bytes(self.DATA)
                return subprocess.CompletedProcess(command, 0)

            installed = install_assets(self.manifest(root), output, runner=runner)
            self.assertEqual(len(calls), 1)
            self.assertEqual(installed[0].read_bytes(), self.DATA)
            self.assertFalse(part.exists())

    def test_wrong_checksum_never_becomes_final_asset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "models"

            def runner(command, check):
                target = Path(command[command.index("--output") + 1])
                target.write_bytes(b"x" * len(self.DATA))
                return subprocess.CompletedProcess(command, 0)

            with self.assertRaisesRegex(AssetVerificationError, "SHA-256"):
                install_assets(self.manifest(root), output, runner=runner)
            self.assertFalse((output / "voice.pt").exists())
            self.assertFalse((output / "voice.pt.part").exists())

    def test_range_error_retries_once_from_zero(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "models"
            output.mkdir()
            (output / "voice.pt.part").write_bytes(b"old-part")
            calls = 0

            def runner(command, check):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise subprocess.CalledProcessError(33, command)
                target = Path(command[command.index("--output") + 1])
                self.assertFalse(target.exists())
                target.write_bytes(self.DATA)
                return subprocess.CompletedProcess(command, 0)

            install_assets(self.manifest(root), output, runner=runner)
            self.assertEqual(calls, 2)

    def test_environment_can_override_url_but_not_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "models"
            urls: list[str] = []

            def runner(command, check):
                urls.append(command[-1])
                Path(command[command.index("--output") + 1]).write_bytes(self.DATA)
                return subprocess.CompletedProcess(command, 0)

            with patch.dict(os.environ, {"LCS_MODEL_RELEASE_BASE_URL": "https://mirror.invalid/audio"}):
                install_assets(self.manifest(root), output, runner=runner)
            self.assertEqual(urls, ["https://mirror.invalid/audio/voice.pt"])
            verify_assets(self.manifest(root), output)


if __name__ == "__main__":
    unittest.main()
