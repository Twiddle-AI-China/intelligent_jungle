"""独立站点组装测试。"""
from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.assemble_web import assemble


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


class AssembleWebTests(unittest.TestCase):
    def test_builds_complete_same_origin_site_without_provider_secrets(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            output = Path(directory) / "web"
            assemble(ROOT, output)
            for relative in (
                "index.html",
                "src/main.js",
                "eval/harness.js",
                "_client/voice-client.js",
                "_client/pcm-player-worklet.js",
                "runtime-config.js",
            ):
                self.assertTrue((output / relative).is_file(), relative)

            runtime = (output / "runtime-config.js").read_text(encoding="utf-8")
            self.assertEqual(
                runtime,
                "// 由 scripts/assemble_web.py 生成；只指向同源服务。\n"
                "window.LCS_RUNTIME = { stepfunBase: '/api/agent' };\n",
            )
            lowered = runtime.lower()
            for forbidden in ("8081", "apikey", "authorization", "deepseek", "http://", "https://"):
                self.assertNotIn(forbidden, lowered)
            self.assertFalse((output / "test").exists())
            self.assertFalse((output / "local-config.js").exists())

    def test_repeated_build_is_byte_deterministic(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            output = Path(directory) / "web"
            assemble(ROOT, output)
            first = tree_hashes(output)
            assemble(ROOT, output)
            self.assertEqual(tree_hashes(output), first)

    def test_source_runtime_config_also_uses_same_origin_proxy(self) -> None:
        runtime = (ROOT / "mvp" / "runtime-config.js").read_text(encoding="utf-8")
        self.assertIn("stepfunBase: '/api/agent'", runtime)
        self.assertNotIn("8081", runtime)


if __name__ == "__main__":
    unittest.main()
