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
import threading
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
RAW_MANIFEST_SHA256 = "9" * 64
NORMAL_PROFILE_SHA256 = "a" * 64
BURST_PROFILE_SHA256 = "b" * 64
MACHINE_ATTESTATION_SHA256 = "c" * 64
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


def replace_capture_socket(layout):
    capture_path = layout.candidate_bind_source / "capture.sock"
    capture_path.unlink()
    return create_capture_socket(layout)


def complete_runtime_socket_mutation(layout):
    consume_bootstrap_socket(layout)
    capture_path = create_capture_socket(layout)
    fault_control = attempt.prepare_phase5_fault_control_linux(layout)
    OPEN_SOCKETS.append(fault_control)
    return capture_path


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


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux fault-control socket authority only",
)
def test_fault_control_listeners_bind_exact_peers_and_append_phases(tmp_path):
    layout = create_layout(tmp_path)
    consume_bootstrap_socket(layout)
    create_capture_socket(layout)
    fault_control = attempt.prepare_phase5_fault_control_linux(layout)
    OPEN_SOCKETS.append(fault_control)

    committed = attempt.commit_phase5_candidate_admission(
        attempt=layout,
        expected_intent_sha256=layout.intent_sha256,
        candidate_container_id=CONTAINER_ID,
        candidate_pid=os.getpid(),
        candidate_uid=CANDIDATE_UID,
        expected_identity=identity(),
        admission_raw=admission_bytes(),
    )
    clients = {}
    for role, name in (
        ("runtime", "runtime-control.sock"),
        ("audio", "audio-control.sock"),
    ):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(layout.fault_control_bind_source / name))
        OPEN_SOCKETS.append(client)
        clients[role] = client
        fault_control.accept_candidate(
            role=role,
            expected_pid=os.getpid(),
            expected_uid=CANDIDATE_UID,
        )
        fault_control.send_admission(role=role, challenge=CHALLENGE)
        wire = clients[role].recv(4096)
        assert json.loads(wire) == {
            "schemaVersion": 1,
            "kind": "phase5-fault-control-admission",
            "role": role,
            "challenge": CHALLENGE,
            "socketInode": json.loads(
                (layout.attempt_directory / "admission.json").read_bytes()
            )["faultControlInventory"][name]["inode"],
        }
        if role == "runtime":
            capabilities = []
            for client_id in range(1, 5):
                capabilities.append({
                    "client": client_id,
                    "clientIdentitySha256":
                        f"{client_id}" * 64,
                    "runtimeCapability": base64.urlsafe_b64encode(
                        bytes([client_id]) * 32
                    ).rstrip(b"=").decode("ascii"),
                    "runtimeGeneration": 1,
                    "audioCapability": base64.urlsafe_b64encode(
                        bytes([client_id + 4]) * 32
                    ).rstrip(b"=").decode("ascii"),
                    "audioGeneration": 1,
                })
            clients[role].sendall(canonical({
                "schemaVersion": 1,
                "kind": "phase5-fault-control-admission-response",
                "admission": json.loads(admission_bytes()),
                "descriptor": {
                    "binding": identity(),
                    "window": {
                        "startedAtMonotonicMs": 1000,
                        "endedAtMonotonicMs": 1801000,
                        "startedAtUnixMs": 2000,
                        "endedAtUnixMs": 1802000,
                    },
                },
                "clientCapabilities": capabilities,
            }) + b"\n")
            assert len(fault_control.receive_admission_response(
                role="runtime")) == 4
        else:
            clients[role].sendall(canonical({
                "schemaVersion": 1,
                "kind":
                    "phase5-fault-control-audio-admission-response",
            }) + b"\n")
            assert fault_control.receive_admission_response(
                role="audio") is None

    owned_capabilities = fault_control.take_client_capabilities()
    assert len(owned_capabilities) == 4
    assert owned_capabilities[3]["client"] == 4
    with pytest.raises(attempt.Phase5CandidateAttemptError):
        fault_control.take_client_capabilities()

    enabled = []

    def complete_audio_enable():
        enabled.append(json.loads(clients["audio"].recv(4096)))
        clients["audio"].sendall(canonical({
            "schemaVersion": 1,
            "kind": "phase5-audio-control-enabled",
        }) + b"\n")

    enable_thread = threading.Thread(target=complete_audio_enable)
    enable_thread.start()
    fault_control.enable_audio(
        challenge=CHALLENGE,
        signer_spki_sha256=SPKI_SHA256,
    )
    enable_thread.join(timeout=2)
    assert enabled == [{
        "schemaVersion": 1,
        "kind": "phase5-audio-control-enable",
        "challenge": CHALLENGE,
        "signerSpkiSha256": SPKI_SHA256,
    }]

    assert fault_control.phase == "active"
    assert list(layout.fault_control_bind_source.iterdir()) == []
    active = attempt.append_phase5_fault_control_active(
        fault_control=fault_control,
        expected_admission_record_sha256=committed.record_sha256,
    )
    active_value = json.loads(active.path.read_bytes())
    assert active_value["faultControlPhase"] == "active"
    assert active_value["signerSpkiSha256"] == SPKI_SHA256
    closed = attempt.append_phase5_fault_control_closed(
        fault_control=fault_control,
    )
    assert fault_control.phase == "closed"
    assert json.loads(closed.path.read_bytes())["faultControlPhase"] == "closed"


