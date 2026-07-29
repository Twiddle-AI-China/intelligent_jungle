from __future__ import annotations

import base64
import hashlib
import importlib.util
import inspect
import json
import os
import shutil
import socket
import stat
import tempfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "flock-voice-engine/deploy/phase5_candidate_attempt.py"
SPEC = importlib.util.spec_from_file_location(
    "phase5_candidate_attempt",
    MODULE_PATH,
)
attempt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(attempt)

ATTEMPT_ID = "1" * 32
RELEASE_MANIFEST_SHA256 = "2" * 64
CONTAINER_ID = "3" * 64
RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
CHALLENGE = "4" * 64
CAPTURE_NONCE = "5" * 64
SPKI = base64.b64decode(
    "MCowBQYDK2VwAyEAb0aAWQv8xav2fgaG1jjaMotHemDd5XS/HGup0cz1cMI="
)
SPKI_BASE64 = base64.b64encode(SPKI).decode("ascii")
SPKI_SHA256 = hashlib.sha256(SPKI).hexdigest()
CONTROLLER_UID = (
    os.geteuid()
    if attempt.LINUX_AUTHORITY_AVAILABLE else 1000
)
CONTROLLER_GID = (
    os.getegid()
    if attempt.LINUX_AUTHORITY_AVAILABLE else 1000
)
CANDIDATE_PID = 4321
CANDIDATE_UID = CONTROLLER_UID
OPEN_LAYOUTS = []
OPEN_SOCKETS = []
OPEN_ROOTS = []


@pytest.fixture(autouse=True)
def close_attempt_handles():
    yield
    while OPEN_SOCKETS:
        OPEN_SOCKETS.pop().close()
    while OPEN_LAYOUTS:
        OPEN_LAYOUTS.pop().close()
    while OPEN_ROOTS:
        shutil.rmtree(OPEN_ROOTS.pop(), ignore_errors=True)


def canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def identity() -> dict:
    return {
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "release": {
            "releaseManifestSha256": RELEASE_MANIFEST_SHA256,
            "releaseRevision": "6" * 40,
            "sourceManifestSha256": "7" * 64,
            "audioArtifactSha256": "8" * 64,
        },
        "geometry": {
            "sampleRate": 44_100,
            "blockFrames": 4_096,
            "poolSize": 5,
            "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
        },
        "profile": {
            "clients": 4,
            "slowClient": 4,
            "durationMinutes": 30,
            "speciesEndpoint": "http://127.0.0.1:8081/v1",
            "speciesModel": "bird_agent",
        },
    }


def admission() -> dict:
    return {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-admission",
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "captureNonce": CAPTURE_NONCE,
        "signerSpkiSha256": SPKI_SHA256,
        "trustedSignerSpkiDerBase64": SPKI_BASE64,
    }


def admission_bytes() -> bytes:
    return canonical(admission()) + b"\n"


def create_layout(tmp_path: Path):
    if attempt.LINUX_AUTHORITY_AVAILABLE:
        tmp_path = Path(tempfile.mkdtemp(prefix="p5a-", dir="/tmp"))
        OPEN_ROOTS.append(tmp_path)
        os.chmod(tmp_path, 0o700)
        registry_name = "r"
    else:
        tmp_path.mkdir(parents=True, exist_ok=True)
        registry_name = "controller-registry"
    layout = attempt.create_phase5_candidate_attempt(
        registry_root=tmp_path / registry_name,
        attempt_id=ATTEMPT_ID,
        release_manifest_sha256=RELEASE_MANIFEST_SHA256,
        controller_uid=CONTROLLER_UID,
        controller_gid=CONTROLLER_GID,
    )
    OPEN_LAYOUTS.append(layout)
    return layout


def consume_bootstrap_socket(layout):
    if not attempt.LINUX_AUTHORITY_AVAILABLE:
        pytest.skip("real Unix socket mutation requires Linux")
    bootstrap_path = layout.bootstrap_bind_source / "bootstrap.sock"
    bootstrap = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        bootstrap.bind(str(bootstrap_path))
        bootstrap.listen(1)
    finally:
        bootstrap.close()
    os.unlink(bootstrap_path)


