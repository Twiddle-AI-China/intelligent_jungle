from __future__ import annotations

import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy"


def run_deploy_script(
    bash: Path,
    stub_bin: Path,
    script: Path,
    action: str,
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    if os.name == "nt":
        command = [
            str(bash),
            "-c",
            (
                'stub="$(cygpath -u "$1")"\n'
                'script="$(cygpath -u "$2")"\n'
                'PATH="$stub:$PATH"\n'
                "export PATH\n"
                'exec "$script" "$3"\n'
            ),
            "deploy-contract",
            str(stub_bin),
            str(script),
            action,
        ]
    else:
        command = [str(bash), str(script), action]
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def test_only_supported_docker_entrypoint_remains() -> None:
    assert (DEPLOY / "docker-run.sh").is_file()
    assert not (DEPLOY / "run.sh").exists()
    assert not (DEPLOY / "sync.sh").exists()


def test_active_deploy_uses_yfhuang_and_srv_release_paths() -> None:
    script = (DEPLOY / "docker-run.sh").read_text(encoding="utf-8")
    assert "EXPECTED_OPERATOR=yfhuang" in script
    assert "PROJECT=/srv/deploy/flock-voice-engine" in script
    assert 'RUN_UID="$(id -u)"' in script
    assert 'RUN_GID="$(id -g)"' in script
    assert 'LOG_DIR="$PROJECT/logs"' in script
    assert "--user \"$RUN_UID:$RUN_GID\"" in script
    assert "FLOCK_BUILD_REVISION" in script
    assert "FLOCK_SOURCE_MANIFEST_SHA256" in script
    assert "FLOCK_RUNTIME_OWNER=browser" in script
    assert "FLOCK_AUDIO_OWNER=legacy" in script
    assert "verify_status_identity" in script


def test_active_deploy_has_no_password_automation_or_legacy_home() -> None:
    active = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (DEPLOY / "docker-run.sh", DEPLOY / "Dockerfile")
    )
    banned = (
        "REMOTE_PASS",
        "expect -c",
        "StrictHostKeyChecking=no",
        "/home/" + "rolf",
        "--user " + "1005:1005",
    )
    for token in banned:
        assert token not in active


def test_engine_tree_has_no_legacy_operator_or_personal_home() -> None:
    roots = (
        ROOT / "BRIEF.md",
        ROOT / "deploy",
        ROOT / "docs",
        ROOT / "server",
        ROOT / "tools",
    )
    forbidden = (
        "/home/" + "rolf",
        "ssh " + "rolf@",
        "ProxyJump=" + "rolf",
        "--user " + "1005:1005",
    )
    candidates = []
    for root in roots:
        candidates.extend([root] if root.is_file() else [path for path in root.rglob("*") if path.is_file()])
    for path in candidates:
        if path.suffix.lower() not in {".md", ".py", ".sh"} and path.name != "Dockerfile":
            continue
        text = path.read_text(encoding="utf-8")
        for token in forbidden:
            assert token not in text, f"{path.relative_to(ROOT)} 仍含 legacy identity: {token}"


def test_wrong_operator_is_rejected_before_docker_is_called() -> None:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = windows_git_bash if windows_git_bash.is_file() else Path("/bin/bash")
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行部署契约测试"
    with tempfile.TemporaryDirectory() as directory:
        stub_bin = Path(directory)
        identifier = stub_bin / "id"
        docker = stub_bin / "docker"
        identifier.write_text("#!/bin/sh\nprintf 'intruder\\n'\n", encoding="utf-8")
        docker.write_text("#!/bin/sh\nprintf 'docker-called\\n'\nexit 99\n", encoding="utf-8")
        identifier.chmod(0o755)
        docker.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = str(stub_bin) + os.pathsep + env["PATH"]
        result = run_deploy_script(
            bash,
            stub_bin,
            DEPLOY / "docker-run.sh",
            "status",
            env,
        )
    assert result.returncode == 1
    assert "yfhuang" in result.stderr
    assert "docker-called" not in result.stdout


