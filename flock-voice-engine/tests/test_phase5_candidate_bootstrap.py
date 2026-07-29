import hashlib
import importlib.util
import inspect
import json
import os
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "flock-voice-engine"
MODULE = ENGINE / "deploy/phase5_candidate_bootstrap.py"

bootstrap_spec = importlib.util.spec_from_file_location(
    "phase5_candidate_bootstrap",
    MODULE,
)
bootstrap = importlib.util.module_from_spec(bootstrap_spec)
bootstrap_spec.loader.exec_module(bootstrap)

RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
CHALLENGE = "5" * 64
CAPTURE_NONCE_BYTES = bytes.fromhex("6" * 64)
CAPTURE_NONCE = CAPTURE_NONCE_BYTES.hex()
RECEIPT_CHALLENGE_BYTES = bytes.fromhex("7" * 64)
RECEIPT_CHALLENGE = RECEIPT_CHALLENGE_BYTES.hex()
EXPECTED_PID = 4321
EXPECTED_UID = 1000
BOOTSTRAP_DIRECTORY = "/tmp/attempt/run-flock-phase5-bootstrap"
BOOTSTRAP_SOCKET = f"{BOOTSTRAP_DIRECTORY}/bootstrap.sock"
SPKI_BASE64 = (
    "MCowBQYDK2VwAyEAb0aAWQv8xav2fgaG1jjaMotHemDd5XS/HGup0cz1cMI="
)
SPKI_SHA256 = hashlib.sha256(
    __import__("base64").b64decode(SPKI_BASE64)
).hexdigest()