def create_capture_socket(layout):
    capture_path = layout.candidate_bind_source / "capture.sock"
    capture = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    capture.bind(str(capture_path))
    os.chmod(capture_path, 0o600)
    capture.listen(1)
    OPEN_SOCKETS.append(capture)
    return capture_path


def complete_runtime_socket_mutation(layout):
    consume_bootstrap_socket(layout)
    return create_capture_socket(layout)


def commit(layout):
    return attempt.commit_phase5_candidate_admission(
        attempt=layout,
        expected_intent_sha256=layout.intent_sha256,
        candidate_container_id=CONTAINER_ID,
        candidate_pid=CANDIDATE_PID,
        candidate_uid=CANDIDATE_UID,
        expected_identity=identity(),
        admission_raw=admission_bytes(),
    )


def assert_attempt_rejected(callback) -> None:
    with pytest.raises(
        attempt.Phase5CandidateAttemptError,
        match=r"^PHASE5_CANDIDATE_ATTEMPT_REQUIRED$",
    ):
        callback()


def test_create_api_has_no_nonce_or_transport_authority_input():
    parameters = inspect.signature(
        attempt.create_phase5_candidate_attempt
    ).parameters

    assert tuple(parameters) == (
        "registry_root",
        "attempt_id",
        "release_manifest_sha256",
        "controller_uid",
        "controller_gid",
    )
    assert not {
        "nonce",
        "capture_nonce",
        "socket",
        "docker",
        "peer_pid",
    }.intersection(parameters)


def test_commit_requires_the_live_attempt_handle():
    parameters = inspect.signature(
        attempt.commit_phase5_candidate_admission
    ).parameters

    assert tuple(parameters) == (
        "attempt",
        "expected_intent_sha256",
        "candidate_container_id",
        "candidate_pid",
        "candidate_uid",
        "expected_identity",
        "admission_raw",
    )
    assert "attempt_directory" not in parameters


def test_path_subclass_is_rejected_without_invoking_override(tmp_path):
    calls = []

    class OverridePath(type(tmp_path)):
        def __fspath__(self):
            calls.append("__fspath__")
            return super().__fspath__()

        def __str__(self):
            calls.append("__str__")
            return super().__str__()

    untrusted = OverridePath(tmp_path / "controller-registry")

    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=untrusted,
            attempt_id=ATTEMPT_ID,
            release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            controller_uid=CONTROLLER_UID,
            controller_gid=CONTROLLER_GID,
        )
    )
    assert calls == []


@pytest.mark.parametrize("member_name", ["release", "rowVoices"])
def test_nested_container_subclass_is_rejected_without_invoking_override(
        tmp_path, member_name):
    calls = []

    class OverrideDict(dict):
        def items(self):
            calls.append("dict.items")
            return super().items()

        def __iter__(self):
            calls.append("dict.__iter__")
            return super().__iter__()

        def keys(self):
            calls.append("dict.keys")
            return super().keys()

        def values(self):
            calls.append("dict.values")
            return super().values()

    class OverrideList(list):
        def __iter__(self):
            calls.append("list.__iter__")
            return super().__iter__()

    untrusted_identity = identity()
    if member_name == "release":
        untrusted_identity["release"] = OverrideDict(
            untrusted_identity["release"]
        )
    else:
        untrusted_identity["geometry"]["rowVoices"] = OverrideList(
            untrusted_identity["geometry"]["rowVoices"]
        )

    assert_attempt_rejected(
        lambda: attempt._owned_valid_identity(untrusted_identity)
    )
    assert calls == []


def test_closed_attempt_handle_cannot_commit(tmp_path):
    layout = create_layout(tmp_path)
    layout.close()

    assert_attempt_rejected(lambda: commit(layout))
    assert not (layout.attempt_directory / "admission.json").exists()


