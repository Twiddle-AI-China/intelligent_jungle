import base64
import hashlib
import importlib.util
import inspect
import os
import shutil
import socket
import stat
import struct
import sys
import tempfile
import threading
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "flock-voice-engine"
TOOL = ENGINE / "tools/phase5_capture_channel_client.py"

client_spec = importlib.util.spec_from_file_location(
    "phase5_capture_channel_client",
    TOOL,
)
client = importlib.util.module_from_spec(client_spec)
client_spec.loader.exec_module(client)
ATTEMPT_TOOL = ENGINE / "deploy/phase5_candidate_attempt.py"
attempt_spec = importlib.util.spec_from_file_location(
    "phase5_candidate_attempt_uds_transaction",
    ATTEMPT_TOOL,
)
attempt = importlib.util.module_from_spec(attempt_spec)
attempt_spec.loader.exec_module(attempt)
RELEASE_CONTROL = ENGINE / "deploy/release_control.py"
release_spec = importlib.util.spec_from_file_location(
    "release_control_uds_transaction",
    RELEASE_CONTROL,
)
release = importlib.util.module_from_spec(release_spec)
release_spec.loader.exec_module(release)

RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
CHALLENGE = "1" * 64
CAPTURE_NONCE = "8" * 64
RAW_MANIFEST_SHA256 = "9" * 64
SPKI = base64.b64decode(
    "MCowBQYDK2VwAyEAb0aAWQv8xav2fgaG1jjaMotHemDd5XS/HGup0cz1cMI="
)
SPKI_BASE64 = base64.b64encode(SPKI).decode("ascii")
SPKI_SHA256 = hashlib.sha256(SPKI).hexdigest()
EXPECTED_PID = 4321
EXPECTED_UID = 1000
CONTROLLER_DIRECTORY = (
    "/tmp/flock-phase5-probe/run-flock-phase5-candidate"
)
CONTROLLER_SOCKET_PATH = f"{CONTROLLER_DIRECTORY}/capture.sock"


def admission():
    return {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-admission",
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "captureNonce": CAPTURE_NONCE,
        "signerSpkiSha256": SPKI_SHA256,
        "trustedSignerSpkiDerBase64": SPKI_BASE64,
    }


