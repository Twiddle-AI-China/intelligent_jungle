from __future__ import annotations

import sys
from pathlib import Path

import pytest


ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

LINUX_RELEASE_SECURITY_REQUIRES_LINUX = "LINUX_RELEASE_SECURITY_REQUIRES_LINUX"
LINUX_RELEASE_SECURITY_TESTS = frozenset({
    "test_audio_worker_identity.py::test_worker_recomputes_artifact_and_returns_exact_identity",
    "test_audio_worker_identity.py::test_tamper_and_symlink_fail_closed",
    "test_audio_worker_lifecycle.py::test_uds_identity_handshake_and_exact_single_connection",
    "test_audio_worker_lifecycle.py::test_bad_identity_connection_is_closed_and_next_runtime_can_connect",
    "test_audio_worker_lifecycle.py::test_uds_preflight_refuses_any_existing_path",
    "test_machine_attestation.py::test_capture_missing_privileged_host_key_fails",
    "test_machine_attestation.py::test_capture_derives_identity_and_writes_hash_bound_raw_evidence",
    "test_phase5_deploy_contract.py::test_stage_has_gpu_only_on_audio_loopback_publish_and_shared_uds",
    "test_release_artifact.py::test_release_revision_comes_from_git_head",
    "test_release_artifact.py::test_preexisting_or_symlink_output_is_never_followed",
    "test_release_artifact.py::test_atomic_publish_never_replaces_a_racing_target",
})
LINUX_RELEASE_SECURITY_FILES = frozenset(
    node_id.split("::", 1)[0] for node_id in LINUX_RELEASE_SECURITY_TESTS
)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "linux_release_security: Linux-only authoritative release-security contract",
    )


def _inventory_key(item: pytest.Item) -> str:
    return f"{item.path.name}::{item.name}"


def _validate_inventory_files(tests_root: Path | None = None) -> None:
    root = tests_root or Path(__file__).resolve().parent
    missing = sorted(
        filename
        for filename in LINUX_RELEASE_SECURITY_FILES
        if not (root / filename).is_file() or (root / filename).is_symlink()
    )
    if missing:
        raise pytest.UsageError(
            "LINUX_RELEASE_SECURITY_FILE_MISSING:" + ",".join(missing)
        )


def pytest_collection_modifyitems(
    config: pytest.Config,
    items: list[pytest.Item],
) -> None:
    _validate_inventory_files()
    collected = {_inventory_key(item): item for item in items}
    collected_files = {item.path.name for item in items}
    partial_files = {
        item.split("::", 1)[0].replace("\\", "/").rsplit("/", 1)[-1]
        for item in config.invocation_params.args
        if "::" in item
    }
    expected_in_scope = {
        node_id
        for node_id in LINUX_RELEASE_SECURITY_TESTS
        if node_id.split("::", 1)[0] in collected_files
        and node_id.split("::", 1)[0] not in partial_files
    }
    missing = expected_in_scope - collected.keys()
    if missing:
        raise pytest.UsageError(
            "LINUX_RELEASE_SECURITY_INVENTORY_MISSING:" + ",".join(sorted(missing))
        )

    for node_id, item in collected.items():
        authority = list(item.iter_markers("linux_release_security"))
        skip_reasons = [
            marker
            for marker in item.iter_markers("skipif")
            if marker.kwargs.get("reason") == LINUX_RELEASE_SECURITY_REQUIRES_LINUX
        ]
        if node_id in LINUX_RELEASE_SECURITY_TESTS:
            expected_condition = (sys.platform != "linux",)
            if (
                len(authority) != 1
                or len(skip_reasons) != 1
                or skip_reasons[0].args != expected_condition
            ):
                raise pytest.UsageError(
                    f"LINUX_RELEASE_SECURITY_MARKER_MISSING:{node_id}"
                )
        elif authority or skip_reasons:
            raise pytest.UsageError(
                f"LINUX_RELEASE_SECURITY_INVENTORY_EXPANDED:{node_id}"
            )

    if LINUX_RELEASE_SECURITY_FILES.issubset(collected_files):
        collected_authority = {
            node_id
            for node_id, item in collected.items()
            if list(item.iter_markers("linux_release_security"))
        }
        if collected_authority != LINUX_RELEASE_SECURITY_TESTS:
            raise pytest.UsageError("LINUX_RELEASE_SECURITY_INVENTORY_MISMATCH")