def canonical(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def identity():
    return {
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "release": {
            "releaseManifestSha256": "1" * 64,
            "releaseRevision": "2" * 40,
            "sourceManifestSha256": "3" * 64,
            "audioArtifactSha256": "4" * 64,
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


def admission_line():
    return canonical(admission()) + b"\n"


def receipt(
        admission_raw=None,
        receipt_challenge=RECEIPT_CHALLENGE):
    return {
        "schemaVersion": 1,
        "kind":
            "phase5-candidate-capture-admission-receipt",
        "admissionSha256": hashlib.sha256(
            admission_raw or admission_line()
        ).hexdigest(),
        "receiptChallenge": receipt_challenge,
    }


def receipt_line(
        admission_raw=None,
        receipt_challenge=RECEIPT_CHALLENGE):
    return canonical(receipt(
        admission_raw,
        receipt_challenge,
    )) + b"\n"


class FakeClock:
    def __init__(self):
        self.value = 100.0

    def monotonic(self):
        return self.value


class FakeFilesystem:
    def __init__(self):
        directory = stat.S_IFDIR
        self.next_inode = 10
        self.nodes = {
            "/": self.node(directory | 0o755, 0),
            "/tmp": SimpleNamespace(
                st_mode=directory | stat.S_ISVTX | 0o777,
                st_uid=0,
                st_dev=1,
                st_ino=2,
            ),
            "/tmp/attempt": self.node(
                directory | 0o700,
                EXPECTED_UID,
            ),
            BOOTSTRAP_DIRECTORY: self.node(
                directory | 0o700,
                EXPECTED_UID,
            ),
        }
        self.unlinked = []

    def node(self, mode, uid):
        self.next_inode += 1
        return SimpleNamespace(
            st_mode=mode,
            st_uid=uid,
            st_dev=1,
            st_ino=self.next_inode,
        )

    def lstat(self, path):
        try:
            return self.nodes[path]
        except KeyError:
            raise FileNotFoundError(path)

    def bound(self, path):
        self.nodes[path] = self.node(
            stat.S_IFSOCK | 0o755,
            EXPECTED_UID,
        )

    def chmod(self, path, mode):
        node = self.lstat(path)
        node.st_mode = stat.S_IFMT(node.st_mode) | mode

    def unlink(self, path):
        self.lstat(path)
        del self.nodes[path]
        self.unlinked.append(path)


class FakePeer:
    def __init__(
            self,
            *,
            peer_pid=EXPECTED_PID,
            peer_uid=EXPECTED_UID,
            responses=None,
            events=None,
            clock=None,
            recv_advance=0.0):
        self.peer_pid = peer_pid
        self.peer_uid = peer_uid
        self.responses = list(
            responses if responses is not None
            else [admission_line(), receipt_line(), b""]
        )
        self.events = events if events is not None else []
        self.clock = clock
        self.recv_advance = recv_advance
        self.sent = []
        self.timeouts = []
        self.shutdown_calls = []
        self.closed = False

    def getsockopt(self, _level, _option, size):
        self.events.append("peercred")
        assert size == struct.calcsize("@iII")
        return struct.pack(
            "@iII",
            self.peer_pid,
            self.peer_uid,
            123,
        )

    def settimeout(self, value):
        self.timeouts.append(value)

    def sendall(self, value):
        self.events.append("send")
        self.sent.append(bytes(value))

    def recv(self, maximum):
        self.events.append("recv")
        if self.clock is not None:
            self.clock.value += self.recv_advance
        value = self.responses.pop(0)
        if len(value) > maximum:
            self.responses.insert(0, value[maximum:])
            return value[:maximum]
        return value

    def shutdown(self, how):
        self.events.append("shutdown")
        self.shutdown_calls.append(how)

    def fileno(self):
        return 42

    def close(self):
        self.events.append("peer-close")
        self.closed = True


class FakeListener:
    def __init__(
            self,
            filesystem,
            peer,
            events,
            *,
            bind_error=None,
            listen_error=None,
            accept_error=None):
        self.filesystem = filesystem
        self.peer = peer
        self.events = events
        self.bind_error = bind_error
        self.listen_error = listen_error
        self.accept_error = accept_error
        self.bound = []
        self.backlogs = []
        self.timeouts = []
        self.closed = False
        self.accept_count = 0

    def bind(self, path):
        self.events.append("bind")
        self.bound.append(path)
        self.filesystem.bound(path)
        if self.bind_error is not None:
            raise self.bind_error

    def listen(self, backlog):
        self.events.append("listen")
        if self.listen_error is not None:
            raise self.listen_error
        self.backlogs.append(backlog)

    def settimeout(self, value):
        self.timeouts.append(value)

    def accept(self):
        self.events.append("accept")
        self.accept_count += 1
        if self.accept_error is not None:
            raise self.accept_error
        return self.peer, None

    def close(self):
        self.events.append("listener-close")
        self.closed = True


def prepare(
        *,
        peer=None,
        clock=None,
        filesystem=None,
        wait_for_peer_close=None):
    events = []
    clock = clock or FakeClock()
    filesystem = filesystem or FakeFilesystem()
    peer = peer or FakePeer(events=events, clock=clock)
    peer.events = events
    listener = FakeListener(filesystem, peer, events)
    nonce_values = iter([
        CAPTURE_NONCE_BYTES,
        RECEIPT_CHALLENGE_BYTES,
    ])

    def nonce_factory(size):
        assert size == 32
        value = next(nonce_values)
        events.append(
            "capture-nonce"
            if value == CAPTURE_NONCE_BYTES
            else "receipt-challenge"
        )
        return value

    handle = bootstrap._prepare_phase5_candidate_bootstrap(
        bootstrap_directory=BOOTSTRAP_DIRECTORY,
        expected_identity=identity(),
        socket_factory=lambda: listener,
        monotonic=clock.monotonic,
        nonce_factory=nonce_factory,
        lstat=filesystem.lstat,
        chmod=filesystem.chmod,
        unlink=filesystem.unlink,
        geteuid=lambda: EXPECTED_UID,
        wait_for_peer_close=(
            wait_for_peer_close
            or (lambda *_args: events.append("full-close") or True)
        ),
    )
    return handle, listener, peer, filesystem, clock, events


def committed(events, **values):
    events.append("commit")
    raw = values["admission_raw"]
    return {
        "admissionSha256": hashlib.sha256(raw).hexdigest(),
    }


def rejected(operation):
    with pytest.raises(
            bootstrap.Phase5CandidateBootstrapError,
            match=r"^PHASE5_CANDIDATE_BOOTSTRAP_REQUIRED$"):
        operation()


def test_public_api_has_fixed_production_dependencies_and_linux_gate(
        monkeypatch):
    parameters = inspect.signature(
        bootstrap.prepare_phase5_candidate_bootstrap_linux
    ).parameters
    assert tuple(parameters) == (
        "bootstrap_directory",
        "expected_identity",
    )
    for forbidden in (
            "socket_factory", "monotonic", "nonce_factory",
            "lstat", "chmod", "unlink", "geteuid",
            "wait_for_peer_close"):
        assert forbidden not in parameters

    monkeypatch.setattr(
        bootstrap,
        "LINUX_AUTHORITY_AVAILABLE",
        False,
    )
    rejected(lambda: (
        bootstrap.prepare_phase5_candidate_bootstrap_linux(
            BOOTSTRAP_DIRECTORY,
            identity(),
        )
    ))


def test_success_is_request_commit_ack_then_bound_receipt_and_eof():
    handle, listener, peer, filesystem, _clock, events = prepare()
    commit_calls = []

    def commit_admission(**values):
        commit_calls.append(values)
        return committed(events, **values)

    result = handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        commit_admission,
    )

    assert listener.bound == [BOOTSTRAP_SOCKET]
    assert listener.backlogs == [1]
    assert listener.accept_count == 1
    assert listener.closed is True
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]
    assert BOOTSTRAP_SOCKET not in filesystem.nodes
    assert peer.closed is True
    assert all(
        0 < timeout <= bootstrap.PHASE5_BOOTSTRAP_TIMEOUT_SECONDS
        for timeout in (*listener.timeouts, *peer.timeouts)
    )
    assert peer.shutdown_calls == []
    assert len(peer.sent) == 2

    request_raw, ack_raw = peer.sent
    request = json.loads(request_raw)
    assert request_raw == canonical(request) + b"\n"
    assert request == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-bootstrap-request",
        "identity": identity(),
        "captureNonce": CAPTURE_NONCE,
    }
    expected_digest = hashlib.sha256(admission_line()).hexdigest()
    ack = json.loads(ack_raw)
    assert ack_raw == canonical(ack) + b"\n"
    assert ack == {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-admission-ack",
        "admissionSha256": expected_digest,
        "receiptChallenge": RECEIPT_CHALLENGE,
    }
    assert len(commit_calls) == 1
    assert commit_calls[0] == {
        "admission_raw": admission_line(),
        "candidate_pid": EXPECTED_PID,
        "candidate_uid": EXPECTED_UID,
        "expected_identity": identity(),
    }
    assert events.index("listener-close") < events.index("peercred")
    assert events.index("peercred") < events.index("send")
    assert events.index("commit") < events.index("receipt-challenge")
    receipt_recv = max(
        index
        for index, event in enumerate(events)
        if event == "recv"
    )
    assert events.index("receipt-challenge") < receipt_recv
    assert receipt_recv < events.index("full-close")
    assert events.index("full-close") < events.index("peer-close")
    assert result.admission == admission()
    assert isinstance(result.admission, MappingProxyType)
    assert result.admission_sha256 == expected_digest
    assert not hasattr(result, "capture_nonce")
    with pytest.raises((AttributeError, TypeError)):
        result.admission["kind"] = "changed"

    assert handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        commit_admission,
    ) is result
    assert listener.accept_count == 1
    assert len(commit_calls) == 1
    assert handle.close() is None
    assert handle.close() is None


