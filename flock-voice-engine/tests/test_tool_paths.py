from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest


ENGINE_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = ENGINE_ROOT / "tools"
TEST_PACKAGE = "_phase0_tool_paths"

ENV_KEYS = (
    "FLOCK_STAGING_ROOT",
    "FLOCK_MIDIBRAVE_ROOT",
    "FLOCK_TIMBRE_WEIGHTS",
)

TOOL_SCRIPTS = (
    "bench_compute",
    "build_latent_map",
    "build_voice_maps",
    "collapse_probe",
    "descriptors",
    "dump_timbre_net",
    "render_pca100",
    "roam_probe",
)


def fresh_test_package() -> None:
    for name in tuple(sys.modules):
        if name == TEST_PACKAGE or name.startswith(f"{TEST_PACKAGE}."):
            del sys.modules[name]

    package = types.ModuleType(TEST_PACKAGE)
    package.__package__ = TEST_PACKAGE
    package.__path__ = [str(TOOLS_ROOT)]
    sys.modules[TEST_PACKAGE] = package


def load_tool(name: str):
    module_name = f"{TEST_PACKAGE}.{name}"
    path = TOOLS_ROOT / f"{name}.py"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def assert_path_arguments(namespace, expected: dict[str, Path]) -> None:
    for attribute, value in expected.items():
        actual = getattr(namespace, attribute)
        assert isinstance(actual, Path), f"{attribute} 必须由 argparse 返回 Path"
        assert actual == value


def test_project_paths_have_project_relative_defaults(monkeypatch) -> None:
    for name in ENV_KEYS:
        monkeypatch.delenv(name, raising=False)

    fresh_test_package()
    paths = load_tool("project_paths")

    assert paths.ENGINE_ROOT == ENGINE_ROOT
    assert paths.STAGING_ROOT == ENGINE_ROOT / "staging"
    assert paths.VENDOR_MIDIBRAVE == ENGINE_ROOT / "vendor/midibrave/src"
    assert paths.TIMBRE_WEIGHTS == ENGINE_ROOT / "staging/timbre_net.npz"


def test_project_paths_apply_environment_precedence(monkeypatch, tmp_path) -> None:
    staging = tmp_path / "custom-staging"
    vendor = tmp_path / "custom-vendor"

    monkeypatch.setenv("FLOCK_STAGING_ROOT", str(staging))
    monkeypatch.setenv("FLOCK_MIDIBRAVE_ROOT", str(vendor))
    monkeypatch.delenv("FLOCK_TIMBRE_WEIGHTS", raising=False)

    fresh_test_package()
    paths = load_tool("project_paths")
    assert paths.STAGING_ROOT == staging
    assert paths.VENDOR_MIDIBRAVE == vendor
    assert paths.TIMBRE_WEIGHTS == staging / "timbre_net.npz"

    explicit_weights = tmp_path / "explicit-weights.npz"
    monkeypatch.setenv("FLOCK_TIMBRE_WEIGHTS", str(explicit_weights))

    fresh_test_package()
    paths = load_tool("project_paths")
    assert paths.TIMBRE_WEIGHTS == explicit_weights