def test_restart_preflights_missing_or_invalid_release_before_docker_mutation() -> None:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = windows_git_bash if windows_git_bash.is_file() else Path("/bin/bash")
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行部署契约测试"
    cases = (
        ("missing", None, None),
        ("invalid", "not-a-git-sha", "not-a-manifest-sha"),
    )
    for label, revision, manifest_sha in cases:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "project"
            stub_bin = root / "bin"
            project.mkdir()
            stub_bin.mkdir()
            if revision is not None:
                (project / ".release-revision").write_text(revision + "\n", encoding="utf-8")
            if manifest_sha is not None:
                (project / ".release-source-manifest.sha256").write_text(
                    manifest_sha + "\n", encoding="utf-8"
                )
            identifier = stub_bin / "id"
            docker = stub_bin / "docker"
            call_log = root / "docker-calls.txt"
            identifier.write_text(
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "  -un) printf 'yfhuang\\n' ;;\n"
                "  -u) printf '1001\\n' ;;\n"
                "  -g) printf '1001\\n' ;;\n"
                "  -nG) printf 'docker\\n' ;;\n"
                "  *) exit 2 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            docker.write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {shlex.quote(call_log.as_posix())}\n"
                "if [ \"$1\" = run ]; then exit 99; fi\n"
                "exit 0\n",
                encoding="utf-8",
            )
            identifier.chmod(0o755)
            docker.chmod(0o755)
            script_copy = root / "docker-run.sh"
            script_text = (DEPLOY / "docker-run.sh").read_text(encoding="utf-8")
            assert script_text.count("PROJECT=/srv/deploy/flock-voice-engine") == 1
            script_text = script_text.replace(
                "PROJECT=/srv/deploy/flock-voice-engine",
                f"PROJECT={shlex.quote(project.as_posix())}",
            )
            script_copy.write_text(script_text, encoding="utf-8")
            script_copy.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = str(stub_bin) + os.pathsep + env["PATH"]
            result = run_deploy_script(
                bash,
                stub_bin,
                script_copy,
                "restart",
                env,
            )
            calls = call_log.read_text(encoding="utf-8").splitlines() if call_log.exists() else []
        assert result.returncode == 1, f"{label}: restart 应 fail closed"
        assert not any(call.startswith(("rm ", "run ", "stop ")) for call in calls), (
            f"{label}: release 预检失败后发生 Docker 写操作: {calls}"
        )


def test_status_is_read_only_and_validates_endpoint_release_identity() -> None:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = windows_git_bash if windows_git_bash.is_file() else Path("/bin/bash")
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行部署契约测试"
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        project = root / "project"
        stub_bin = root / "bin"
        project.mkdir()
        stub_bin.mkdir()
        (project / ".release-revision").write_text("a" * 40 + "\n", encoding="utf-8")
        (project / ".release-source-manifest.sha256").write_text("b" * 64 + "\n", encoding="utf-8")
        call_log = root / "docker-calls.txt"
        (stub_bin / "id").write_text(
            "#!/bin/sh\ncase \"$1\" in -un) echo yfhuang;; -u|-g) echo 1001;; *) exit 2;; esac\n",
            encoding="utf-8",
        )
        (stub_bin / "docker").write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' \"$*\" >> {shlex.quote(call_log.as_posix())}\n"
            "if [ \"$1\" = inspect ]; then echo true; fi\n"
            "if [ \"$1\" = rm ] || [ \"$1\" = run ]; then exit 99; fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        matching = (
            '{"releaseRevision":"' + "a" * 40
            + '","sourceManifestSha256":"' + "b" * 64
            + '","protocolFamily":"legacy-decoder","protocolVersion":1,'
            + '"runtimeOwner":"browser","audioOwner":"legacy"}'
        )
        mismatch = (
            '{"releaseRevision":"' + "c" * 40
            + '","sourceManifestSha256":"' + "d" * 64
            + '","protocolFamily":"legacy-decoder","protocolVersion":1,'
            + '"runtimeOwner":"browser","audioOwner":"legacy"}'
        )
        payload_file = root / "healthz.json"
        (stub_bin / "curl").write_text(
            "#!/bin/sh\ncat " + shlex.quote(payload_file.as_posix()) + "\n",
            encoding="utf-8",
        )
        (stub_bin / "python3").write_text(
            "#!/bin/sh\nexec " + shlex.quote(Path(sys.executable).as_posix()) + ' "$@"\n',
            encoding="utf-8",
        )
        for executable in ("id", "docker", "curl", "python3"):
            (stub_bin / executable).chmod(0o755)
        script_copy = root / "docker-run.sh"
        script_text = (DEPLOY / "docker-run.sh").read_text(encoding="utf-8")
        assert script_text.count("PROJECT=/srv/deploy/flock-voice-engine") == 1
        script_copy.write_text(
            script_text.replace(
                "PROJECT=/srv/deploy/flock-voice-engine",
                f"PROJECT={shlex.quote(project.as_posix())}",
            ),
            encoding="utf-8",
        )
        script_copy.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = str(stub_bin) + os.pathsep + env["PATH"]
        for label, payload, expected_returncode in (
            ("matching", matching, 0),
            ("mismatch", mismatch, 1),
        ):
            payload_file.write_text(payload + "\n", encoding="utf-8")
            call_log.unlink(missing_ok=True)
            result = run_deploy_script(
                bash,
                stub_bin,
                script_copy,
                "status",
                env,
            )
            calls = call_log.read_text(encoding="utf-8").splitlines()
            assert result.returncode == expected_returncode, (
                f"{label}: stdout={result.stdout!r}, stderr={result.stderr!r}"
            )
            assert not any(call.startswith(("rm ", "run ", "stop ")) for call in calls)
            if label == "matching":
                assert any(call == "ps" or call.startswith("ps ") for call in calls)
                assert any(call == "stats" or call.startswith("stats ") for call in calls)
            else:
                assert "release" in (result.stdout + result.stderr).lower()