def test_peer_credentials_must_match_before_any_request_bytes():
    peer = FakePeer(peer_pid=EXPECTED_PID + 1)
    handle, listener, peer, filesystem, _clock, events = prepare(
        peer=peer
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: committed(events, **values),
    ))

    assert listener.accept_count == 1
    assert listener.closed is True
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]
    assert peer.sent == []
    assert peer.closed is True
    rejected(lambda: handle.complete(
        EXPECTED_PID + 1,
        EXPECTED_UID,
        lambda **values: committed(events, **values),
    ))


def test_admission_digest_includes_lf_and_commit_result_must_match_exactly():
    events = []
    for returned in (
        hashlib.sha256(admission_line()[:-1]).hexdigest(),
        "0" * 64,
        hashlib.sha256(admission_line()).hexdigest().upper(),
    ):
        handle, _listener, peer, _filesystem, _clock, events = prepare()

        rejected(lambda: handle.complete(
            EXPECTED_PID,
            EXPECTED_UID,
            lambda **_values: {"admissionSha256": returned},
        ))

        assert len(peer.sent) == 1
        assert peer.shutdown_calls == []
        assert peer.closed is True


def test_noncanonical_extra_or_cross_bound_admission_is_never_committed():
    variants = [
        canonical(admission()),
        admission_line() + b"\n",
        b" " + admission_line(),
        canonical({**admission(), "captureNonce": "7" * 64}) + b"\n",
        canonical({**admission(), "hidden": True}) + b"\n",
    ]
    for raw in variants:
        calls = []
        peer = FakePeer(responses=[raw, b""])
        handle, _listener, peer, _filesystem, _clock, _events = prepare(
            peer=peer
        )

        rejected(lambda: handle.complete(
            EXPECTED_PID,
            EXPECTED_UID,
            lambda **values: calls.append(values),
        ))

        assert calls == []
        assert len(peer.sent) == 1
        assert peer.closed is True