def identity_raw():
    return client.phase5_canonical({
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "release": {
            "releaseManifestSha256": "2" * 64,
            "releaseRevision": "3" * 40,
            "sourceManifestSha256": "4" * 64,
            "audioArtifactSha256": "5" * 64,
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
    })


class FakeSocket:
    def __init__(self, *, peer_pid=EXPECTED_PID, peer_uid=EXPECTED_UID,
                 responses=None):
        self.peer_pid = peer_pid
        self.peer_uid = peer_uid
        self.responses = list(responses or [b'{"response":true}\n', b""])
        self.timeout = None
        self.timeouts = []
        self.connected = []
        self.sent = []
        self.shutdown_calls = []
        self.closed = False

    def settimeout(self, value):
        self.timeout = value
        self.timeouts.append(value)

    def connect(self, path):
        self.connected.append(path)

    def getsockopt(self, level, option, size):
        assert size == struct.calcsize("3i")
        return client._UCRED.pack(
            self.peer_pid,
            self.peer_uid,
            100,
        )

    def sendall(self, value):
        self.sent.append(bytes(value))

    def shutdown(self, how):
        self.shutdown_calls.append(how)

    def recv(self, _maximum):
        return self.responses.pop(0)

    def close(self):
        self.closed = True


def assert_transport_rejected(callback):
    with pytest.raises(
            client.Phase5CaptureChannelTransportError,
            match=r"^PHASE5_CAPTURE_CHANNEL_TRANSPORT_REQUIRED$"):
        callback()


def test_public_linux_client_has_no_transport_substitution_seams():
    parameters = inspect.signature(
        client.capture_phase5_candidate_response_linux
    ).parameters

    assert tuple(parameters) == (
        "controller_directory",
        "expected_pid",
        "expected_uid",
        "expected_admission",
        "expected_raw_manifest_sha256",
        "expected_run_identity_raw",
    )
    for forbidden in (
            "socket_path", "socket_factory", "response_validator",
            "lstat", "geteuid", "sleep", "monotonic"):
        assert forbidden not in parameters

    session_parameters = inspect.signature(
        client.capture_phase5_candidate_session_linux
    ).parameters
    assert tuple(session_parameters) == (
        "controller_directory",
        "expected_pid",
        "expected_uid",
        "expected_admission",
        "expected_raw_manifest_sha256",
        "expected_run_identity_raw",
    )
    for forbidden in (
            "response_raw", "session_raw", "full_run_binding",
            "trusted_signer_spki_der_base64",
            "socket_path", "socket_factory", "response_validator",
            "lstat", "geteuid", "sleep", "monotonic"):
        assert forbidden not in session_parameters

    summary_parameters = inspect.signature(
        client.capture_phase5_candidate_summary_linux
    ).parameters
    assert tuple(summary_parameters) == (
        "value",
        "root",
        "controller_directory",
        "expected_pid",
        "expected_uid",
        "expected_admission",
        "expected_raw_manifest_sha256",
        "expected_run_identity_raw",
    )
    for forbidden in (
            "response_raw", "session_raw",
            "trusted_signer_spki_der_base64",
            "socket_path", "socket_factory", "response_validator",
            "summary_validator", "composer",
            "lstat", "geteuid", "sleep", "monotonic"):
        assert forbidden not in summary_parameters


def test_private_exchange_checks_peer_before_one_canonical_half_closed_request(
        monkeypatch):
    transport = FakeSocket()
    validations = []

    result = client._exchange_phase5_capture_channel(
        expected_pid=EXPECTED_PID,
        expected_uid=EXPECTED_UID,
        expected_admission=admission(),
        expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
        expected_run_identity_raw=identity_raw(),
        controller_socket_path=CONTROLLER_SOCKET_PATH,
        socket_factory=lambda: transport,
        wait_for_unlinked=lambda: True,
        response_validator=lambda *args: validations.append(args) or {
            "passed": True,
        },
    )

    assert result == {"passed": True}
    assert transport.connected == [CONTROLLER_SOCKET_PATH]
    assert transport.timeouts[0] <= (
        client.PHASE5_CAPTURE_CHANNEL_TIMEOUT_SECONDS
    )
    assert all(
        0 < value <= client.PHASE5_CAPTURE_CHANNEL_TIMEOUT_SECONDS
        for value in transport.timeouts
    )
    assert transport.shutdown_calls == [client.socket.SHUT_WR]
    assert transport.closed is True
    assert len(transport.sent) == 1
    request_raw = transport.sent[0]
    request = client.strict_json_bytes(
        request_raw[:-1],
        "TEST_FAILED",
    )
    assert request_raw == client.phase5_canonical(request) + b"\n"
    assert request == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-finalize-request",
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "captureNonce": CAPTURE_NONCE,
        "rawManifestSha256": RAW_MANIFEST_SHA256,
    }
    assert validations == [(
        b'{"response":true}\n',
        admission(),
        RAW_MANIFEST_SHA256,
        identity_raw(),
    )]

    session = {
        "schemaVersion": 2,
        "kind": "phase5-fault-session-attestation",
        "runId": RUN_ID,
    }
    session_raw = client.phase5_canonical(session)
    response_raw = client.phase5_canonical({
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-finalize-response",
        "session": session,
        "runBinding": {},
        "captureValidation": {},
    }) + b"\n"
    capture_boundary = {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-boundary-result",
        "captureValidation": {
            "passed": True,
            "faultSessionEvidenceSha256":
                hashlib.sha256(session_raw).hexdigest(),
        },
        "faultRunBindingProjection": {},
    }
    run_identity_raw = identity_raw()
    monkeypatch.setattr(
        client,
        "validate_phase5_capture_channel_response_boundary",
        lambda *_args: capture_boundary,
    )
    monkeypatch.setattr(
        client,
        "phase5_canonical",
        lambda _value: pytest.fail(
            "verified embedded session bytes must not be reserialized"
        ),
    )

    captured = client._validate_phase5_capture_response_with_session(
        response_raw,
        admission(),
        RAW_MANIFEST_SHA256,
        run_identity_raw,
    )

    assert captured == {
        "captureBoundary": capture_boundary,
        "sessionRaw": session_raw,
    }