def test_all_tool_defaults_and_explicit_cli_paths(monkeypatch, tmp_path) -> None:
    staging = tmp_path / "env-staging"
    vendor = tmp_path / "env-vendor"
    weights = tmp_path / "env-weights.npz"
    explicit = tmp_path / "explicit"

    monkeypatch.setenv("FLOCK_STAGING_ROOT", str(staging))
    monkeypatch.setenv("FLOCK_MIDIBRAVE_ROOT", str(vendor))
    monkeypatch.setenv("FLOCK_TIMBRE_WEIGHTS", str(weights))

    fresh_test_package()
    load_tool("project_paths")

    cases = (
        (
            "bench_compute",
            {
                "out": staging / "bench_compute.json",
                "selection": staging / "pca100/selection_100.json",
            },
            [
                "-o", str(explicit / "bench.json"),
                "--selection", str(explicit / "selection.json"),
            ],
            {
                "out": explicit / "bench.json",
                "selection": explicit / "selection.json",
            },
        ),
        (
            "build_latent_map",
            {"weights": weights},
            ["--weights", str(explicit / "latent-weights.npz")],
            {"weights": explicit / "latent-weights.npz"},
        ),
        (
            "build_voice_maps",
            {
                "input": staging / "voice_clap_extracted.json",
                "out": ENGINE_ROOT / "assets/timbre/voice_maps",
            },
            [
                "--input", str(explicit / "voice-input.json"),
                "--out", str(explicit / "voice-maps"),
            ],
            {
                "input": explicit / "voice-input.json",
                "out": explicit / "voice-maps",
            },
        ),
        (
            "collapse_probe",
            {
                "weights": weights,
                "out": staging / "collapse_probe.npz",
            },
            [
                "--weights", str(explicit / "collapse-weights.npz"),
                "--out", str(explicit / "collapse.npz"),
            ],
            {
                "weights": explicit / "collapse-weights.npz",
                "out": explicit / "collapse.npz",
            },
        ),
        (
            "descriptors",
            {"out": staging / "descriptors.json"},
            ["--out", str(explicit / "descriptors.json")],
            {"out": explicit / "descriptors.json"},
        ),
        (
            "render_pca100",
            {
                "indir": staging / "pca100",
                "out": staging / "pca100/renders",
                "vendor": vendor,
            },
            [
                "--in", str(explicit / "pca-input"),
                "--out", str(explicit / "pca-renders"),
                "--vendor", str(explicit / "render-vendor"),
            ],
            {
                "indir": explicit / "pca-input",
                "out": explicit / "pca-renders",
                "vendor": explicit / "render-vendor",
            },
        ),
        (
            "roam_probe",
            {
                "anchors": staging / "anchors_partial.json",
                "out": staging / "roam",
                "vendor": vendor,
            },
            [
                "--anchors", str(explicit / "anchors.json"),
                "--out", str(explicit / "roam"),
                "--vendor", str(explicit / "roam-vendor"),
            ],
            {
                "anchors": explicit / "anchors.json",
                "out": explicit / "roam",
                "vendor": explicit / "roam-vendor",
            },
        ),
    )

    for name, defaults, command_line, overridden in cases:
        module = load_tool(name)
        assert_path_arguments(module.parse_args([]), defaults)
        assert_path_arguments(module.parse_args(command_line), overridden)

    dump = load_tool("dump_timbre_net")
    assert_path_arguments(dump.parse_args([]), {"out": weights})

    checkpoint = explicit / "checkpoint.pt"
    legacy_out = explicit / "legacy-output.npz"
    legacy = dump.parse_args([str(checkpoint), str(legacy_out)])
    assert_path_arguments(legacy, {"checkpoint": checkpoint, "out": legacy_out})

    flag_out = explicit / "flag-output.npz"
    flagged = dump.parse_args([str(checkpoint), "--out", str(flag_out)])
    assert_path_arguments(flagged, {"checkpoint": checkpoint, "out": flag_out})

    with pytest.raises(SystemExit):
        dump.parse_args(
            [str(checkpoint), str(legacy_out), "--out", str(flag_out)]
        )


@pytest.mark.parametrize("name", TOOL_SCRIPTS)
def test_direct_help_has_no_model_data_or_filesystem_side_effects(
    name: str, tmp_path: Path
) -> None:
    environment = os.environ.copy()
    environment["FLOCK_STAGING_ROOT"] = str(tmp_path / "must-not-create-staging")
    environment["FLOCK_MIDIBRAVE_ROOT"] = str(tmp_path / "missing-vendor")
    environment["FLOCK_TIMBRE_WEIGHTS"] = str(tmp_path / "missing-weights.npz")
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"

    result = subprocess.run(
        [sys.executable, str(TOOLS_ROOT / f"{name}.py"), "--help"],
        cwd=tmp_path,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
    )

    assert result.returncode == 0, (
        f"{name} --help 失败：stdout={result.stdout!r}, "
        f"stderr={result.stderr!r}"
    )
    assert "usage:" in (result.stdout + result.stderr).lower()
    assert list(tmp_path.iterdir()) == [], f"{name} --help 不得创建任何文件或目录"