def test_fixed_buffer_rejects_more_than_4096_bytes_without_commit():
    peer = FakePeer(
        responses=[
            b"a" * bootstrap.MAX_PHASE5_BOOTSTRAP_ADMISSION_BYTES,
            b"a",
            b"",
        ],
    )
    handle, _listener, peer, _filesystem, _clock, _events = prepare(
        peer=peer
    )
    calls = []

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: calls.append(values),
    ))

    assert calls == []
    assert len(peer.sent) == 1
    assert peer.closed is True


def test_trickle_does_not_renew_the_single_five_second_deadline():
    clock = FakeClock()
    valid = admission_line()
    peer = FakePeer(
        responses=[bytes([byte]) for byte in valid] + [b""],
        clock=clock,
        recv_advance=1.1,
    )
    handle, _listener, peer, _filesystem, _clock, _events = prepare(
        peer=peer,
        clock=clock,
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: committed([], **values),
    ))

    assert 1 < len(peer.responses) < len(valid)
    assert all(
        0 < timeout <= bootstrap.PHASE5_BOOTSTRAP_TIMEOUT_SECONDS
        for timeout in peer.timeouts
    )


def test_commit_failure_never_sends_ack():
    handle, _listener, peer, _filesystem, _clock, events = prepare()

    commit_admission = lambda **_values: (
        (_ for _ in ()).throw(RuntimeError("disk"))
    )
    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        commit_admission,
    ))

    assert len(peer.sent) == 1
    assert "receipt-challenge" not in events
    assert peer.closed is True
    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        commit_admission,
    ))


def test_missing_receipt_after_durable_commit_and_ack_fails_once():
    peer = FakePeer(responses=[admission_line(), b""])
    handle, _listener, peer, _filesystem, _clock, events = prepare(
        peer=peer,
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: committed(events, **values),
    ))

    assert len(peer.sent) == 2
    assert peer.shutdown_calls == []
    assert peer.closed is True
    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: committed(events, **values),
    ))


def test_receipt_is_canonical_bounded_and_bound_to_admission_lf_digest():
    valid = receipt()
    variants = [
        canonical(valid),
        receipt_line() + b"\n",
        b" " + receipt_line(),
        canonical({
            **valid,
            "admissionSha256": hashlib.sha256(
                admission_line()[:-1]
            ).hexdigest(),
        }) + b"\n",
        canonical({
            **valid,
            "kind": "phase5-candidate-capture-admission-ack",
        }) + b"\n",
        canonical({
            **valid,
            "receiptChallenge": CAPTURE_NONCE,
        }) + b"\n",
        canonical({**valid, "hidden": True}) + b"\n",
        b"a" * (bootstrap.MAX_PHASE5_BOOTSTRAP_RECEIPT_BYTES + 1),
    ]
    for raw in variants:
        peer = FakePeer(
            responses=[admission_line(), raw, b""],
        )
        handle, _listener, peer, _filesystem, _clock, events = (
            prepare(peer=peer)
        )

        rejected(lambda: handle.complete(
            EXPECTED_PID,
            EXPECTED_UID,
            lambda **values: committed(events, **values),
        ))

        assert len(peer.sent) == 2
        assert peer.shutdown_calls == []
        assert peer.closed is True


def test_receipt_trickle_cannot_renew_the_original_deadline():
    clock = FakeClock()
    raw = receipt_line()
    peer = FakePeer(
        responses=[admission_line()]
        + [bytes([byte]) for byte in raw]
        + [b""],
        clock=clock,
        recv_advance=1.1,
    )
    handle, _listener, peer, _filesystem, _clock, events = prepare(
        peer=peer,
        clock=clock,
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: committed(events, **values),
    ))

    assert len(peer.sent) == 2
    assert 1 < len(peer.responses) < len(raw)
    assert peer.closed is True