@pytest.mark.skipif(
    sys.platform != "linux"
    or not hasattr(socket, "SO_PEERCRED")
    or not attempt.LINUX_AUTHORITY_AVAILABLE,
    reason="requires Linux UDS and held-dirfd authority",
)
def test_linux_real_uds_transaction_persists_session_before_machine(
        monkeypatch):
    scratch = Path(tempfile.mkdtemp(prefix="p5uds-", dir="/tmp"))
    os.chmod(scratch, 0o700)
    anchor = scratch / ".p5c"
    anchor.mkdir(mode=0o700)
    registry = anchor / "a"
    layout = None
    held = None
    listener = None
    server_thread = None
    server_errors = []
    requests = []
    events = []
    response_raw = b'{"fixed":"response"}\n'
    session_raw = client.phase5_canonical({
        "schemaVersion": 2,
        "kind": "phase5-fault-session-attestation",
        "proof": {"opaque": "verified-response-seam"},
    })
    controller_uid = os.geteuid()
    controller_gid = os.getegid()
    candidate_pid = os.getpid()
    container_id = "a" * 64
    attempt_id = "b" * 32

    class MachineReached(RuntimeError):
        pass

    try:
        layout = attempt.create_phase5_candidate_attempt(
            registry_root=registry,
            attempt_id=attempt_id,
            release_manifest_sha256="2" * 64,
            controller_uid=controller_uid,
            controller_gid=controller_gid,
        )
        bootstrap_path = layout.bootstrap_bind_source / "bootstrap.sock"
        bootstrap = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            bootstrap.bind(str(bootstrap_path))
            bootstrap.listen(1)
        finally:
            bootstrap.close()
        bootstrap_path.unlink()

        socket_path = layout.candidate_bind_source / "capture.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        listener.listen(1)
        listener.settimeout(5.0)
        expected_identity = client.strict_json_bytes(
            identity_raw(),
            "TEST_FAILED",
        )
        attempt.commit_phase5_candidate_admission(
            attempt=layout,
            expected_intent_sha256=layout.intent_sha256,
            candidate_container_id=container_id,
            candidate_pid=candidate_pid,
            candidate_uid=controller_uid,
            expected_identity=expected_identity,
            admission_raw=(
                client.phase5_canonical(admission()) + b"\n"
            ),
        )
        layout.close()
        layout = None
        held = attempt.open_unique_admitted_phase5_candidate_attempt(
            registry_root=registry,
            candidate_container_id=container_id,
            candidate_pid=candidate_pid,
            candidate_uid=controller_uid,
            release_manifest_sha256="2" * 64,
        )

        def serve_once():
            connection = None
            try:
                connection, _address = listener.accept()
                socket_path.unlink()
                events.append("listener-unlinked")
                chunks = []
                while True:
                    chunk = connection.recv(4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                requests.append(b"".join(chunks))
                events.append("request-read")
                connection.sendall(response_raw)
                connection.shutdown(socket.SHUT_WR)
            except BaseException as exc:
                server_errors.append(exc)
            finally:
                if connection is not None:
                    connection.close()
                listener.close()

        server_thread = threading.Thread(
            target=serve_once,
            name="phase5-real-uds-server",
            daemon=True,
        )
        server_thread.start()

        real_fsync = os.fsync

        def tracked_fsync(descriptor):
            try:
                target = os.readlink(f"/proc/self/fd/{descriptor}")
            except OSError:
                target = "<unresolved>"
            events.append(("fsync", target))
            return real_fsync(descriptor)

        monkeypatch.setattr(attempt.os, "fsync", tracked_fsync)

        def exchange_session():
            return client._exchange_phase5_capture_channel(
                expected_pid=candidate_pid,
                expected_uid=controller_uid,
                expected_admission=admission(),
                expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
                expected_run_identity_raw=identity_raw(),
                controller_socket_path=str(socket_path),
                socket_factory=lambda: socket.socket(
                    socket.AF_UNIX,
                    socket.SOCK_STREAM,
                ),
                wait_for_unlinked=lambda: (
                    client._wait_for_socket_unlinked(
                        str(socket_path))),
                response_validator=lambda raw, *_authority: (
                    {"sessionRaw": session_raw}
                    if raw == response_raw
                    else pytest.fail("unexpected real UDS response")
                ),
            )

        def capture_machine(_binding):
            machine_index = len(events)
            events.append("machine")
            session_path = str(
                held.attempt_directory
                / "fault-session-attestation.json"
            )
            attempt_path = str(held.attempt_directory)
            session_fsyncs = [
                index for index, event in enumerate(events)
                if event == ("fsync", session_path)
            ]
            directory_fsyncs = [
                index for index, event in enumerate(events)
                if event == ("fsync", attempt_path)
            ]
            assert session_fsyncs
            assert directory_fsyncs
            assert (
                max(session_fsyncs)
                < max(directory_fsyncs)
                < machine_index
            )
            raise MachineReached

        with pytest.raises(MachineReached):
            release._drive_phase5_capture_attestation(
                inspect_state=lambda: (
                    attempt.inspect_phase5_capture_state(
                        attempt=held)),
                append_intent=lambda: (
                    attempt.append_phase5_capture_intent(
                        attempt=held,
                        raw_manifest_sha256=RAW_MANIFEST_SHA256,
                    )),
                reinspect_candidate=lambda: (
                    attempt.inspect_phase5_capture_state(
                        attempt=held)),
                exchange_session=exchange_session,
                append_session_raw=lambda raw: (
                    attempt.append_phase5_capture_session_raw(
                        attempt=held,
                        session_raw=raw,
                    )),
                append_failure=lambda code, disposition: (
                    attempt.append_phase5_capture_failure(
                        attempt=held,
                        error_code=code,
                        channel_disposition=disposition,
                    )),
                rebuild_full9=lambda _state: {"verified": "full9"},
                capture_machine=capture_machine,
                validate_external_full9=lambda *_args: pytest.fail(
                    "machine sentinel must stop the transaction"),
                validate_machine_composite=lambda *_args: pytest.fail(
                    "machine sentinel must stop the transaction"),
                append_commit=lambda *_args: pytest.fail(
                    "machine sentinel must stop the transaction"),
                validate_commit=lambda *_args: pytest.fail(
                    "machine sentinel must stop the transaction"),
                build_summary=lambda *_args: pytest.fail(
                    "machine sentinel must stop the transaction"),
                publish_and_validate_summary=lambda *_args: pytest.fail(
                    "machine sentinel must stop the transaction"),
            )

        server_thread.join(timeout=5.0)
        assert not server_thread.is_alive()
        assert server_errors == []
        assert not socket_path.exists()
        assert len(requests) == 1
        request_raw = requests[0]
        request = client.strict_json_bytes(
            request_raw[:-1],
            "TEST_FAILED",
        )
        assert request_raw == client.phase5_canonical(request) + b"\n"
        assert request == {
            "schemaVersion": 1,
            "kind": "phase5-candidate-capture-finalize-request",
            "runId": RUN_ID,
            "challenge": CHALLENGE,
            "captureNonce": CAPTURE_NONCE,
            "rawManifestSha256": RAW_MANIFEST_SHA256,
        }
        assert events.index("listener-unlinked") < events.index(
            "request-read")
        persisted = attempt.inspect_phase5_capture_state(attempt=held)
        assert persisted.phase == "session"
        assert persisted.session_raw == session_raw
    finally:
        if server_thread is not None and server_thread.is_alive():
            server_thread.join(timeout=1.0)
        if listener is not None:
            try:
                listener.close()
            except OSError:
                pass
        if held is not None:
            held.close()
        if layout is not None:
            layout.close()
        shutil.rmtree(scratch, ignore_errors=True)


def test_session_only_client_returns_independently_owned_full_binding(
        monkeypatch):
    session_raw = b'{"kind":"phase5-fault-session-attestation","schemaVersion":2}'
    identity = client.strict_json_bytes(identity_raw(), "TEST_FAILED")
    validation = {
        **identity,
        "signerSpkiSha256": SPKI_SHA256,
        "faultSessionEvidenceSha256":
            hashlib.sha256(session_raw).hexdigest(),
        "captureNonce": CAPTURE_NONCE,
        "rawManifestSha256": RAW_MANIFEST_SHA256,
    }
    boundary = {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-boundary-result",
        "captureValidation": validation,
        "faultRunBindingProjection": {
            name: validation[name]
            for name in (
                "runId", "challenge", "release", "geometry", "profile",
                "signerSpkiSha256", "faultSessionEvidenceSha256",
            )
        },
    }
    captured = {
        "captureBoundary": boundary,
        "sessionRaw": session_raw,
    }
    calls = []

    def fake_capture(*args, **kwargs):
        calls.append((args, kwargs))
        return captured

    monkeypatch.setattr(
        client,
        "_capture_phase5_candidate_response_linux",
        fake_capture,
    )

    result = client.capture_phase5_candidate_session_linux(
        CONTROLLER_DIRECTORY,
        EXPECTED_PID,
        EXPECTED_UID,
        admission(),
        RAW_MANIFEST_SHA256,
        identity_raw(),
    )

    assert len(calls) == 1
    assert calls[0][0] == (
        CONTROLLER_DIRECTORY,
        EXPECTED_PID,
        EXPECTED_UID,
        admission(),
        RAW_MANIFEST_SHA256,
        identity_raw(),
    )
    assert calls[0][1] == {
        "response_validator":
            client._validate_phase5_capture_response_with_session,
    }
    assert result == {
        "captureBoundary": boundary,
        "sessionRaw": session_raw,
        "fullRunBinding": validation,
    }
    assert result["sessionRaw"] != (
        client.phase5_canonical({
            "schemaVersion": 1,
            "kind": "phase5-candidate-capture-finalize-response",
            "session": client.strict_json_bytes(session_raw, "TEST_FAILED"),
            "runBinding": validation,
            "captureValidation": validation,
        }) + b"\n"
    )

    boundary["captureValidation"]["release"]["releaseRevision"] = "f" * 40
    assert result["fullRunBinding"]["release"]["releaseRevision"] == "3" * 40
    result["fullRunBinding"]["geometry"]["sampleRate"] = 1
    assert boundary["captureValidation"]["geometry"]["sampleRate"] == 44_100


@pytest.mark.parametrize(
    ("peer_pid", "peer_uid"),
    [
        (EXPECTED_PID + 1, EXPECTED_UID),
        (EXPECTED_PID, EXPECTED_UID + 1),
    ],
)
def test_peer_credential_mismatch_closes_without_sending(
        peer_pid, peer_uid):
    transport = FakeSocket(peer_pid=peer_pid, peer_uid=peer_uid)

    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=admission(),
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: transport,
            wait_for_unlinked=lambda: True,
            response_validator=lambda *_args: {"passed": True},
        )
    )

    assert transport.sent == []
    assert transport.closed is True