def create_fixed_registry():
    root = Path(tempfile.mkdtemp(prefix="p5r-", dir="/tmp"))
    OPEN_ROOTS.append(root)
    os.chmod(root, 0o700)
    anchor = root / ".p5c"
    anchor.mkdir(mode=0o700)
    return anchor / "a"


def create_admitted_attempt(
        registry_root: Path,
        *,
        attempt_id: str = ATTEMPT_ID,
        container_id: str = CONTAINER_ID):
    layout = attempt.create_phase5_candidate_attempt(
        registry_root=registry_root,
        attempt_id=attempt_id,
        release_manifest_sha256=RELEASE_MANIFEST_SHA256,
        controller_uid=CONTROLLER_UID,
        controller_gid=CONTROLLER_GID,
    )
    OPEN_LAYOUTS.append(layout)
    complete_runtime_socket_mutation(layout)
    committed = attempt.commit_phase5_candidate_admission(
        attempt=layout,
        expected_intent_sha256=layout.intent_sha256,
        candidate_container_id=container_id,
        candidate_pid=CANDIDATE_PID,
        candidate_uid=CANDIDATE_UID,
        expected_identity=identity(),
        admission_raw=admission_bytes(),
    )
    return layout, committed


def reopen_admitted(registry_root: Path):
    held = attempt.open_unique_admitted_phase5_candidate_attempt(
        registry_root=registry_root,
        candidate_container_id=CONTAINER_ID,
        candidate_pid=CANDIDATE_PID,
        candidate_uid=CANDIDATE_UID,
        release_manifest_sha256=RELEASE_MANIFEST_SHA256,
    )
    OPEN_LAYOUTS.append(held)
    return held


def session_bytes():
    return canonical({
        "schemaVersion": 2,
        "kind": "phase5-fault-session-attestation",
        "proof": {"opaque": "verifier-fixed"},
    })