def test_attempt_layout_has_separate_bootstrap_ro_and_candidate_rw_bind_intents(
        tmp_path):
    layout = create_layout(tmp_path)
    intent_raw = layout.intent_path.read_bytes()
    value = json.loads(intent_raw)

    assert layout.attempt_directory.parent == layout.registry_root
    assert layout.attempt_directory.name == ATTEMPT_ID
    assert layout.bootstrap_bind_source == (
        layout.attempt_directory / "run-flock-phase5-bootstrap"
    )
    assert layout.candidate_bind_source == (
        layout.attempt_directory / "run-flock-phase5-candidate"
    )
    assert layout.bootstrap_bind_source.is_dir()
    assert layout.candidate_bind_source.is_dir()
    assert intent_raw == canonical(value)
    assert hashlib.sha256(intent_raw).hexdigest() == layout.intent_sha256
    assert b"nonce" not in intent_raw.lower()
    assert value == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-attempt-intent",
        "attemptId": ATTEMPT_ID,
        "releaseManifestSha256": RELEASE_MANIFEST_SHA256,
        "controller": {
            "uid": CONTROLLER_UID,
            "gid": CONTROLLER_GID,
        },
        "bindMounts": {
            "bootstrap": {
                "source": str(layout.bootstrap_bind_source),
                "destination": "/run/flock-phase5-bootstrap",
                "readOnly": True,
            },
            "candidate": {
                "source": str(layout.candidate_bind_source),
                "destination": "/run/flock-phase5-candidate",
                "readOnly": False,
            },
        },
    }
    assert set(path.name for path in layout.attempt_directory.iterdir()) == {
        "intent.json",
        "run-flock-phase5-bootstrap",
        "run-flock-phase5-candidate",
    }
    if attempt.LINUX_AUTHORITY_AVAILABLE:
        for path in (
            layout.registry_root,
            layout.attempt_directory,
            layout.bootstrap_bind_source,
            layout.candidate_bind_source,
        ):
            assert stat.S_IMODE(path.lstat().st_mode) == 0o700
        assert stat.S_IMODE(layout.intent_path.lstat().st_mode) == 0o400