def test_listener_must_unlink_before_request_is_sent():
    transport = FakeSocket()

    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=admission(),
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: transport,
            wait_for_unlinked=lambda: False,
            response_validator=lambda *_args: {"passed": True},
        )
    )

    assert transport.sent == []
    assert transport.closed is True


def test_response_read_is_bounded_and_never_reaches_verifier():
    transport = FakeSocket(responses=[
        b"x" * (client.MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES + 1),
    ])
    validation_calls = []

    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=admission(),
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: transport,
            wait_for_unlinked=lambda: True,
            response_validator=lambda *args: validation_calls.append(args),
        )
    )

    assert validation_calls == []
    assert transport.closed is True


def test_exact_response_limit_reaches_verifier_but_next_byte_is_rejected():
    exact = b"x" * client.MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES
    accepted = FakeSocket(responses=[exact, b""])
    seen = []

    client._exchange_phase5_capture_channel(
        expected_pid=EXPECTED_PID,
        expected_uid=EXPECTED_UID,
        expected_admission=admission(),
        expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
        expected_run_identity_raw=identity_raw(),
        controller_socket_path=CONTROLLER_SOCKET_PATH,
        socket_factory=lambda: accepted,
        wait_for_unlinked=lambda: True,
        response_validator=lambda *args: seen.append(args) or {
            "passed": True,
        },
    )
    assert seen[0][0] == exact

    overflow = FakeSocket(responses=[exact, b"x"])
    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=admission(),
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: overflow,
            wait_for_unlinked=lambda: True,
            response_validator=lambda *_args: {"passed": True},
        )
    )


