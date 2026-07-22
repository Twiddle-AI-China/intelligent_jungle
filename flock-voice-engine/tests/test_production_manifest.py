from __future__ import annotations

import tempfile
import unittest
import importlib.util
import hashlib
import json
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load_manifest_module():
    path = Path(__file__).resolve().parents[1] / "tools" / "production_manifest.py"
    spec = importlib.util.spec_from_file_location("production_manifest", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ProductionManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.snapshot = self.root / "snapshot"
        self.repository = self.root / "repository"
        (self.snapshot / "web/src").mkdir(parents=True)
        (self.repository / "mvp/src").mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_normalizes_text_but_not_binary_and_never_hashes_runtime_config(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/main.js").write_bytes(b"export const x = 1;\r\n")
        (self.repository / "mvp/src/main.js").write_bytes(b"export const x = 1;\n")
        (self.snapshot / "web/src/backup-policy.js").write_text("export const safe = true;\n", encoding="utf-8")
        (self.repository / "mvp/src/backup-policy.js").write_text("export const safe = true;\n", encoding="utf-8")
        (self.snapshot / ".gitignore").write_bytes(b"logs/\r\n")
        (self.repository / "flock-voice-engine").mkdir(exist_ok=True)
        (self.repository / "flock-voice-engine/.gitignore").write_bytes(b"logs/\n")
        (self.snapshot / "web/assets").mkdir()
        (self.repository / "mvp/assets").mkdir()
        production_binary = b"\x89PNG\r\n\xff"
        repository_binary = b"\x89PNG\n\xff"
        (self.snapshot / "web/assets/icon.png").write_bytes(production_binary)
        (self.repository / "mvp/assets/icon.png").write_bytes(repository_binary)
        (self.snapshot / "web/runtime-config.js").write_text("window.SECRET='hidden'", encoding="utf-8")
        repository_runtime = self.repository / "mvp/runtime-config.js"
        repository_runtime.write_text("window.SECRET='repository-hidden'", encoding="utf-8")
        (self.snapshot / "deploy").mkdir()
        remote_secret_text = "REMOTE_" + "PASS=hidden"
        repository_remote_secret_text = "REMOTE_" + "PASS=repository-hidden"
        historical_credential_text = "密" + "码: historical-hidden"
        repository_credential_text = "pass" + "word=repository-hidden"
        (self.snapshot / "deploy/sync.sh").write_text(remote_secret_text, encoding="utf-8")
        (self.repository / "flock-voice-engine/deploy").mkdir(parents=True)
        repository_sync = self.repository / "flock-voice-engine/deploy/sync.sh"
        repository_sync.write_text(repository_remote_secret_text, encoding="utf-8")
        (self.snapshot / "docs").mkdir()
        snapshot_deploy_doc = self.snapshot / "docs/deploy.md"
        snapshot_deploy_doc.write_text(historical_credential_text, encoding="utf-8")
        snapshot_handoff = self.snapshot / "docs/HANDOFF.md"
        snapshot_handoff.write_text(historical_credential_text, encoding="utf-8")
        snapshot_model_notes = self.snapshot / "docs/model-notes.md"
        snapshot_model_notes.write_text(historical_credential_text, encoding="utf-8")
        (self.repository / "flock-voice-engine/docs").mkdir(parents=True)
        repository_deploy_doc = self.repository / "flock-voice-engine/docs/deploy.md"
        repository_deploy_doc.write_text(repository_credential_text, encoding="utf-8")
        repository_handoff = self.repository / "flock-voice-engine/docs/HANDOFF.md"
        repository_handoff.write_text(repository_credential_text, encoding="utf-8")
        repository_model_notes = self.repository / "flock-voice-engine/docs/model-notes.md"
        repository_model_notes.write_text(repository_credential_text, encoding="utf-8")
        (self.snapshot / "server").mkdir()
        (self.repository / "flock-voice-engine/server").mkdir(parents=True)
        snapshot_env = self.snapshot / "server/.env"
        repository_env = self.repository / "flock-voice-engine/server/.env"
        snapshot_key = self.snapshot / "server/private.pem"
        repository_key = self.repository / "flock-voice-engine/server/private.pem"
        snapshot_weight = self.snapshot / "server/model.ckpt"
        repository_weight = self.repository / "flock-voice-engine/server/model.ckpt"
        snapshot_env.write_text("should-not-read", encoding="utf-8")
        repository_env.write_text("should-not-read", encoding="utf-8")
        snapshot_key.write_bytes(b"should-not-read")
        repository_key.write_bytes(b"should-not-read")
        snapshot_weight.write_bytes(b"should-not-read")
        repository_weight.write_bytes(b"should-not-read")
        (self.snapshot / "checkpoint").mkdir()
        snapshot_checkpoint = self.snapshot / "checkpoint/model.bin"
        snapshot_checkpoint.write_bytes(b"should-not-read")
        sensitive_paths = {
            (self.snapshot / "web/runtime-config.js").resolve(),
            repository_runtime.resolve(),
            (self.snapshot / "deploy/sync.sh").resolve(),
            repository_sync.resolve(),
            snapshot_deploy_doc.resolve(),
            repository_deploy_doc.resolve(),
            snapshot_handoff.resolve(),
            repository_handoff.resolve(),
            snapshot_model_notes.resolve(),
            repository_model_notes.resolve(),
            snapshot_env.resolve(),
            repository_env.resolve(),
            snapshot_key.resolve(),
            repository_key.resolve(),
            snapshot_weight.resolve(),
            repository_weight.resolve(),
            snapshot_checkpoint.resolve(),
        }
        original_read = module.read_file_bytes

        def guarded_read(path: Path, root: Path) -> bytes:
            if path.resolve() in sensitive_paths:
                raise AssertionError(f"敏感文件不允许被读取: {path.name}")
            return original_read(path, root)

        with patch.object(module, "read_file_bytes", side_effect=guarded_read):
            report = module.build_manifest(self.snapshot, self.repository, {}, {})
        entries = {entry["repositoryPath"]: entry for entry in report["entries"]}
        self.assertEqual(entries["mvp/src/main.js"]["status"], "same")
        self.assertEqual(entries["mvp/src/backup-policy.js"]["status"], "same")
        self.assertEqual(entries["flock-voice-engine/.gitignore"]["status"], "same")
        self.assertEqual(entries["mvp/assets/icon.png"]["status"], "changed")
        self.assertEqual(
            entries["mvp/assets/icon.png"]["productionSha256"],
            hashlib.sha256(production_binary).hexdigest(),
        )
        self.assertEqual(
            entries["mvp/assets/icon.png"]["repositorySha256"],
            hashlib.sha256(repository_binary).hexdigest(),
        )
        self.assertNotIn("window.SECRET", str(report))
        self.assertNotIn(remote_secret_text, str(report))
        excluded = {item["productionPath"] for item in report["excluded"]}
        self.assertIn("web/runtime-config.js", excluded)
        self.assertIn("deploy/sync.sh", excluded)
        self.assertIn("docs/deploy.md", excluded)
        self.assertIn("docs/HANDOFF.md", excluded)
        self.assertIn("docs/model-notes.md", excluded)
        self.assertIn("server/.env", excluded)
        self.assertIn("server/private.pem", excluded)
        self.assertIn("server/model.ckpt", excluded)
        self.assertIn("checkpoint/model.bin", excluded)

    def test_rejects_snapshot_and_repository_links_before_reading_target(self) -> None:
        module = load_manifest_module()
        fake_reparse = SimpleNamespace(
            st_mode=stat.S_IFREG,
            st_file_attributes=getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400),
        )
        with patch.object(Path, "lstat", return_value=fake_reparse):
            with self.assertRaisesRegex(module.UnsafeManifestPathError, "link|reparse"):
                module.read_file_bytes(self.snapshot / "web/src/main.js", self.snapshot)

        outside = self.root / "outside-secret.js"
        outside.write_text("must-not-open", encoding="utf-8")
        cases = (
            self.snapshot / "web/src/linked.js",
            self.repository / "mvp/src/linked.js",
        )
        for link in cases:
            with self.subTest(link=link):
                try:
                    link.symlink_to(outside)
                except (OSError, NotImplementedError) as error:
                    self.skipTest(f"当前平台不能创建测试 symlink: {error}")
                try:
                    with self.assertRaisesRegex(module.UnsafeManifestPathError, "link|reparse|root"):
                        module.build_manifest(self.snapshot, self.repository, {}, {})
                finally:
                    link.unlink(missing_ok=True)

        outside_snapshot = self.root / "outside-snapshot"
        outside_repository = self.root / "outside-repository"
        outside_snapshot.mkdir()
        outside_repository.mkdir()
        root_cases = (
            (self.root / "snapshot-root-link", outside_snapshot, self.repository),
            (self.root / "repository-root-link", outside_repository, self.snapshot),
        )
        for root_link, target, other_root in root_cases:
            with self.subTest(root_link=root_link):
                try:
                    root_link.symlink_to(target, target_is_directory=True)
                except (OSError, NotImplementedError) as error:
                    self.skipTest(f"当前平台不能创建 root symlink: {error}")
                try:
                    roots = (
                        (root_link, other_root)
                        if "snapshot" in root_link.name
                        else (other_root, root_link)
                    )
                    with self.assertRaisesRegex(module.UnsafeManifestPathError, "link|reparse|root"):
                        module.build_manifest(*roots, {}, {})
                finally:
                    root_link.unlink(missing_ok=True)

    def test_marks_changed_and_production_only_as_unreviewed(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/main.js").write_text("old", encoding="utf-8")
        (self.repository / "mvp/src/main.js").write_text("new", encoding="utf-8")
        (self.snapshot / "server").mkdir()
        (self.snapshot / "server/brave.py").write_text("dead", encoding="utf-8")
        report = module.build_manifest(self.snapshot, self.repository, {}, {})
        self.assertEqual(report["summary"]["unreviewed"], 2)

    def test_applies_explicit_decision_and_sorts_entries(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/z.js").write_text("old", encoding="utf-8")
        (self.repository / "mvp/src/z.js").write_text("new", encoding="utf-8")
        decisions = {
            "decisions": {
                "mvp-src:changed:mvp/src/z.js": {
                    "disposition": "retain-repository",
                    "reason": "Git 版本来自已验证的后继提交",
                }
            }
        }
        report = module.build_manifest(self.snapshot, self.repository, {}, decisions)
        self.assertEqual(report["summary"]["unreviewed"], 0)
        self.assertEqual(
            report["entries"],
            sorted(
                report["entries"],
                key=lambda item: (item["mapping"], item["repositoryPath"], item["productionPath"]),
            ),
        )

    def test_unmapped_file_is_a_blocking_coverage_error(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "mystery.txt").write_text("unclaimed", encoding="utf-8")
        report = module.build_manifest(self.snapshot, self.repository, {}, {})
        self.assertEqual(report["summary"]["unmapped"], 1)
        self.assertEqual(report["summary"]["unreviewed"], 1)
        self.assertEqual(report["unmapped"][0]["productionPath"], "mystery.txt")

    def test_unused_decision_is_a_blocking_configuration_error(self) -> None:
        module = load_manifest_module()
        decisions = {
            "decisions": {
                "engine-server:changed:flock-voice-engine/server/missing.py": {
                    "disposition": "retain-repository",
                    "reason": "这个 key 故意不存在",
                }
            }
        }
        report = module.build_manifest(self.snapshot, self.repository, {}, decisions)
        self.assertEqual(report["summary"]["unusedDecisions"], 1)
        self.assertEqual(report["summary"]["unreviewed"], 1)
        self.assertEqual(
            report["unusedDecisions"],
            ["engine-server:changed:flock-voice-engine/server/missing.py"],
        )

    def test_output_bytes_are_stable_across_creation_order(self) -> None:
        module = load_manifest_module()
        metadata = {
            "capturedAt": "2026-07-22T16:32:54+08:00",
            "externalRuntimeInputs": {
                "vendor": {"treeSha256": "a" * 64, "regularFileCount": 3}
            },
        }
        roots = []
        for name, order in (("first", ("z.js", "a.js")), ("second", ("a.js", "z.js"))):
            snapshot = self.root / name / "snapshot"
            repository = self.root / name / "repository"
            (snapshot / "web/src").mkdir(parents=True)
            (repository / "mvp/src").mkdir(parents=True)
            for filename in order:
                (snapshot / "web/src" / filename).write_text(filename, encoding="utf-8")
                (repository / "mvp/src" / filename).write_text(filename, encoding="utf-8")
            output = self.root / name / "manifest.json"
            module.write_manifest(
                module.build_manifest(snapshot, repository, metadata, {}),
                output,
            )
            roots.append(output.read_bytes())
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8"))["metadata"],
                metadata,
            )
        self.assertEqual(roots[0], roots[1])
        self.assertEqual(
            metadata,
            {
                "capturedAt": "2026-07-22T16:32:54+08:00",
                "externalRuntimeInputs": {
                    "vendor": {"treeSha256": "a" * 64, "regularFileCount": 3}
                },
            },
        )

    def test_cli_without_decisions_writes_discovery_manifest_and_exits_two(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/main.js").write_text("deployed", encoding="utf-8")
        (self.repository / "mvp/src/main.js").write_text("canonical", encoding="utf-8")
        metadata = self.root / "metadata.json"
        output = self.root / "discovery.json"
        metadata.write_text("{}\n", encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(Path(module.__file__)),
                "--snapshot-root", str(self.snapshot),
                "--repository-root", str(self.repository),
                "--metadata", str(metadata),
                "--output", str(output),
                "--fail-unreviewed",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("usage:", result.stderr.lower())
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["summary"]["unreviewed"], 1)