def test_record_is_canonical_exclusive_nofollow_and_0400(tmp_path):
    layout = create_layout(tmp_path)
    raw = layout.intent_path.read_bytes()
    original = raw

    assert raw == canonical(json.loads(raw))
    assert attempt.RECORD_OPEN_FLAGS & os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        assert attempt.RECORD_OPEN_FLAGS & os.O_NOFOLLOW
    if attempt.LINUX_AUTHORITY_AVAILABLE:
        assert stat.S_IMODE(layout.intent_path.stat().st_mode) == 0o400

    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=layout.registry_root,
            attempt_id=ATTEMPT_ID,
            release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            controller_uid=CONTROLLER_UID,
            controller_gid=CONTROLLER_GID,
        )
    )
    assert layout.intent_path.read_bytes() == original


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux runtime socket authority only",
)
def test_admission_commit_is_append_only_and_binds_full_candidate_and_admission(
        tmp_path):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    committed = commit(layout)
    raw = committed.path.read_bytes()
    value = json.loads(raw)

    assert raw == canonical(value)
    assert committed.record_sha256 == hashlib.sha256(raw).hexdigest()
    assert committed.admission_sha256 == hashlib.sha256(
        admission_bytes()
    ).hexdigest()
    assert not hasattr(committed, "sha256")
    assert value == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-attempt-admission",
        "attemptId": ATTEMPT_ID,
        "intentSha256": layout.intent_sha256,
        "candidate": {
            "containerId": CONTAINER_ID,
            "pid": CANDIDATE_PID,
            "uid": CANDIDATE_UID,
        },
        "identity": identity(),
        "admission": admission(),
        "admissionSha256": hashlib.sha256(
            admission_bytes()
        ).hexdigest(),
    }
    assert len(value["candidate"]["containerId"]) == 64
    assert value["candidate"]["pid"] == CANDIDATE_PID
    assert value["candidate"]["uid"] == CANDIDATE_UID
    assert value["identity"] == identity()
    assert value["admission"]["captureNonce"] == CAPTURE_NONCE
    assert set(path.name for path in layout.attempt_directory.iterdir()) == {
        "intent.json",
        "admission.json",
        "run-flock-phase5-bootstrap",
        "run-flock-phase5-candidate",
    }

    first = raw
    assert_attempt_rejected(lambda: commit(layout))
    assert committed.path.read_bytes() == first


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux runtime socket authority only",
)
@pytest.mark.parametrize(
    "mutation",
    [
        lambda values: values.update(
            candidate_container_id="short",
        ),
        lambda values: values.update(candidate_pid=True),
        lambda values: values.update(candidate_pid=0),
        lambda values: values.update(candidate_uid=-1),
        lambda values: values["expected_identity"].update(hidden=True),
        lambda values: values["expected_identity"].update(
            runId="not-a-uuid",
        ),
        lambda values: values.update(
            admission_raw=canonical(admission()),
        ),
        lambda values: values.update(
            admission_raw=admission_bytes() + b"\n",
        ),
        lambda values: values.update(
            admission_raw=(
                b'{"schemaVersion":1,"schemaVersion":1}\n'
            ),
        ),
        lambda values: values.update(
            expected_intent_sha256="f" * 64,
        ),
    ],
)
def test_invalid_admission_transition_fails_before_creating_record(
        tmp_path, mutation):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    values = {
        "attempt": layout,
        "expected_intent_sha256": layout.intent_sha256,
        "candidate_container_id": CONTAINER_ID,
        "candidate_pid": CANDIDATE_PID,
        "candidate_uid": CANDIDATE_UID,
        "expected_identity": identity(),
        "admission_raw": admission_bytes(),
    }
    mutation(values)

    assert_attempt_rejected(
        lambda: attempt.commit_phase5_candidate_admission(**values)
    )
    assert not (layout.attempt_directory / "admission.json").exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux runtime socket authority only",
)
def test_wrong_inventory_and_rebound_intent_fail_closed(tmp_path):
    unexpected_layout = create_layout(tmp_path / "unexpected")
    complete_runtime_socket_mutation(unexpected_layout)
    (unexpected_layout.attempt_directory / "unexpected.json").write_bytes(
        b"{}"
    )
    assert_attempt_rejected(lambda: commit(unexpected_layout))
    assert not (
        unexpected_layout.attempt_directory / "admission.json"
    ).exists()

    rebound_layout = create_layout(tmp_path / "rebound")
    complete_runtime_socket_mutation(rebound_layout)
    os.chmod(rebound_layout.intent_path, 0o600)
    rebound = json.loads(rebound_layout.intent_path.read_bytes())
    rebound["captureNonce"] = CAPTURE_NONCE
    rebound_layout.intent_path.write_bytes(canonical(rebound))
    os.chmod(rebound_layout.intent_path, 0o400)
    assert_attempt_rejected(lambda: commit(rebound_layout))
    assert not (
        rebound_layout.attempt_directory / "admission.json"
    ).exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux runtime socket authority only",
)
def test_hardlinked_intent_fails_closed(tmp_path):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    second_link = tmp_path / "intent-second-link.json"
    try:
        os.link(layout.intent_path, second_link)
    except (NotImplementedError, OSError):
        pytest.skip("hard links unavailable")

    assert layout.intent_path.stat().st_nlink > 1
    assert_attempt_rejected(lambda: commit(layout))
    assert not (layout.attempt_directory / "admission.json").exists()


def test_symlinked_registry_bind_source_or_record_fails_closed(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    registry_link = tmp_path / "registry-link"
    try:
        registry_link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation unavailable")

    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=registry_link,
            attempt_id=ATTEMPT_ID,
            release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            controller_uid=CONTROLLER_UID,
            controller_gid=CONTROLLER_GID,
        )
    )
    if not attempt.LINUX_AUTHORITY_AVAILABLE:
        return

    bind_layout = create_layout(tmp_path / "bind")
    bind_layout.candidate_bind_source.rmdir()
    bind_layout.candidate_bind_source.symlink_to(
        outside,
        target_is_directory=True,
    )
    assert_attempt_rejected(lambda: commit(bind_layout))
    assert not (bind_layout.attempt_directory / "admission.json").exists()

    record_layout = create_layout(tmp_path / "record")
    complete_runtime_socket_mutation(record_layout)
    admission_path = record_layout.attempt_directory / "admission.json"
    admission_path.symlink_to(outside / "admission.json")
    assert_attempt_rejected(lambda: commit(record_layout))
    assert admission_path.is_symlink()
    assert not (outside / "admission.json").exists()