def test_short_credentials_and_abnormal_close_fail_without_validation():
    class ShortCredentials(FakeSocket):
        def getsockopt(self, _level, _option, _size):
            return b"\0" * (client._UCRED.size - 1)

    short = ShortCredentials()
    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=admission(),
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: short,
            wait_for_unlinked=lambda: True,
            response_validator=lambda *_args: {"passed": True},
        )
    )
    assert short.sent == []

    class ResetPeer(FakeSocket):
        def recv(self, _maximum):
            raise ConnectionResetError("peer reset")

    reset = ResetPeer()
    validation_calls = []
    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=admission(),
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: reset,
            wait_for_unlinked=lambda: True,
            response_validator=lambda *args: validation_calls.append(args),
        )
    )
    assert validation_calls == []
    assert reset.closed is True


def test_response_trickle_cannot_extend_absolute_channel_deadline():
    transport = FakeSocket(responses=[b"x", b""])
    validation_calls = []
    clock = iter([0.0, 0.0, 1.0, 2.0, 6.0])

    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=admission(),
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: transport,
            wait_for_unlinked=lambda: True,
            response_validator=lambda *args: validation_calls.append(args),
            monotonic=lambda: next(clock),
        )
    )

    assert validation_calls == []
    assert transport.closed is True


def test_linux_ucred_uses_unsigned_uid_fields():
    large_uid = 2 ** 31 + 7
    transport = FakeSocket(peer_uid=large_uid)

    result = client._exchange_phase5_capture_channel(
        expected_pid=EXPECTED_PID,
        expected_uid=large_uid,
        expected_admission=admission(),
        expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
        expected_run_identity_raw=identity_raw(),
        controller_socket_path=CONTROLLER_SOCKET_PATH,
        socket_factory=lambda: transport,
        wait_for_unlinked=lambda: True,
        response_validator=lambda *_args: {"passed": True},
    )

    assert result == {"passed": True}