def test_pre_sent_receipt_cannot_guess_post_commit_challenge():
    guessed = receipt_line(
        receipt_challenge=CAPTURE_NONCE,
    )
    peer = FakePeer(
        responses=[admission_line(), guessed, b""],
    )
    handle, _listener, peer, _filesystem, _clock, events = prepare(
        peer=peer,
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: committed(events, **values),
    ))

    assert events.index("commit") < events.index("receipt-challenge")
    ack = json.loads(peer.sent[1])
    assert ack["receiptChallenge"] == RECEIPT_CHALLENGE
    assert json.loads(guessed)["receiptChallenge"] != (
        ack["receiptChallenge"]
    )
    assert peer.closed is True


def test_receipt_then_peer_only_half_close_never_completes():
    waits = []
    handle, _listener, peer, _filesystem, _clock, events = prepare(
        wait_for_peer_close=(
            lambda *args: waits.append(args) or False
        ),
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **values: committed(events, **values),
    ))

    assert len(waits) == 1
    assert len(peer.sent) == 2
    assert peer.shutdown_calls == []
    assert peer.closed is True


def test_close_before_accept_is_idempotent_and_seals_without_nonce_exposure():
    handle, listener, _peer, filesystem, _clock, _events = prepare()

    assert "6" * 64 not in repr(handle)
    assert not hasattr(handle, "__dict__")
    assert handle.close() is None
    assert handle.close() is None
    assert listener.closed is True
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]
    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **_values: None,
    ))


@pytest.mark.parametrize(
    "expected_pid,expected_uid",
    [
        (True, EXPECTED_UID),
        (0, EXPECTED_UID),
        (0x80000000, EXPECTED_UID),
        (EXPECTED_PID, True),
        (EXPECTED_PID, -1),
        (EXPECTED_PID, 0x100000000),
    ],
)
def test_invalid_expected_peer_seals_before_accept(
        expected_pid,
        expected_uid):
    handle, listener, peer, filesystem, _clock, _events = prepare()

    rejected(lambda: handle.complete(
        expected_pid,
        expected_uid,
        lambda **_values: None,
    ))

    assert listener.accept_count == 0
    assert listener.closed is True
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]
    assert peer.sent == []


def test_listener_failure_after_bind_closes_and_unlinks_the_owned_socket():
    events = []
    clock = FakeClock()
    filesystem = FakeFilesystem()
    peer = FakePeer(events=events, clock=clock)
    listener = FakeListener(
        filesystem,
        peer,
        events,
        listen_error=OSError("listen failed"),
    )

    rejected(lambda: bootstrap._prepare_phase5_candidate_bootstrap(
        bootstrap_directory=BOOTSTRAP_DIRECTORY,
        expected_identity=identity(),
        socket_factory=lambda: listener,
        monotonic=clock.monotonic,
        nonce_factory=lambda _size: CAPTURE_NONCE_BYTES,
        lstat=filesystem.lstat,
        chmod=filesystem.chmod,
        unlink=filesystem.unlink,
        geteuid=lambda: EXPECTED_UID,
        wait_for_peer_close=lambda *_args: True,
    ))

    assert listener.closed is True
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]
    assert BOOTSTRAP_SOCKET not in filesystem.nodes


def test_arbitrary_callback_failure_still_seals_and_cleans_up():
    class CommitFailure(Exception):
        pass

    handle, listener, peer, filesystem, _clock, _events = prepare()

    with pytest.raises(
            bootstrap.Phase5CandidateBootstrapError,
            match=r"^PHASE5_CANDIDATE_BOOTSTRAP_REQUIRED$") as raised:
        handle.complete(
            EXPECTED_PID,
            EXPECTED_UID,
            lambda **_values: (_ for _ in ()).throw(
                CommitFailure("commit failed")
            ),
        )

    assert isinstance(raised.value.__cause__, CommitFailure)
    assert listener.closed is True
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]
    assert peer.closed is True
    assert len(peer.sent) == 1
    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **_values: None,
    ))