@pytest.mark.parametrize(
    ("attempt_id", "release_sha", "uid", "gid"),
    [
        ("../attempt", RELEASE_MANIFEST_SHA256, CONTROLLER_UID, CONTROLLER_GID),
        ("A" * 32, RELEASE_MANIFEST_SHA256, CONTROLLER_UID, CONTROLLER_GID),
        (ATTEMPT_ID, "g" * 64, CONTROLLER_UID, CONTROLLER_GID),
        (ATTEMPT_ID, RELEASE_MANIFEST_SHA256, True, CONTROLLER_GID),
        (ATTEMPT_ID, RELEASE_MANIFEST_SHA256, CONTROLLER_UID, -1),
    ],
)
def test_invalid_intent_input_creates_no_attempt(
        tmp_path, attempt_id, release_sha, uid, gid):
    registry = tmp_path / "controller-registry"

    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=registry,
            attempt_id=attempt_id,
            release_manifest_sha256=release_sha,
            controller_uid=uid,
            controller_gid=gid,
        )
    )
    assert not (registry / str(attempt_id)).exists()


def test_linux_authority_is_an_explicit_separate_gate():
    if attempt.LINUX_AUTHORITY_AVAILABLE:
        attempt.require_linux_attempt_authority()
    else:
        with pytest.raises(
            attempt.Phase5CandidateAttemptError,
            match=(
                r"^PHASE5_CANDIDATE_ATTEMPT_"
                r"LINUX_AUTHORITY_REQUIRED$"
            ),
        ):
            attempt.require_linux_attempt_authority()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory-FD authority only",
)
def test_linux_rejects_controller_ids_that_are_not_effective_ids(
        tmp_path):
    registry = tmp_path / "controller-registry"
    wrong_uid = (
        CONTROLLER_UID + 1
        if CONTROLLER_UID < 0xffffffff else CONTROLLER_UID - 1
    )

    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=registry,
            attempt_id=ATTEMPT_ID,
            release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            controller_uid=wrong_uid,
            controller_gid=CONTROLLER_GID,
        )
    )
    assert not registry.exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory-FD authority only",
)
def test_linux_rejects_non_private_trusted_anchor(tmp_path):
    anchor = tmp_path / "anchor"
    anchor.mkdir(mode=0o700)
    os.chmod(anchor, 0o750)

    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=anchor / "controller-registry",
            attempt_id=ATTEMPT_ID,
            release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            controller_uid=CONTROLLER_UID,
            controller_gid=CONTROLLER_GID,
        )
    )
    assert not (anchor / "controller-registry").exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory-FD authority only",
)
def test_linux_attempt_path_replacement_is_rejected_by_held_fd(
        tmp_path):
    layout = create_layout(tmp_path)
    displaced = tmp_path / "displaced-attempt"
    layout.attempt_directory.rename(displaced)
    shutil.copytree(displaced, layout.attempt_directory)

    assert_attempt_rejected(lambda: commit(layout))
    assert not (
        layout.attempt_directory / "admission.json"
    ).exists()
    assert not (displaced / "admission.json").exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory-FD authority only",
)
def test_linux_intent_ctime_rebound_is_rejected(tmp_path):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    original_ctime = layout.intent_path.stat().st_ctime_ns
    os.chmod(layout.intent_path, 0o600)
    os.chmod(layout.intent_path, 0o400)
    if layout.intent_path.stat().st_ctime_ns == original_ctime:
        pytest.skip("filesystem did not expose a ctime transition")

    assert_attempt_rejected(lambda: commit(layout))
    assert not (layout.attempt_directory / "admission.json").exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux runtime socket authority only",
)
def test_linux_allows_consumed_bootstrap_and_live_capture_socket(
        tmp_path):
    layout = create_layout(tmp_path)
    capture_path = complete_runtime_socket_mutation(layout)

    assert list(layout.bootstrap_bind_source.iterdir()) == []
    assert [path.name for path in layout.candidate_bind_source.iterdir()] == [
        "capture.sock"
    ]
    capture_state = capture_path.lstat()
    assert stat.S_ISSOCK(capture_state.st_mode)
    assert stat.S_IMODE(capture_state.st_mode) == 0o600
    assert capture_state.st_uid == os.geteuid()

    committed = commit(layout)

    assert committed.path.exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory identity authority only",
)
def test_linux_allows_safe_anchor_and_registry_directory_mutation(
        tmp_path):
    layout = create_layout(tmp_path)
    anchor_sibling = layout.registry_root.parent / "safe-sibling"
    registry_sibling = layout.registry_root / ("a" * 32)
    anchor_sibling.mkdir(mode=0o700)
    registry_sibling.mkdir(mode=0o700)
    os.chmod(anchor_sibling, 0o700)
    os.chmod(registry_sibling, 0o700)
    complete_runtime_socket_mutation(layout)

    committed = commit(layout)

    assert committed.path.exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory identity authority only",
)
def test_linux_allows_completed_sibling_churn_between_directory_observations(
        tmp_path, monkeypatch):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    original_stat = attempt.os.stat
    churned = False

    def churning_stat(path, *args, **kwargs):
        nonlocal churned
        if (
            not churned
            and path == layout.registry_root.name
            and kwargs.get("dir_fd") == layout._anchor_fd
            and kwargs.get("follow_symlinks") is False
        ):
            churned = True
            before = original_stat(
                layout.registry_root,
                follow_symlinks=False,
            )
            sibling = layout.registry_root / "completed-sibling-churn"
            sibling.mkdir(mode=0o700)
            sibling.rmdir()
            after = original_stat(
                layout.registry_root,
                follow_symlinks=False,
            )
            assert (
                after.st_mtime_ns != before.st_mtime_ns
                or after.st_ctime_ns != before.st_ctime_ns
            )
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(attempt.os, "stat", churning_stat)

    committed = commit(layout)

    assert churned
    assert committed.path.exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux live directory security authority only",
)
@pytest.mark.parametrize(
    "directory_name",
    ["anchor", "registry", "attempt", "bootstrap", "candidate"],
)
def test_linux_revalidates_live_directory_mode(
        tmp_path, directory_name):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    directories = {
        "anchor": layout.registry_root.parent,
        "registry": layout.registry_root,
        "attempt": layout.attempt_directory,
        "bootstrap": layout.bootstrap_bind_source,
        "candidate": layout.candidate_bind_source,
    }
    os.chmod(directories[directory_name], 0o750)

    assert_attempt_rejected(lambda: commit(layout))
    assert not (layout.attempt_directory / "admission.json").exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux runtime socket authority only",
)
@pytest.mark.parametrize(
    "mutation",
    [
        "bootstrap-leftover",
        "capture-missing",
        "candidate-extra",
        "capture-regular",
        "capture-mode",
    ],
)
def test_linux_requires_exact_final_bind_inventory(
        tmp_path, mutation):
    layout = create_layout(tmp_path)
    if mutation == "bootstrap-leftover":
        complete_runtime_socket_mutation(layout)
        bootstrap = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bootstrap.bind(str(
            layout.bootstrap_bind_source / "bootstrap.sock"
        ))
        OPEN_SOCKETS.append(bootstrap)
    elif mutation == "capture-missing":
        consume_bootstrap_socket(layout)
    elif mutation == "capture-regular":
        consume_bootstrap_socket(layout)
        (layout.candidate_bind_source / "capture.sock").write_bytes(
            b"not-a-socket"
        )
        os.chmod(
            layout.candidate_bind_source / "capture.sock",
            0o600,
        )
    else:
        capture_path = complete_runtime_socket_mutation(layout)
        if mutation == "candidate-extra":
            (layout.candidate_bind_source / "extra").write_bytes(
                b"unexpected"
            )
        else:
            os.chmod(capture_path, 0o640)

    assert_attempt_rejected(lambda: commit(layout))
    assert not (layout.attempt_directory / "admission.json").exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory-FD authority only",
)
def test_open_trusted_anchor_closes_every_fd_when_parent_close_raises(
        tmp_path, monkeypatch):
    anchor = tmp_path / "anchor" / "leaf"
    anchor.mkdir(parents=True)
    os.chmod(tmp_path / "anchor", 0o700)
    os.chmod(anchor, 0o700)
    opened = []
    injected = False
    original_open = attempt.os.open
    original_close = attempt.os.close

    def recording_open(path, flags, mode=0o777, *, dir_fd=None):
        descriptor = original_open(
            path,
            flags,
            mode,
            dir_fd=dir_fd,
        )
        opened.append(descriptor)
        return descriptor

    def failing_close(descriptor):
        nonlocal injected
        if not injected and len(opened) >= 2:
            injected = True
            original_close(descriptor)
            raise OSError("injected ancestor close failure")
        return original_close(descriptor)

    monkeypatch.setattr(attempt.os, "open", recording_open)
    monkeypatch.setattr(attempt.os, "close", failing_close)

    assert_attempt_rejected(
        lambda: attempt._open_trusted_anchor(anchor)
    )
    assert injected
    for descriptor in opened:
        with pytest.raises(OSError):
            os.fstat(descriptor)


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux durable create authority only",
)
def test_linux_create_fsync_failure_leaves_closed_partial_poison(
        tmp_path, monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="p5a-fail-", dir="/tmp"))
    OPEN_ROOTS.append(root)
    os.chmod(root, 0o700)
    registry = root / "r"
    calls = 0
    original_fsync = attempt.os.fsync

    def failing_fsync(descriptor):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise OSError("injected create fsync failure")
        return original_fsync(descriptor)

    monkeypatch.setattr(attempt.os, "fsync", failing_fsync)
    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=registry,
            attempt_id=ATTEMPT_ID,
            release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            controller_uid=CONTROLLER_UID,
            controller_gid=CONTROLLER_GID,
        )
    )
    monkeypatch.setattr(attempt.os, "fsync", original_fsync)

    assert (registry / ATTEMPT_ID).exists()
    for descriptor in Path("/proc/self/fd").iterdir():
        try:
            target = descriptor.readlink()
        except FileNotFoundError:
            continue
        assert not str(target).startswith(str(registry))
    assert_attempt_rejected(
        lambda: attempt.create_phase5_candidate_attempt(
            registry_root=registry,
            attempt_id=ATTEMPT_ID,
            release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            controller_uid=CONTROLLER_UID,
            controller_gid=CONTROLLER_GID,
        )
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux durable commit authority only",
)
def test_linux_commit_fsync_failure_leaves_append_only_poison(
        tmp_path, monkeypatch):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    registry_state = layout.registry_root.stat()
    original_fsync = attempt.os.fsync

    def failing_fsync(descriptor):
        current = os.fstat(descriptor)
        if (
            current.st_dev == registry_state.st_dev
            and current.st_ino == registry_state.st_ino
            and (
                layout.attempt_directory / "admission.json"
            ).exists()
        ):
            raise OSError("injected commit fsync failure")
        return original_fsync(descriptor)

    monkeypatch.setattr(attempt.os, "fsync", failing_fsync)
    assert_attempt_rejected(lambda: commit(layout))
    monkeypatch.setattr(attempt.os, "fsync", original_fsync)

    admission_path = layout.attempt_directory / "admission.json"
    poisoned = admission_path.read_bytes()
    assert poisoned
    assert_attempt_rejected(lambda: commit(layout))
    assert admission_path.read_bytes() == poisoned


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux held-record authority only",
)
def test_linux_post_fsync_record_swap_is_detected_and_poisoned(
        tmp_path, monkeypatch):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    registry_state = layout.registry_root.stat()
    admission_path = layout.attempt_directory / "admission.json"
    original_fsync = attempt.os.fsync
    swapped = False

    def swapping_fsync(descriptor):
        nonlocal swapped
        result = original_fsync(descriptor)
        current = os.fstat(descriptor)
        if (
            not swapped
            and current.st_dev == registry_state.st_dev
            and current.st_ino == registry_state.st_ino
            and admission_path.exists()
        ):
            swapped = True
            admission_path.unlink()
            admission_path.write_bytes(b"{}")
            os.chmod(admission_path, 0o400)
        return result

    monkeypatch.setattr(attempt.os, "fsync", swapping_fsync)

    assert_attempt_rejected(lambda: commit(layout))
    assert swapped
    assert admission_path.read_bytes() == b"{}"
    monkeypatch.setattr(attempt.os, "fsync", original_fsync)
    assert_attempt_rejected(lambda: commit(layout))
    assert admission_path.read_bytes() == b"{}"


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory-FD authority only",
)
def test_linux_creation_uses_dirfds_and_fsyncs_each_mkdir_child_then_parent(
        tmp_path, monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="p5a-events-", dir="/tmp"))
    OPEN_ROOTS.append(root)
    os.chmod(root, 0o700)
    events = []
    original_mkdir = attempt.os.mkdir
    original_fsync = attempt.os.fsync
    original_open = attempt.os.open
    original_scandir = attempt.os.scandir

    def recording_mkdir(path, mode=0o777, *, dir_fd=None):
        result = original_mkdir(path, mode, dir_fd=dir_fd)
        child = os.stat(
            path,
            dir_fd=dir_fd,
            follow_symlinks=False,
        )
        parent = os.fstat(dir_fd)
        events.append(
            ("mkdir", child.st_dev, child.st_ino,
             parent.st_dev, parent.st_ino, dir_fd)
        )
        return result

    def recording_fsync(descriptor):
        state = os.fstat(descriptor)
        events.append(("fsync", state.st_dev, state.st_ino))
        return original_fsync(descriptor)

    def recording_open(path, flags, mode=0o777, *, dir_fd=None):
        descriptor = original_open(
            path,
            flags,
            mode,
            dir_fd=dir_fd,
        )
        events.append(("open", path, dir_fd, descriptor))
        return descriptor

    def recording_scandir(path):
        events.append(("scandir", path))
        return original_scandir(path)

    monkeypatch.setattr(attempt.os, "mkdir", recording_mkdir)
    monkeypatch.setattr(attempt.os, "fsync", recording_fsync)
    monkeypatch.setattr(attempt.os, "open", recording_open)
    monkeypatch.setattr(attempt.os, "scandir", recording_scandir)

    layout = attempt.create_phase5_candidate_attempt(
        registry_root=root / "r",
        attempt_id=ATTEMPT_ID,
        release_manifest_sha256=RELEASE_MANIFEST_SHA256,
        controller_uid=CONTROLLER_UID,
        controller_gid=CONTROLLER_GID,
    )
    OPEN_LAYOUTS.append(layout)

    mkdir_indices = [
        index for index, event in enumerate(events)
        if event[0] == "mkdir"
    ]
    assert len(mkdir_indices) == 4
    for position, mkdir_index in enumerate(mkdir_indices):
        event = events[mkdir_index]
        assert isinstance(event[5], int)
        stop = (
            mkdir_indices[position + 1]
            if position + 1 < len(mkdir_indices) else len(events)
        )
        fsyncs = [
            item[1:3]
            for item in events[mkdir_index + 1:stop]
            if item[0] == "fsync"
        ]
        assert fsyncs[:2] == [
            (event[1], event[2]),
            (event[3], event[4]),
        ]

    intent_opens = [
        event for event in events
        if event[0] == "open" and event[1] == "intent.json"
    ]
    assert len(intent_opens) == 1
    assert isinstance(intent_opens[0][2], int)
    assert any(
        event[0] == "scandir" and isinstance(event[1], int)
        for event in events
    )
    assert not layout.closed


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux directory-FD authority only",
)
def test_linux_commit_fsyncs_record_then_full_directory_chain_before_return(
        tmp_path, monkeypatch):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    events = []
    original_fsync = attempt.os.fsync

    def recording_fsync(descriptor):
        state = os.fstat(descriptor)
        events.append(
            (
                "directory" if stat.S_ISDIR(state.st_mode) else "record",
                state.st_dev,
                state.st_ino,
            )
        )
        return original_fsync(descriptor)

    monkeypatch.setattr(attempt.os, "fsync", recording_fsync)

    committed = commit(layout)

    admission_state = committed.path.stat()
    attempt_state = layout.attempt_directory.stat()
    registry_state = layout.registry_root.stat()
    anchor_state = layout.registry_root.parent.stat()
    expected = [
        (
            "record",
            admission_state.st_dev,
            admission_state.st_ino,
        ),
        (
            "directory",
            attempt_state.st_dev,
            attempt_state.st_ino,
        ),
        (
            "directory",
            registry_state.st_dev,
            registry_state.st_ino,
        ),
        (
            "directory",
            anchor_state.st_dev,
            anchor_state.st_ino,
        ),
    ]
    cursor = 0
    for event in events:
        if event == expected[cursor]:
            cursor += 1
            if cursor == len(expected):
                break
    assert cursor == len(expected)