def path_stat(file_type, mode, uid):
    return os.stat_result((
        file_type | mode,
        0,
        0,
        1,
        uid,
        100,
        0,
        0,
        0,
        0,
    ))


def valid_path_lstat():
    values = {
        "/": path_stat(stat.S_IFDIR, 0o755, 0),
        "/tmp": path_stat(stat.S_IFDIR, 0o1777, 0),
        "/tmp/flock-phase5-probe":
            path_stat(stat.S_IFDIR, 0o700, EXPECTED_UID),
        CONTROLLER_DIRECTORY:
            path_stat(stat.S_IFDIR, 0o700, EXPECTED_UID),
        CONTROLLER_SOCKET_PATH:
            path_stat(stat.S_IFSOCK, 0o600, EXPECTED_UID),
    }
    return lambda path: values[os.fspath(path)]


def test_fixed_socket_path_requires_owned_0700_parent_and_0600_socket():
    assert client._validate_phase5_capture_socket_path(
        controller_directory=CONTROLLER_DIRECTORY,
        expected_uid=EXPECTED_UID,
        lstat=valid_path_lstat(),
        geteuid=lambda: EXPECTED_UID,
    ) == CONTROLLER_SOCKET_PATH


@pytest.mark.parametrize(
    "controller_directory",
    [
        True,
        "relative/run-flock-phase5-candidate",
        "/tmp/flock-phase5-probe/not-the-candidate",
        "/tmp/flock-phase5-probe/../run-flock-phase5-candidate",
        "/tmp//flock-phase5-probe/run-flock-phase5-candidate",
        "/tmp/flock-phase5-probe/run-flock-phase5-candidate/",
        "/tmp/flock-phase5-probe/run-flock-phase5-candidate\0hidden",
        "/" + ("x" * 108) + "/run-flock-phase5-candidate",
    ],
)
def test_controller_directory_must_be_canonical_bounded_mount_source(
        controller_directory):
    assert_transport_rejected(
        lambda: client._validate_phase5_capture_socket_path(
            controller_directory=controller_directory,
            expected_uid=EXPECTED_UID,
            lstat=valid_path_lstat(),
            geteuid=lambda: EXPECTED_UID,
        )
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda values: values.update({
            "/tmp/flock-phase5-probe":
                path_stat(stat.S_IFLNK, 0o777, EXPECTED_UID),
        }),
        lambda values: values.update({
            CONTROLLER_DIRECTORY:
                path_stat(stat.S_IFDIR, 0o770, EXPECTED_UID),
        }),
        lambda values: values.update({
            CONTROLLER_DIRECTORY:
                path_stat(stat.S_IFDIR, 0o700, EXPECTED_UID + 1),
        }),
        lambda values: values.update({
            CONTROLLER_SOCKET_PATH:
                path_stat(stat.S_IFREG, 0o600, EXPECTED_UID),
        }),
        lambda values: values.update({
            CONTROLLER_SOCKET_PATH:
                path_stat(stat.S_IFSOCK, 0o660, EXPECTED_UID),
        }),
    ],
)
def test_fixed_socket_path_rejects_unsafe_ancestors_or_inode(mutate):
    base = valid_path_lstat()
    values = {
        path: base(path)
        for path in (
            "/",
            "/tmp",
            "/tmp/flock-phase5-probe",
            CONTROLLER_DIRECTORY,
            CONTROLLER_SOCKET_PATH,
        )
    }
    mutate(values)

    assert_transport_rejected(
        lambda: client._validate_phase5_capture_socket_path(
            controller_directory=CONTROLLER_DIRECTORY,
            expected_uid=EXPECTED_UID,
            lstat=lambda path: values[os.fspath(path)],
            geteuid=lambda: EXPECTED_UID,
        )
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda values: values.update(expected_pid=True),
        lambda values: values.update(expected_uid=-1),
        lambda values: values["expected_admission"].update(hidden=True),
        lambda values: values.update(
            expected_raw_manifest_sha256="g" * 64),
        lambda values: values.update(
            expected_run_identity_raw=identity_raw() + b" "),
        lambda values: values.update(
            expected_run_identity_raw=client.phase5_canonical({
                **client.strict_json_bytes(
                    identity_raw(),
                    "TEST_FAILED",
                ),
                "release": {},
            })),
        lambda values: values.update(
            expected_run_identity_raw=client.phase5_canonical({
                **client.strict_json_bytes(
                    identity_raw(),
                    "TEST_FAILED",
                ),
                "geometry": {},
            })),
        lambda values: values.update(
            expected_run_identity_raw=client.phase5_canonical({
                **client.strict_json_bytes(
                    identity_raw(),
                    "TEST_FAILED",
                ),
                "profile": {},
            })),
    ],
)
def test_controller_inputs_fail_before_socket_creation(mutation):
    values = {
        "expected_pid": EXPECTED_PID,
        "expected_uid": EXPECTED_UID,
        "expected_admission": admission(),
        "expected_raw_manifest_sha256": RAW_MANIFEST_SHA256,
        "expected_run_identity_raw": identity_raw(),
    }
    mutation(values)
    socket_calls = []

    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            **values,
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: socket_calls.append(True),
            wait_for_unlinked=lambda: True,
            response_validator=lambda *_args: {"passed": True},
        )
    )
    assert socket_calls == []


def test_admission_is_owned_before_kind_comparison_can_mutate_caller_state():
    source = admission()

    class MutatingKind(str):
        def __ne__(self, other):
            source["schemaVersion"] = 2
            return False

    source["kind"] = MutatingKind(source["kind"])
    socket_calls = []

    assert_transport_rejected(
        lambda: client._exchange_phase5_capture_channel(
            expected_pid=EXPECTED_PID,
            expected_uid=EXPECTED_UID,
            expected_admission=source,
            expected_raw_manifest_sha256=RAW_MANIFEST_SHA256,
            expected_run_identity_raw=identity_raw(),
            controller_socket_path=CONTROLLER_SOCKET_PATH,
            socket_factory=lambda: socket_calls.append(True),
            wait_for_unlinked=lambda: True,
            response_validator=lambda *_args: {"passed": True},
        )
    )
    assert source["schemaVersion"] == 1
    assert socket_calls == []