def test_commit_that_exhausts_total_deadline_is_durable_but_never_acked():
    clock = FakeClock()
    handle, _listener, peer, _filesystem, _clock, events = prepare(
        clock=clock
    )

    def slow_commit(**values):
        result = committed(events, **values)
        clock.value += bootstrap.PHASE5_BOOTSTRAP_TIMEOUT_SECONDS
        return result

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        slow_commit,
    ))

    assert len(peer.sent) == 1
    assert peer.shutdown_calls == []
    assert peer.closed is True


def test_synchronous_reentry_closes_outer_exchange_without_ack_or_retry():
    handle, _listener, peer, _filesystem, _clock, _events = prepare()

    def reentrant_commit(**values):
        handle.close()
        return {
            "admissionSha256":
                hashlib.sha256(values["admission_raw"]).hexdigest(),
        }

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        reentrant_commit,
    ))

    assert len(peer.sent) == 1
    assert peer.closed is True
    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        reentrant_commit,
    ))


@pytest.mark.parametrize(
    "directory,mutate",
    [
        (
            "/tmp/attempt/bootstrap",
            lambda _filesystem: None,
        ),
        (
            BOOTSTRAP_DIRECTORY + "/",
            lambda _filesystem: None,
        ),
        (
            "/" + BOOTSTRAP_DIRECTORY,
            lambda _filesystem: None,
        ),
        (
            "tmp/attempt/run-flock-phase5-bootstrap",
            lambda _filesystem: None,
        ),
        (
            BOOTSTRAP_DIRECTORY,
            lambda filesystem: setattr(
                filesystem.nodes[BOOTSTRAP_DIRECTORY],
                "st_mode",
                stat.S_IFDIR | 0o755,
            ),
        ),
        (
            BOOTSTRAP_DIRECTORY,
            lambda filesystem: setattr(
                filesystem.nodes["/tmp/attempt"],
                "st_mode",
                stat.S_IFDIR | 0o755,
            ),
        ),
        (
            BOOTSTRAP_DIRECTORY,
            lambda filesystem: filesystem.bound(BOOTSTRAP_SOCKET),
        ),
    ],
)
def test_prepare_rejects_noncanonical_or_unowned_directory_before_nonce(
        directory,
        mutate):
    filesystem = FakeFilesystem()
    mutate(filesystem)
    calls = []

    rejected(lambda: bootstrap._prepare_phase5_candidate_bootstrap(
        bootstrap_directory=directory,
        expected_identity=identity(),
        socket_factory=lambda: calls.append("socket"),
        monotonic=lambda: 1.0,
        nonce_factory=lambda _size: calls.append("nonce"),
        lstat=filesystem.lstat,
        chmod=filesystem.chmod,
        unlink=filesystem.unlink,
        geteuid=lambda: EXPECTED_UID,
        wait_for_peer_close=lambda *_args: True,
    ))

    assert calls == []


def test_double_leading_slash_is_rejected_before_path_lookup():
    rejected(lambda: bootstrap._derive_bootstrap_socket_path(
        "/" + BOOTSTRAP_DIRECTORY
    ))


def test_transient_unlink_failure_is_retried_during_seal():
    class TransientFilesystem(FakeFilesystem):
        def __init__(self):
            super().__init__()
            self.unlink_calls = 0

        def unlink(self, path):
            self.unlink_calls += 1
            if self.unlink_calls == 1:
                raise OSError("transient")
            super().unlink(path)

    filesystem = TransientFilesystem()
    handle, _listener, peer, filesystem, _clock, _events = prepare(
        filesystem=filesystem,
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **_values: None,
    ))

    assert peer.sent == []
    assert filesystem.unlink_calls == 2
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]
    assert BOOTSTRAP_SOCKET not in filesystem.nodes


def test_close_can_retry_cleanup_after_a_transient_unlink_failure():
    class TransientFilesystem(FakeFilesystem):
        def __init__(self):
            super().__init__()
            self.unlink_calls = 0

        def unlink(self, path):
            self.unlink_calls += 1
            if self.unlink_calls == 1:
                raise OSError("transient")
            super().unlink(path)

    filesystem = TransientFilesystem()
    handle, listener, _peer, filesystem, _clock, _events = prepare(
        filesystem=filesystem,
    )

    rejected(handle.close)
    assert listener.closed is True
    assert BOOTSTRAP_SOCKET in filesystem.nodes

    assert handle.close() is None
    assert filesystem.unlink_calls == 2
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]