def prepare_capture_append(record_kind: str):
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    if record_kind == "intent":
        return (
            held,
            "capture-intent.json",
            lambda: attempt.append_phase5_capture_intent(
                attempt=held,
                raw_manifest_sha256=RAW_MANIFEST_SHA256,
            ),
        )
    attempt.append_phase5_capture_intent(
        attempt=held,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    if record_kind == "failure":
        return (
            held,
            "capture-failure.json",
            lambda: attempt.append_phase5_capture_failure(
                attempt=held,
                error_code="peer-mismatch",
                channel_disposition="not-connected",
            ),
        )
    (held.candidate_bind_source / "capture.sock").unlink()
    if record_kind == "session":
        return (
            held,
            "fault-session-attestation.json",
            lambda: attempt.append_phase5_capture_session_raw(
                attempt=held,
                session_raw=session_bytes(),
            ),
        )
    attempt.append_phase5_capture_session_raw(
        attempt=held,
        session_raw=session_bytes(),
    )
    return (
        held,
        "attestation-commit.json",
        lambda: attempt.append_phase5_attestation_commit(
            attempt=held,
            profile_digests={
                "normal": NORMAL_PROFILE_SHA256,
                "burst": BURST_PROFILE_SHA256,
            },
            staging_machine_attestation_sha256=(
                MACHINE_ATTESTATION_SHA256
            ),
            evidence_inventory=[
                {"name": "evidence.json", "sha256": "d" * 64},
            ],
        ),
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


def test_attempt_layout_has_separate_bootstrap_candidate_and_fault_control_intents(
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
    assert layout.fault_control_bind_source == (
        layout.attempt_directory / "run-flock-phase5-fault-control"
    )
    assert layout.bootstrap_bind_source.is_dir()
    assert layout.candidate_bind_source.is_dir()
    assert layout.fault_control_bind_source.is_dir()
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
            "faultControl": {
                "source": str(layout.fault_control_bind_source),
                "destination": "/run/flock-phase5-fault-control",
                "readOnly": False,
            },
        },
    }
    assert set(path.name for path in layout.attempt_directory.iterdir()) == {
        "intent.json",
        "run-flock-phase5-bootstrap",
        "run-flock-phase5-candidate",
        "run-flock-phase5-fault-control",
    }
    if attempt.LINUX_AUTHORITY_AVAILABLE:
        for path in (
            layout.registry_root,
            layout.attempt_directory,
            layout.bootstrap_bind_source,
            layout.candidate_bind_source,
            layout.fault_control_bind_source,
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
    capture_path = complete_runtime_socket_mutation(layout)
    capture_state = capture_path.lstat()
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
        "schemaVersion": 2,
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
        "captureSocketState": {
            "device": capture_state.st_dev,
            "inode": capture_state.st_ino,
            "type": "socket",
            "mode": 0o600,
            "uid": capture_state.st_uid,
            "gid": capture_state.st_gid,
            "nlink": capture_state.st_nlink,
        },
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
        "run-flock-phase5-fault-control",
    }

    first = raw
    assert_attempt_rejected(lambda: commit(layout))
    assert committed.path.read_bytes() == first


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux capture socket authority only",
)
@pytest.mark.parametrize(
    "timing",
    ["before-record-fsync", "after-directory-chain-fsync"],
)
def test_admission_rejects_capture_socket_swap_around_fsync(
        tmp_path, monkeypatch, timing):
    layout = create_layout(tmp_path)
    complete_runtime_socket_mutation(layout)
    admission_path = layout.attempt_directory / "admission.json"
    anchor_state = layout.registry_root.parent.stat()
    original_fsync = attempt.os.fsync
    swapped = False

    def swapping_fsync(descriptor):
        nonlocal swapped
        current = os.fstat(descriptor)
        is_admission_record = False
        if admission_path.exists():
            record_state = admission_path.stat()
            is_admission_record = (
                current.st_dev == record_state.st_dev
                and current.st_ino == record_state.st_ino
            )
        if (
            not swapped
            and timing == "before-record-fsync"
            and is_admission_record
        ):
            replace_capture_socket(layout)
            swapped = True
        result = original_fsync(descriptor)
        if (
            not swapped
            and timing == "after-directory-chain-fsync"
            and current.st_dev == anchor_state.st_dev
            and current.st_ino == anchor_state.st_ino
            and admission_path.exists()
        ):
            replace_capture_socket(layout)
            swapped = True
        return result

    monkeypatch.setattr(attempt.os, "fsync", swapping_fsync)

    assert_attempt_rejected(lambda: commit(layout))
    assert swapped
    poisoned = admission_path.read_bytes()
    monkeypatch.setattr(attempt.os, "fsync", original_fsync)
    assert_attempt_rejected(lambda: commit(layout))
    assert admission_path.read_bytes() == poisoned


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


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux admitted-attempt reopen authority only",
)
def test_reopen_selects_only_exact_full_identity_among_historical_attempts():
    registry = create_fixed_registry()
    historical, _ = create_admitted_attempt(
        registry,
        attempt_id="0" * 32,
        container_id="d" * 64,
    )
    selected, _ = create_admitted_attempt(
        registry,
        attempt_id="f" * 32,
    )
    os.utime(historical.attempt_directory, (2_000_000_000, 2_000_000_000))
    os.utime(selected.attempt_directory, (1_000_000_000, 1_000_000_000))
    historical.close()
    selected.close()

    held = reopen_admitted(registry)

    assert held.attempt_id == "f" * 32
    assert attempt.inspect_phase5_capture_state(
        attempt=held
    ).phase == "pre-arm"


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux admitted-attempt reopen authority only",
)
def test_reopen_rejects_zero_or_multiple_exact_identity_matches():
    empty_registry = create_fixed_registry()
    empty_registry.mkdir(mode=0o700)
    assert_attempt_rejected(
        lambda: reopen_admitted(empty_registry)
    )

    duplicate_registry = create_fixed_registry()
    first, _ = create_admitted_attempt(
        duplicate_registry,
        attempt_id="1" * 32,
    )
    second, _ = create_admitted_attempt(
        duplicate_registry,
        attempt_id="2" * 32,
    )
    first.close()
    second.close()
    assert_attempt_rejected(
        lambda: reopen_admitted(duplicate_registry)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux append-only capture state authority only",
)
def test_capture_intent_session_and_commit_are_exact_append_only_records():
    registry = create_fixed_registry()
    layout, committed = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    admission_record_raw = committed.path.read_bytes()

    intent_result = attempt.append_phase5_capture_intent(
        attempt=held,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    intent_raw = intent_result.path.read_bytes()
    intent_value = json.loads(intent_raw)
    assert intent_raw == canonical(intent_value)
    assert intent_result.record_sha256 == hashlib.sha256(
        intent_raw
    ).hexdigest()
    assert intent_value == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-intent",
        "attemptId": ATTEMPT_ID,
        "intentSha256": held.intent_sha256,
        "admissionRecordSha256": hashlib.sha256(
            admission_record_raw
        ).hexdigest(),
        "admissionSha256": hashlib.sha256(
            admission_bytes()
        ).hexdigest(),
        "releaseManifestSha256": RELEASE_MANIFEST_SHA256,
        "candidate": {
            "containerId": CONTAINER_ID,
            "pid": CANDIDATE_PID,
            "uid": CANDIDATE_UID,
        },
        "identity": identity(),
        "captureNonce": CAPTURE_NONCE,
        "signerSpkiSha256": SPKI_SHA256,
        "rawManifestSha256": RAW_MANIFEST_SHA256,
    }
    assert stat.S_IMODE(intent_result.path.stat().st_mode) == 0o400
    assert attempt.inspect_phase5_capture_state(
        attempt=held
    ).phase == "intent-only"

    (held.candidate_bind_source / "capture.sock").unlink()
    session_raw = canonical({
        "schemaVersion": 2,
        "kind": "phase5-fault-session-attestation",
        "proof": {"opaque": "verifier-fixed"},
    })
    session_result = attempt.append_phase5_capture_session_raw(
        attempt=held,
        session_raw=session_raw,
    )
    assert session_result.path.read_bytes() == session_raw
    assert session_result.record_sha256 == hashlib.sha256(
        session_raw
    ).hexdigest()
    assert json.loads(session_result.path.read_bytes()) == json.loads(
        session_raw
    )
    assert "session" not in json.loads(session_result.path.read_bytes())
    assert attempt.inspect_phase5_capture_state(
        attempt=held
    ).phase == "session"

    evidence_inventory = [
        {"name": "z-last.json", "sha256": "e" * 64},
        {"name": "a-first.json", "sha256": "d" * 64},
    ]
    commit_result = attempt.append_phase5_attestation_commit(
        attempt=held,
        profile_digests={
            "normal": NORMAL_PROFILE_SHA256,
            "burst": BURST_PROFILE_SHA256,
        },
        staging_machine_attestation_sha256=(
            MACHINE_ATTESTATION_SHA256
        ),
        evidence_inventory=evidence_inventory,
    )
    commit_raw = commit_result.path.read_bytes()
    commit_value = json.loads(commit_raw)
    stable_inventory = sorted(
        evidence_inventory,
        key=lambda value: value["name"],
    )
    assert commit_raw == canonical(commit_value)
    assert commit_value == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-attestation-commit",
        "attemptId": ATTEMPT_ID,
        "captureIntentSha256": hashlib.sha256(
            intent_raw
        ).hexdigest(),
        "sessionSha256": hashlib.sha256(session_raw).hexdigest(),
        "rawManifestSha256": RAW_MANIFEST_SHA256,
        "profileDigests": {
            "normal": NORMAL_PROFILE_SHA256,
            "burst": BURST_PROFILE_SHA256,
        },
        "stagingMachineAttestationSha256": (
            MACHINE_ATTESTATION_SHA256
        ),
        "evidenceInventorySha256": hashlib.sha256(
            canonical(stable_inventory)
        ).hexdigest(),
    }
    assert attempt.inspect_phase5_capture_state(
        attempt=held
    ).phase == "committed"
    original = commit_raw
    assert_attempt_rejected(
        lambda: attempt.append_phase5_attestation_commit(
            attempt=held,
            profile_digests={
                "normal": NORMAL_PROFILE_SHA256,
                "burst": BURST_PROFILE_SHA256,
            },
            staging_machine_attestation_sha256=(
                MACHINE_ATTESTATION_SHA256
            ),
            evidence_inventory=evidence_inventory,
        )
    )
    assert commit_result.path.read_bytes() == original


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux append-only capture state authority only",
)
@pytest.mark.parametrize(
    ("disposition", "consume_socket"),
    [("not-connected", False), ("consumed", True)],
)
def test_capture_failure_exactly_binds_channel_disposition(
        disposition, consume_socket):
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    capture_intent = attempt.append_phase5_capture_intent(
        attempt=held,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    if consume_socket:
        (held.candidate_bind_source / "capture.sock").unlink()

    failure = attempt.append_phase5_capture_failure(
        attempt=held,
        error_code="peer-mismatch",
        channel_disposition=disposition,
    )
    failure_value = json.loads(failure.path.read_bytes())
    assert failure_value == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-failure",
        "attemptId": ATTEMPT_ID,
        "captureIntentSha256": capture_intent.record_sha256,
        "errorCode": "peer-mismatch",
        "channelDisposition": disposition,
    }
    assert attempt.inspect_phase5_capture_state(
        attempt=held
    ).phase == "failure"
    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_session_raw(
            attempt=held,
            session_raw=canonical({
                "schemaVersion": 2,
                "kind": "phase5-fault-session-attestation",
            }),
        )
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux capture inventory authority only",
)
@pytest.mark.parametrize(
    ("disposition", "consume_socket"),
    [("not-connected", True), ("consumed", False)],
)
def test_capture_failure_rejects_disposition_inventory_mismatch(
        disposition, consume_socket):
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    attempt.append_phase5_capture_intent(
        attempt=held,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    if consume_socket:
        (held.candidate_bind_source / "capture.sock").unlink()

    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_failure(
            attempt=held,
            error_code="peer-mismatch",
            channel_disposition=disposition,
        )
    )
    assert not (
        held.attempt_directory / "capture-failure.json"
    ).exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux held attempt authority only",
)
def test_capture_append_apis_require_live_exact_held_attempt():
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    held.close()

    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )
    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_intent(
            attempt=held,
            raw_manifest_sha256=RAW_MANIFEST_SHA256,
        )
    )
    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_intent(
            attempt=layout,
            raw_manifest_sha256=RAW_MANIFEST_SHA256,
        )
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux persisted socket authority only",
)
def test_reopen_and_not_connected_failure_reject_replacement_socket():
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    replace_capture_socket(layout)
    assert_attempt_rejected(lambda: reopen_admitted(registry))

    other_registry = create_fixed_registry()
    other_layout, _ = create_admitted_attempt(other_registry)
    other_layout.close()
    held = reopen_admitted(other_registry)
    attempt.append_phase5_capture_intent(
        attempt=held,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    attempt.append_phase5_capture_failure(
        attempt=held,
        error_code="peer-mismatch",
        channel_disposition="not-connected",
    )
    replace_capture_socket(other_layout)
    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux indeterminate capture state authority only",
)
def test_reopened_intent_only_state_is_terminal_and_never_appendable():
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    armed = reopen_admitted(registry)
    attempt.append_phase5_capture_intent(
        attempt=armed,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    armed.close()

    resumed = reopen_admitted(registry)
    assert attempt.inspect_phase5_capture_state(
        attempt=resumed
    ).phase == "intent-only"
    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_failure(
            attempt=resumed,
            error_code="peer-mismatch",
            channel_disposition="not-connected",
        )
    )
    (resumed.candidate_bind_source / "capture.sock").unlink()
    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_session_raw(
            attempt=resumed,
            session_raw=canonical({
                "schemaVersion": 2,
                "kind": "phase5-fault-session-attestation",
            }),
        )
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux record and path authority only",
)
@pytest.mark.parametrize(
    "attack",
    ["admission-hardlink", "admission-symlink", "admission-hidden",
     "attempt-rebind", "candidate-rebind", "attempt-case-alias"],
)
def test_reopen_rejects_record_and_directory_rebinding_attacks(attack):
    registry = create_fixed_registry()
    layout, committed = create_admitted_attempt(registry)
    layout.close()
    if attack == "admission-hardlink":
        os.link(
            committed.path,
            layout.attempt_directory / "admission-link.json",
        )
    elif attack == "admission-symlink":
        target = registry.parent / "admission-target.json"
        committed.path.rename(target)
        committed.path.symlink_to(target)
    elif attack == "admission-hidden":
        value = json.loads(committed.path.read_bytes())
        value["hidden"] = True
        committed.path.unlink()
        committed.path.write_bytes(canonical(value))
        os.chmod(committed.path, 0o400)
    elif attack == "attempt-rebind":
        displaced = registry / "displaced"
        layout.attempt_directory.rename(displaced)
        layout.attempt_directory.mkdir(mode=0o700)
    elif attack == "candidate-rebind":
        candidate = layout.candidate_bind_source
        candidate.rename(layout.attempt_directory / "candidate-displaced")
        candidate.mkdir(mode=0o700)
    else:
        layout.attempt_directory.rename(
            registry / ("A" * 32)
        )

    assert_attempt_rejected(lambda: reopen_admitted(registry))


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux fixed failure record authority only",
)
@pytest.mark.parametrize(
    ("error_code", "disposition"),
    [
        ("arbitrary exception text", "not-connected"),
        ("peer-mismatch", "unknown"),
        (True, "not-connected"),
        ("timeout", False),
    ],
)
def test_capture_failure_rejects_non_enum_values(
        error_code, disposition):
    held, _, _ = prepare_capture_append("failure")

    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_failure(
            attempt=held,
            error_code=error_code,
            channel_disposition=disposition,
        )
    )
    assert not (
        held.attempt_directory / "capture-failure.json"
    ).exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux exact session authority only",
)
def test_capture_session_rejects_response_wrapper_even_if_canonical_v2():
    held, _, _ = prepare_capture_append("session")
    wrapper = canonical({
        "schemaVersion": 2,
        "kind": "phase5-candidate-capture-finalize-response",
        "session": json.loads(session_bytes()),
    })

    assert_attempt_rejected(
        lambda: attempt.append_phase5_capture_session_raw(
            attempt=held,
            session_raw=wrapper,
        )
    )
    assert not (
        held.attempt_directory / "fault-session-attestation.json"
    ).exists()


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux append fsync authority only",
)
@pytest.mark.parametrize(
    "record_kind",
    ["intent", "failure", "session", "commit"],
)
def test_each_capture_append_fsyncs_file_then_full_directory_chain(
        record_kind, monkeypatch):
    held, target_name, append = prepare_capture_append(record_kind)
    events = []
    original_fsync = attempt.os.fsync

    def recording_fsync(descriptor):
        current = os.fstat(descriptor)
        events.append((
            "directory" if stat.S_ISDIR(current.st_mode) else "record",
            current.st_dev,
            current.st_ino,
        ))
        return original_fsync(descriptor)

    monkeypatch.setattr(attempt.os, "fsync", recording_fsync)

    result = append()
    target = (held.attempt_directory / target_name).stat()
    expected = [
        ("record", target.st_dev, target.st_ino),
        (
            "directory",
            held.attempt_directory.stat().st_dev,
            held.attempt_directory.stat().st_ino,
        ),
        (
            "directory",
            held.attempt_directory.parent.stat().st_dev,
            held.attempt_directory.parent.stat().st_ino,
        ),
        (
            "directory",
            held.attempt_directory.parent.parent.stat().st_dev,
            held.attempt_directory.parent.parent.stat().st_ino,
        ),
    ]
    cursor = 0
    for event in events:
        if event == expected[cursor]:
            cursor += 1
            if cursor == len(expected):
                break
    assert cursor == len(expected)
    assert result.path.name == target_name
    assert stat.S_IMODE(result.path.stat().st_mode) == 0o400
    assert attempt.RECORD_OPEN_FLAGS & os.O_EXCL
    assert attempt.RECORD_OPEN_FLAGS & os.O_CREAT
    assert attempt.RECORD_OPEN_FLAGS & os.O_NOFOLLOW


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux append poison authority only",
)
@pytest.mark.parametrize(
    "record_kind",
    ["intent", "failure", "session", "commit"],
)
def test_each_capture_append_fsync_failure_leaves_poison(
        record_kind, monkeypatch):
    held, target_name, append = prepare_capture_append(record_kind)
    registry_state = held.attempt_directory.parent.stat()
    target_path = held.attempt_directory / target_name
    original_fsync = attempt.os.fsync

    def failing_fsync(descriptor):
        current = os.fstat(descriptor)
        if (
            target_path.exists()
            and current.st_dev == registry_state.st_dev
            and current.st_ino == registry_state.st_ino
        ):
            raise OSError("injected capture append fsync failure")
        return original_fsync(descriptor)

    monkeypatch.setattr(attempt.os, "fsync", failing_fsync)
    assert_attempt_rejected(append)
    monkeypatch.setattr(attempt.os, "fsync", original_fsync)

    poisoned = target_path.read_bytes()
    assert poisoned
    assert_attempt_rejected(append)
    assert target_path.read_bytes() == poisoned
    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux held record drift authority only",
)
@pytest.mark.parametrize(
    "record_name",
    [
        "intent.json",
        "admission.json",
        "capture-intent.json",
        "fault-session-attestation.json",
        "attestation-commit.json",
    ],
)
def test_inspect_rejects_post_open_record_drift(record_name):
    held, _, append_commit = prepare_capture_append("commit")
    append_commit()
    target = held.attempt_directory / record_name
    value = json.loads(target.read_bytes())
    value["hidden"] = True
    os.chmod(target, 0o600)
    target.write_bytes(canonical(value))
    os.chmod(target, 0o400)

    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux held directory authority only",
)
@pytest.mark.parametrize("target_name", ["attempt", "candidate"])
def test_inspect_rejects_post_open_directory_replacement(target_name):
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    if target_name == "attempt":
        target = held.attempt_directory
        target.rename(registry / "displaced-attempt")
        target.mkdir(mode=0o700)
    else:
        target = held.candidate_bind_source
        target.rename(held.attempt_directory / "displaced-candidate")
        target.mkdir(mode=0o700)

    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux held registry snapshot authority only",
)
def test_inspect_rejects_post_open_registry_sibling_insertion():
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    (registry / ("e" * 32)).mkdir(mode=0o700)

    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux finite capture state authority only",
)
@pytest.mark.parametrize("attack", ["success-failure-conflict", "extra"])
def test_capture_state_rejects_conflict_or_unknown_inventory(attack):
    held, _, append_failure = prepare_capture_append("failure")
    append_failure()
    if attack == "success-failure-conflict":
        target = (
            held.attempt_directory / "fault-session-attestation.json"
        )
        target.write_bytes(session_bytes())
    else:
        target = held.attempt_directory / "unknown.json"
        target.write_bytes(canonical({"poison": True}))
    os.chmod(target, 0o400)

    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux exact held record map authority only",
)
def test_capture_state_rejects_unknown_internal_record_key():
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    held._records["unknown-held-record"] = held._records["intent.json"]
    try:
        assert_attempt_rejected(
            lambda: attempt.inspect_phase5_capture_state(
                attempt=held
            )
        )
    finally:
        held._records.pop("unknown-held-record")


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux immutable held record cache authority only",
)
def test_capture_state_rejects_cached_nested_value_mutation():
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    held._records["admission.json"].value[
        "candidate"
    ]["containerId"] = "e" * 64

    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux locator descriptor lifecycle only",
)
def test_failed_reopen_does_not_leak_descriptors():
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    before = len(os.listdir("/proc/self/fd"))

    for _ in range(8):
        assert_attempt_rejected(
            lambda: attempt.open_unique_admitted_phase5_candidate_attempt(
                registry_root=registry,
                candidate_container_id="e" * 64,
                candidate_pid=CANDIDATE_PID,
                candidate_uid=CANDIDATE_UID,
                release_manifest_sha256=RELEASE_MANIFEST_SHA256,
            )
        )

    assert len(os.listdir("/proc/self/fd")) == before


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux locator final validation lifecycle only",
)
def test_final_reopen_revalidation_failure_closes_selected_handle(
        monkeypatch):
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    original_validate = attempt._validate_held_state
    calls = 0

    def fail_final_validation(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise attempt.Phase5CandidateAttemptError(
                "PHASE5_CANDIDATE_ATTEMPT_REQUIRED"
            )
        return original_validate(*args, **kwargs)

    monkeypatch.setattr(
        attempt,
        "_validate_held_state",
        fail_final_validation,
    )
    before = len(os.listdir("/proc/self/fd"))

    assert_attempt_rejected(lambda: reopen_admitted(registry))

    assert calls == 2
    assert len(os.listdir("/proc/self/fd")) == before


def test_reopen_api_has_no_attempt_id_or_latest_selection_input():
    parameters = inspect.signature(
        attempt.open_unique_admitted_phase5_candidate_attempt
    ).parameters

    assert set(parameters) == {
        "registry_root",
        "candidate_container_id",
        "candidate_pid",
        "candidate_uid",
        "release_manifest_sha256",
    }
    assert all(
        parameter.kind is inspect.Parameter.KEYWORD_ONLY
        for parameter in parameters.values()
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux immutable capture state snapshot authority only",
)
def test_inspect_returns_exact_immutable_raw_roots_for_each_phase():
    registry = create_fixed_registry()
    layout, committed = create_admitted_attempt(registry)
    layout.close()
    held = reopen_admitted(registry)
    intent_raw = (held.attempt_directory / "intent.json").read_bytes()
    admission_raw = committed.path.read_bytes()

    pre_arm = attempt.inspect_phase5_capture_state(attempt=held)
    assert pre_arm.intent_raw == intent_raw
    assert pre_arm.admission_record_raw == admission_raw
    assert pre_arm.capture_intent_raw is None
    assert pre_arm.capture_failure_raw is None
    assert pre_arm.session_raw is None
    assert pre_arm.attestation_commit_raw is None

    capture_intent = attempt.append_phase5_capture_intent(
        attempt=held,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    intent_only = attempt.inspect_phase5_capture_state(attempt=held)
    assert intent_only.intent_raw == intent_raw
    assert intent_only.admission_record_raw == admission_raw
    assert intent_only.capture_intent_raw == (
        capture_intent.path.read_bytes()
    )
    assert intent_only.capture_failure_raw is None
    assert intent_only.session_raw is None
    assert intent_only.attestation_commit_raw is None

    (held.candidate_bind_source / "capture.sock").unlink()
    session = attempt.append_phase5_capture_session_raw(
        attempt=held,
        session_raw=session_bytes(),
    )
    session_state = attempt.inspect_phase5_capture_state(attempt=held)
    assert session_state.capture_intent_raw == (
        capture_intent.path.read_bytes()
    )
    assert session_state.session_raw == session_bytes()
    assert session_state.session_raw == session.path.read_bytes()
    assert session_state.capture_failure_raw is None
    assert session_state.attestation_commit_raw is None

    held.close()
    resumed = reopen_admitted(registry)
    resumed_session_state = attempt.inspect_phase5_capture_state(
        attempt=resumed
    )
    assert resumed_session_state.intent_raw == intent_raw
    assert resumed_session_state.admission_record_raw == admission_raw
    assert resumed_session_state.capture_intent_raw == (
        capture_intent.path.read_bytes()
    )
    assert resumed_session_state.session_raw == session_bytes()

    commit = attempt.append_phase5_attestation_commit(
        attempt=resumed,
        profile_digests={
            "normal": NORMAL_PROFILE_SHA256,
            "burst": BURST_PROFILE_SHA256,
        },
        staging_machine_attestation_sha256=(
            MACHINE_ATTESTATION_SHA256
        ),
        evidence_inventory=[
            {"name": "evidence.json", "sha256": "d" * 64},
        ],
    )
    committed_state = attempt.inspect_phase5_capture_state(
        attempt=resumed
    )
    assert committed_state.intent_raw == intent_raw
    assert committed_state.admission_record_raw == admission_raw
    assert committed_state.capture_intent_raw == (
        capture_intent.path.read_bytes()
    )
    assert committed_state.capture_failure_raw is None
    assert committed_state.session_raw == session_bytes()
    assert committed_state.attestation_commit_raw == (
        commit.path.read_bytes()
    )
    assert not any(
        isinstance(value, (dict, Path))
        for value in committed_state
    )
    with pytest.raises(AttributeError):
        committed_state.session_raw = b"mutated"
    assert set(
        inspect.signature(
            attempt.inspect_phase5_capture_state
        ).parameters
    ) == {"attempt"}

    failure_registry = create_fixed_registry()
    failure_layout, _ = create_admitted_attempt(failure_registry)
    failure_layout.close()
    failed = reopen_admitted(failure_registry)
    failure_intent = attempt.append_phase5_capture_intent(
        attempt=failed,
        raw_manifest_sha256=RAW_MANIFEST_SHA256,
    )
    failure = attempt.append_phase5_capture_failure(
        attempt=failed,
        error_code="peer-mismatch",
        channel_disposition="not-connected",
    )
    failure_state = attempt.inspect_phase5_capture_state(
        attempt=failed
    )
    assert failure_state.capture_intent_raw == (
        failure_intent.path.read_bytes()
    )
    assert failure_state.capture_failure_raw == failure.path.read_bytes()
    assert failure_state.session_raw is None
    assert failure_state.attestation_commit_raw is None


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux exact identity locator only",
)
@pytest.mark.parametrize(
    "overrides",
    [
        {"candidate_container_id": "e" * 64},
        {"candidate_pid": CANDIDATE_PID + 1},
        {"candidate_uid": CANDIDATE_UID + 1},
        {"release_manifest_sha256": "e" * 64},
    ],
)
def test_reopen_requires_every_full_identity_field(overrides):
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    values = {
        "registry_root": registry,
        "candidate_container_id": CONTAINER_ID,
        "candidate_pid": CANDIDATE_PID,
        "candidate_uid": CANDIDATE_UID,
        "release_manifest_sha256": RELEASE_MANIFEST_SHA256,
    }
    values.update(overrides)

    assert_attempt_rejected(
        lambda: attempt.open_unique_admitted_phase5_candidate_attempt(
            **values
        )
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux post-fsync append authority only",
)
@pytest.mark.parametrize(
    "record_kind",
    ["intent", "failure", "session", "commit"],
)
def test_each_capture_append_rejects_post_fsync_record_swap(
        record_kind, monkeypatch):
    held, target_name, append = prepare_capture_append(record_kind)
    anchor_state = held.attempt_directory.parent.parent.stat()
    target = held.attempt_directory / target_name
    original_fsync = attempt.os.fsync
    swapped = False

    def swapping_fsync(descriptor):
        nonlocal swapped
        result = original_fsync(descriptor)
        current = os.fstat(descriptor)
        if (
            not swapped
            and target.exists()
            and current.st_dev == anchor_state.st_dev
            and current.st_ino == anchor_state.st_ino
        ):
            swapped = True
            target.unlink()
            target.write_bytes(b"{}")
            os.chmod(target, 0o400)
        return result

    monkeypatch.setattr(attempt.os, "fsync", swapping_fsync)

    assert_attempt_rejected(append)
    assert swapped
    assert target.read_bytes() == b"{}"
    monkeypatch.setattr(attempt.os, "fsync", original_fsync)
    assert_attempt_rejected(append)
    assert target.read_bytes() == b"{}"


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux failure socket authority only",
)
def test_not_connected_failure_rejects_socket_swap_during_fsync(
        monkeypatch):
    held, target_name, append = prepare_capture_append("failure")
    anchor_state = held.attempt_directory.parent.parent.stat()
    target = held.attempt_directory / target_name
    original_fsync = attempt.os.fsync
    swapped = False

    def swapping_fsync(descriptor):
        nonlocal swapped
        result = original_fsync(descriptor)
        current = os.fstat(descriptor)
        if (
            not swapped
            and target.exists()
            and current.st_dev == anchor_state.st_dev
            and current.st_ino == anchor_state.st_ino
        ):
            replace_capture_socket(held)
            swapped = True
        return result

    monkeypatch.setattr(attempt.os, "fsync", swapping_fsync)

    assert_attempt_rejected(append)
    assert swapped
    assert target.exists()
    monkeypatch.setattr(attempt.os, "fsync", original_fsync)
    assert_attempt_rejected(
        lambda: attempt.inspect_phase5_capture_state(attempt=held)
    )


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux reopened schema authority only",
)
@pytest.mark.parametrize(
    ("record_kind", "record_name"),
    [
        ("intent", "capture-intent.json"),
        ("failure", "capture-failure.json"),
        ("session", "fault-session-attestation.json"),
        ("commit", "attestation-commit.json"),
    ],
)
def test_reopen_rejects_hidden_or_wrong_kind_capture_records(
        record_kind, record_name):
    held, _, append = prepare_capture_append(record_kind)
    append()
    registry = held.attempt_directory.parent
    target = held.attempt_directory / record_name
    held.close()
    value = json.loads(target.read_bytes())
    if record_kind == "session":
        value["kind"] = "phase5-candidate-capture-finalize-response"
    else:
        value["hidden"] = True
    target.unlink()
    target.write_bytes(canonical(value))
    os.chmod(target, 0o400)

    assert_attempt_rejected(lambda: reopen_admitted(registry))


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux admission socket record authority only",
)
@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("inode", True),
        ("mode", "0600"),
        ("type", "regular"),
        ("hidden", 1),
    ],
)
def test_reopen_rejects_typed_or_hidden_capture_socket_state(
        field, replacement):
    registry = create_fixed_registry()
    layout, committed = create_admitted_attempt(registry)
    layout.close()
    value = json.loads(committed.path.read_bytes())
    if field == "inode":
        replacement = value["captureSocketState"]["inode"] + 1
    value["captureSocketState"][field] = replacement
    committed.path.unlink()
    committed.path.write_bytes(canonical(value))
    os.chmod(committed.path, 0o400)

    assert_attempt_rejected(lambda: reopen_admitted(registry))


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux finite record inventory authority only",
)
@pytest.mark.parametrize(
    "missing",
    [
        "intent.json",
        "admission.json",
        "capture-intent.json",
        "fault-session-attestation.json",
    ],
)
def test_reopen_rejects_missing_state_record(missing):
    held, _, append_commit = prepare_capture_append("commit")
    append_commit()
    registry = held.attempt_directory.parent
    held.close()
    (registry / ATTEMPT_ID / missing).unlink()

    assert_attempt_rejected(lambda: reopen_admitted(registry))


@pytest.mark.skipif(
    not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="Linux locator ABA authority only",
)
def test_reopen_rejects_attempt_name_post_open_aba(monkeypatch):
    registry = create_fixed_registry()
    layout, _ = create_admitted_attempt(registry)
    layout.close()
    original_open = attempt.os.open
    triggered = False

    def aba_open(path, flags, mode=0o777, *, dir_fd=None):
        nonlocal triggered
        if not triggered and path == ATTEMPT_ID and dir_fd is not None:
            original = registry / ATTEMPT_ID
            displaced = registry / "displaced-aba"
            original.rename(displaced)
            original.mkdir(mode=0o700)
            descriptor = original_open(
                path,
                flags,
                mode,
                dir_fd=dir_fd,
            )
            original.rmdir()
            displaced.rename(original)
            triggered = True
            return descriptor
        return original_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(attempt.os, "open", aba_open)

    assert_attempt_rejected(lambda: reopen_admitted(registry))
    assert triggered