def test_replaced_socket_path_is_never_unlinked_or_sent_through():
    handle, _listener, peer, filesystem, _clock, _events = prepare()
    replacement = filesystem.node(
        stat.S_IFSOCK | 0o600,
        EXPECTED_UID,
    )
    filesystem.nodes[BOOTSTRAP_SOCKET] = replacement

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **_values: None,
    ))

    assert filesystem.nodes[BOOTSTRAP_SOCKET] is replacement
    assert filesystem.unlinked == []
    assert peer.sent == []


def test_failed_bind_never_unlinks_a_socket_it_did_not_prove_it_created():
    events = []
    clock = FakeClock()
    filesystem = FakeFilesystem()
    peer = FakePeer(events=events, clock=clock)
    listener = FakeListener(
        filesystem,
        peer,
        events,
        bind_error=OSError("address already in use"),
    )

    rejected(lambda: bootstrap._prepare_phase5_candidate_bootstrap(
        bootstrap_directory=BOOTSTRAP_DIRECTORY,
        expected_identity=identity(),
        socket_factory=lambda: listener,
        monotonic=clock.monotonic,
        nonce_factory=lambda _size: CAPTURE_NONCE_BYTES,
        lstat=filesystem.lstat,
        chmod=filesystem.chmod,
        unlink=filesystem.unlink,
        geteuid=lambda: EXPECTED_UID,
        wait_for_peer_close=lambda *_args: True,
    ))

    assert listener.closed is True
    assert filesystem.unlinked == []
    assert BOOTSTRAP_SOCKET in filesystem.nodes


def test_controller_uid_is_frozen_once_before_socket_creation():
    events = []
    clock = FakeClock()
    filesystem = FakeFilesystem()
    peer = FakePeer(events=events, clock=clock)
    listener = FakeListener(filesystem, peer, events)
    uid_calls = []

    def geteuid():
        uid_calls.append(None)
        return EXPECTED_UID

    handle = bootstrap._prepare_phase5_candidate_bootstrap(
        bootstrap_directory=BOOTSTRAP_DIRECTORY,
        expected_identity=identity(),
        socket_factory=lambda: listener,
        monotonic=clock.monotonic,
        nonce_factory=lambda _size: CAPTURE_NONCE_BYTES,
        lstat=filesystem.lstat,
        chmod=filesystem.chmod,
        unlink=filesystem.unlink,
        geteuid=geteuid,
        wait_for_peer_close=lambda *_args: True,
    )

    assert len(uid_calls) == 1
    handle.close()


def test_private_parent_must_remain_same_0700_inode_until_first_accept():
    handle, listener, peer, filesystem, _clock, _events = prepare()
    filesystem.nodes[BOOTSTRAP_DIRECTORY].st_mode = (
        stat.S_IFDIR | 0o755
    )

    rejected(lambda: handle.complete(
        EXPECTED_PID,
        EXPECTED_UID,
        lambda **_values: None,
    ))

    assert listener.accept_count == 0
    assert peer.sent == []
    assert listener.closed is True
    assert filesystem.unlinked == [BOOTSTRAP_SOCKET]


@pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="SO_PEERCRED and filesystem UDS authority require Linux",
)
@pytest.mark.parametrize(
    "mode",
    ["positive", "pre-sent-receipt", "half-close-only"],
)
def test_real_linux_public_transport_proves_receipt_and_full_close(mode):
    root = Path(tempfile.mkdtemp(prefix="phase5-bootstrap-", dir="/tmp"))
    bootstrap_directory = root / "run-flock-phase5-bootstrap"
    bootstrap_directory.mkdir(mode=0o700)
    os.chmod(root, 0o700)
    os.chmod(bootstrap_directory, 0o700)
    handle = None
    process = None
    try:
        handle = bootstrap.prepare_phase5_candidate_bootstrap_linux(
            str(bootstrap_directory),
            identity(),
        )
        child = r"""
import hashlib
import json
import os
import socket
import stat
import sys
import time

def canonical(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")

channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
socket_state = os.lstat(sys.argv[1])
assert stat.S_ISSOCK(socket_state.st_mode)
assert stat.S_IMODE(socket_state.st_mode) == 0o600
channel.connect(sys.argv[1])
request_raw = b""
while not request_raw.endswith(b"\n"):
    request_raw += channel.recv(4096)
request = json.loads(request_raw)
assert request_raw == canonical(request) + b"\n"
assert set(request) == {
    "schemaVersion", "kind", "identity", "captureNonce",
}
admission = {
    "schemaVersion": 1,
    "kind": "phase5-candidate-capture-admission",
    "runId": request["identity"]["runId"],
    "challenge": request["identity"]["challenge"],
    "captureNonce": request["captureNonce"],
    "signerSpkiSha256": sys.argv[2],
    "trustedSignerSpkiDerBase64": sys.argv[3],
}
admission_raw = canonical(admission) + b"\n"
if sys.argv[4] == "pre-sent-receipt":
    guessed_receipt = {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-admission-receipt",
        "admissionSha256": hashlib.sha256(admission_raw).hexdigest(),
        "receiptChallenge": request["captureNonce"],
    }
    channel.sendall(
        admission_raw + canonical(guessed_receipt) + b"\n"
    )
    while channel.recv(4096):
        pass
    channel.close()
    raise SystemExit(0)
channel.sendall(admission_raw)
ack_raw = b""
while not ack_raw.endswith(b"\n"):
    chunk = channel.recv(4096)
    if not chunk:
        raise RuntimeError("missing ACK")
    ack_raw += chunk
ack = json.loads(ack_raw)
assert ack_raw == canonical(ack) + b"\n"
assert ack == {
    "schemaVersion": 1,
    "kind": "phase5-candidate-capture-admission-ack",
    "admissionSha256": hashlib.sha256(admission_raw).hexdigest(),
    "receiptChallenge": ack["receiptChallenge"],
}
assert len(ack["receiptChallenge"]) == 64
assert all(
    character in "0123456789abcdef"
    for character in ack["receiptChallenge"]
)
receipt = {
    "schemaVersion": 1,
    "kind": "phase5-candidate-capture-admission-receipt",
    "admissionSha256": hashlib.sha256(admission_raw).hexdigest(),
    "receiptChallenge": ack["receiptChallenge"],
}
channel.sendall(canonical(receipt) + b"\n")
if sys.argv[4] == "half-close-only":
    channel.shutdown(socket.SHUT_WR)
    time.sleep(10)
channel.close()
"""
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                child,
                str(bootstrap_directory / "bootstrap.sock"),
                SPKI_SHA256,
                SPKI_BASE64,
                mode,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        committed_raw = []

        def commit_admission(**values):
            committed_raw.append(values["admission_raw"])
            return {
                "admissionSha256": hashlib.sha256(
                    values["admission_raw"]
                ).hexdigest(),
            }

        started = time.monotonic()
        if mode == "positive":
            result = handle.complete(
                process.pid,
                os.geteuid(),
                commit_admission,
            )
        else:
            failed = False
            try:
                handle.complete(
                    process.pid,
                    os.geteuid(),
                    commit_admission,
                )
            except bootstrap.Phase5CandidateBootstrapError:
                failed = True
            assert failed is True
            result = None
        elapsed = time.monotonic() - started
        if mode == "half-close-only":
            assert 4.5 <= elapsed < 7
            process.kill()
        stdout, stderr = process.communicate(timeout=5)

        if mode == "half-close-only":
            assert len(committed_raw) == 1
            return
        assert process.returncode == 0, (stdout, stderr)
        if mode == "pre-sent-receipt":
            assert len(committed_raw) <= 1
            return
        assert len(committed_raw) == 1
        committed_admission = json.loads(committed_raw[0])
        assert committed_raw[0] == canonical(committed_admission) + b"\n"
        expected_admission = admission()
        expected_admission["captureNonce"] = (
            committed_admission["captureNonce"]
        )
        assert committed_admission == expected_admission
        assert result.admission == committed_admission
        assert result.admission_sha256 == hashlib.sha256(
            committed_raw[0]
        ).hexdigest()
        assert not (bootstrap_directory / "bootstrap.sock").exists()
    finally:
        if handle is not None:
            handle.close()
        if process is not None and process.poll() is None:
            process.kill()
            process.communicate()
        shutil.rmtree(root)
