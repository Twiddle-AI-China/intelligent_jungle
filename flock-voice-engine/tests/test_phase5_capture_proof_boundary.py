from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import inspect
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "flock-voice-engine"
TOOL = ENGINE / "tools/validate_phase5_acceptance.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_capture_proof_boundary",
    TOOL,
)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

CAPTURE_VERIFIER_SOURCE_FILES = {
    "phase5-fault-verifier/verify-phase5-capture-proof.mjs":
        ENGINE / "runtime/tools/verify-phase5-capture-proof.mjs",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs":
        ENGINE / "runtime/tools/lib/phase5-fault-evidence.mjs",
    "src/capture/phase5-capture-proof.js":
        ENGINE / "runtime/src/capture/phase5-capture-proof.js",
    "src/capture/capture-wire.js":
        ENGINE / "runtime/src/capture/capture-wire.js",
}


def trusted_node_path() -> Path:
    discovered = shutil.which("node")
    assert discovered is not None
    return Path(discovered).resolve()


def capture_verifier_identity() -> dict[str, str]:
    return {
        name: hashlib.sha256(path.read_bytes()).hexdigest()
        for name, path in CAPTURE_VERIFIER_SOURCE_FILES.items()
    }


def copy_capture_verifier_closure(root: Path) -> Path:
    for name, source in CAPTURE_VERIFIER_SOURCE_FILES.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    return (
        root
        / "phase5-fault-verifier"
        / "verify-phase5-capture-proof.mjs"
    )


def generated_fixture() -> dict:
    if shutil.which("node") is None:
        pytest.skip("node unavailable")
    evidence_url = (
        ENGINE / "runtime/tools/lib/phase5-fault-evidence.mjs"
    ).as_uri()
    capture_url = (
        ENGINE / "runtime/tools/lib/phase5-capture-proof.mjs"
    ).as_uri()
    script = f"""
import {{
  createHash,
  generateKeyPairSync,
  sign,
}} from 'node:crypto';
import {{
  canonicalJson,
  createEd25519SignerDescriptor,
}} from {evidence_url!r};
import {{
  captureProofSigningBytes,
  validatePhase5CaptureProof,
}} from {capture_url!r};

const keyPair = generateKeyPairSync('ed25519');
const session = {{
  schemaVersion: 2,
  kind: 'phase5-fault-session-attestation',
  runId: '123e4567-e89b-42d3-a456-426614174000',
  challenge: '1'.repeat(64),
  release: {{
    releaseManifestSha256: '2'.repeat(64),
    releaseRevision: '3'.repeat(40),
    sourceManifestSha256: '4'.repeat(64),
    audioArtifactSha256: '5'.repeat(64),
  }},
  geometry: {{
    sampleRate: 44100,
    blockFrames: 4096,
    poolSize: 5,
    rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'],
  }},
  profile: {{
    clients: 4,
    slowClient: 4,
    durationMinutes: 30,
    speciesEndpoint: 'http://127.0.0.1:8081/v1',
    speciesModel: 'bird_agent',
  }},
  signer: createEd25519SignerDescriptor(keyPair.publicKey),
  captureProof: {{
    captureNonce: '8'.repeat(64),
    rawManifestSha256: '9'.repeat(64),
    signature: '',
  }},
}};
const signingInput = {{
  runId: session.runId,
  challenge: session.challenge,
  release: session.release,
  geometry: session.geometry,
  profile: session.profile,
  signer: session.signer,
  captureNonce: session.captureProof.captureNonce,
  rawManifestSha256: session.captureProof.rawManifestSha256,
}};
session.captureProof.signature = sign(
  null,
  captureProofSigningBytes(signingInput),
  keyPair.privateKey,
).toString('base64');
const runBinding = {{
  runId: session.runId,
  challenge: session.challenge,
  release: structuredClone(session.release),
  geometry: structuredClone(session.geometry),
  profile: structuredClone(session.profile),
  signerSpkiSha256: session.signer.publicKeySpkiSha256,
  faultSessionEvidenceSha256: createHash('sha256')
    .update(Buffer.from(canonicalJson(session), 'utf8'))
    .digest('hex'),
  captureNonce: session.captureProof.captureNonce,
  rawManifestSha256: session.captureProof.rawManifestSha256,
}};
const trustedSignerSpkiDerBase64 =
  session.signer.publicKeySpkiDerBase64;
const expected = validatePhase5CaptureProof(
  session,
  runBinding,
  trustedSignerSpkiDerBase64,
);
process.stdout.write(canonicalJson({{
  session,
  runBinding,
  trustedSignerSpkiDerBase64,
  expected,
}}));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    return validator.strict_json_bytes(
        completed.stdout,
        "PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED",
    )


@pytest.fixture(scope="module")
def capture_fixture() -> dict:
    return generated_fixture()


def capture_session_raw(value: dict) -> bytes:
    return validator.phase5_canonical(value["session"])


def expected_boundary_result(value: dict) -> dict:
    projection = {
        name: copy.deepcopy(value["runBinding"][name])
        for name in validator.PHASE5_FAULT_RUN_BINDING_PROJECTION_FIELDS
    }
    return {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-boundary-result",
        "captureValidation": value["expected"],
        "faultRunBindingProjection": projection,
    }


def channel_admission(value: dict) -> dict:
    return {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-admission",
        "runId": value["runBinding"]["runId"],
        "challenge": value["runBinding"]["challenge"],
        "captureNonce": value["runBinding"]["captureNonce"],
        "signerSpkiSha256":
            value["runBinding"]["signerSpkiSha256"],
        "trustedSignerSpkiDerBase64":
            value["trustedSignerSpkiDerBase64"],
    }


def channel_response(value: dict) -> dict:
    return {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-finalize-response",
        "session": copy.deepcopy(value["session"]),
        "runBinding": copy.deepcopy(value["runBinding"]),
        "captureValidation": copy.deepcopy(value["expected"]),
    }


def expected_run_identity_raw(value: dict) -> bytes:
    return validator.phase5_canonical({
        name: copy.deepcopy(value["runBinding"][name])
        for name in (
            "runId", "challenge", "release", "geometry", "profile",
        )
    })


def verifier_returning(result: dict, seen: list | None = None):
    def run(verifier_path: Path, envelope: bytes) -> bytes:
        if seen is not None:
            seen.append((verifier_path, envelope))
        return validator.phase5_canonical(result) + b"\n"
    return run


def assert_capture_rejected(callback) -> None:
    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED$"):
        callback()


def test_validator_pins_exact_current_capture_verifier_closure():
    assert validator.PHASE5_CAPTURE_VERIFIER_PINNED_SHA256 == (
        capture_verifier_identity()
    )


def test_public_capture_boundary_exposes_no_verifier_substitution_seams():
    parameters = inspect.signature(
        validator.validate_phase5_capture_proof_boundary
    ).parameters

    assert tuple(parameters) == (
        "session_raw",
        "full_run_binding",
        "trusted_signer_spki_der_base64",
    )
    for forbidden in (
            "verifier_path", "verifier_runner", "verifier_identity",
            "node_executable"):
        assert forbidden not in parameters


def test_public_capture_session_boundary_derives_binding_without_seams():
    parameters = inspect.signature(
        validator.validate_phase5_capture_session_boundary
    ).parameters

    assert tuple(parameters) == (
        "session_raw",
        "trusted_signer_spki_der_base64",
    )
    for forbidden in (
            "full_run_binding", "verifier_path", "verifier_runner",
            "verifier_identity", "node_executable"):
        assert forbidden not in parameters


def test_public_channel_response_boundary_exposes_no_execution_seams():
    parameters = inspect.signature(
        validator.validate_phase5_capture_channel_response_boundary
    ).parameters

    assert tuple(parameters) == (
        "response_raw",
        "expected_admission",
        "expected_raw_manifest_sha256",
        "expected_run_identity_raw",
    )
    for forbidden in (
            "trusted_signer_spki_der_base64", "verifier_path",
            "verifier_runner", "verifier_identity", "node_executable",
            "expected_pid", "expected_uid"):
        assert forbidden not in parameters


def test_channel_response_boundary_requires_controller_owned_run_identity(
        capture_fixture, monkeypatch):
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    result = validator.validate_phase5_capture_channel_response_boundary(
        validator.phase5_canonical(
            channel_response(capture_fixture)
        ) + b"\n",
        channel_admission(capture_fixture),
        capture_fixture["runBinding"]["rawManifestSha256"],
        expected_run_identity_raw(capture_fixture),
    )

    assert result == expected_boundary_result(capture_fixture)


def test_capture_boundary_passes_one_exact_owned_envelope(
        capture_fixture):
    seen = []
    verifier_path = Path("trusted-capture-verifier.mjs")

    result = validator._validate_phase5_capture_proof_boundary(
        capture_session_raw(capture_fixture),
        capture_fixture["runBinding"],
        capture_fixture["trustedSignerSpkiDerBase64"],
        verifier_path=verifier_path,
        verifier_runner=verifier_returning(
            capture_fixture["expected"],
            seen,
        ),
    )

    assert result == expected_boundary_result(capture_fixture)
    assert seen == [(
        verifier_path,
        validator.phase5_canonical({
            "session": capture_fixture["session"],
            "runBinding": capture_fixture["runBinding"],
            "trustedSignerSpkiDerBase64":
                capture_fixture["trustedSignerSpkiDerBase64"],
        }) + b"\n",
    )]


def test_public_capture_boundary_invokes_real_fixed_memory_closure(
        capture_fixture, monkeypatch):
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    result = validator.validate_phase5_capture_proof_boundary(
        capture_session_raw(capture_fixture),
        capture_fixture["runBinding"],
        capture_fixture["trustedSignerSpkiDerBase64"],
    )

    assert result == expected_boundary_result(capture_fixture)


def test_capture_session_boundary_derives_the_exact_signed_full_binding(
        capture_fixture, monkeypatch):
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    result = validator.validate_phase5_capture_session_boundary(
        capture_session_raw(capture_fixture),
        capture_fixture["trustedSignerSpkiDerBase64"],
    )

    assert result == expected_boundary_result(capture_fixture)
    assert {
        name: result["captureValidation"][name]
        for name in (
            "runId", "challenge", "release", "geometry", "profile",
            "signerSpkiSha256", "faultSessionEvidenceSha256",
            "captureNonce", "rawManifestSha256",
        )
    } == capture_fixture["runBinding"]


def test_capture_session_boundary_rejects_self_signed_replacement_session(
        capture_fixture, monkeypatch):
    attacker = generated_fixture()
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_session_boundary(
            capture_session_raw(attacker),
            capture_fixture["trustedSignerSpkiDerBase64"],
        )
    )


def test_channel_response_boundary_exact_binds_admission_and_manifest(
        capture_fixture, monkeypatch):
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )
    response = channel_response(capture_fixture)

    result = validator.validate_phase5_capture_channel_response_boundary(
        validator.phase5_canonical(response) + b"\n",
        channel_admission(capture_fixture),
        capture_fixture["runBinding"]["rawManifestSha256"],
        expected_run_identity_raw(capture_fixture),
    )

    assert result == expected_boundary_result(capture_fixture)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda identity: identity.update(
            runId="ffffffff-ffff-4fff-afff-ffffffffffff"),
        lambda identity: identity.update(challenge="a" * 64),
        lambda identity: identity["release"].update(
            releaseRevision="f" * 40),
        lambda identity: identity["geometry"].update(
            blockFrames=2048),
        lambda identity: identity["profile"].update(clients=3),
        lambda identity: identity.update(hidden=True),
    ],
)
def test_channel_response_boundary_rejects_controller_identity_rebinding(
        capture_fixture, monkeypatch, mutation):
    identity = json.loads(expected_run_identity_raw(capture_fixture))
    mutation(identity)
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_channel_response_boundary(
            validator.phase5_canonical(
                channel_response(capture_fixture)
            ) + b"\n",
            channel_admission(capture_fixture),
            capture_fixture["runBinding"]["rawManifestSha256"],
            validator.phase5_canonical(identity),
        )
    )


@pytest.mark.parametrize(
    "identity_raw_factory",
    [
        lambda raw: raw + b" ",
        lambda raw: b" " + raw,
        lambda raw: type("BytesSubclass", (bytes,), {})(raw),
        lambda _raw: b"{}" + b" " * (
            validator.MAX_PHASE5_CAPTURE_RUN_IDENTITY_BYTES
        ),
    ],
)
def test_channel_response_boundary_requires_bounded_canonical_identity_bytes(
        capture_fixture, identity_raw_factory):
    identity_raw = expected_run_identity_raw(capture_fixture)

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_channel_response_boundary(
            validator.phase5_canonical(
                channel_response(capture_fixture)
            ) + b"\n",
            channel_admission(capture_fixture),
            capture_fixture["runBinding"]["rawManifestSha256"],
            identity_raw_factory(identity_raw),
        )
    )


def test_channel_response_boundary_rejects_bytes_subclasses(
        capture_fixture, monkeypatch):
    class BytesSubclass(bytes):
        pass

    response_raw = BytesSubclass(
        validator.phase5_canonical(
            channel_response(capture_fixture)
        ) + b"\n"
    )
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_channel_response_boundary(
            response_raw,
            channel_admission(capture_fixture),
            capture_fixture["runBinding"]["rawManifestSha256"],
            expected_run_identity_raw(capture_fixture),
        )
    )


def test_channel_response_boundary_rejects_oversized_admission_spki_before_decode(
        capture_fixture, monkeypatch):
    admission = channel_admission(capture_fixture)
    admission["trustedSignerSpkiDerBase64"] = "A" * (1024 * 1024)
    decode_calls = []

    def record_decode(value, code):
        decode_calls.append((value, code))
        return b""

    monkeypatch.setattr(
        validator,
        "decode_canonical_base64",
        record_decode,
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_channel_response_boundary(
            validator.phase5_canonical(
                channel_response(capture_fixture)
            ) + b"\n",
            admission,
            capture_fixture["runBinding"]["rawManifestSha256"],
            expected_run_identity_raw(capture_fixture),
        )
    )
    assert decode_calls == []


@pytest.mark.parametrize(
    "mutation",
    [
        lambda response, admission: response["runBinding"].update(
            captureNonce="a" * 64),
        lambda response, admission: response[
            "captureValidation"
        ].update(rawManifestSha256="a" * 64),
        lambda response, admission: response["session"][
            "captureProof"
        ].update(rawManifestSha256="a" * 64),
        lambda response, admission: admission.update(
            captureNonce="a" * 64),
        lambda response, admission: admission.update(
            signerSpkiSha256="a" * 64),
        lambda response, admission: response.update(hidden=True),
    ],
)
def test_channel_response_boundary_rejects_rebinding(
        capture_fixture, monkeypatch, mutation):
    response = channel_response(capture_fixture)
    admission = channel_admission(capture_fixture)
    mutation(response, admission)
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_channel_response_boundary(
            validator.phase5_canonical(response) + b"\n",
            admission,
            capture_fixture["runBinding"]["rawManifestSha256"],
            expected_run_identity_raw(capture_fixture),
        )
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda response: response["captureValidation"].update(
            schemaVersion=True),
        lambda response: response["captureValidation"].update(
            passed=1),
    ],
)
def test_channel_response_boundary_rejects_python_bool_int_aliases(
        capture_fixture, monkeypatch, mutation):
    response = channel_response(capture_fixture)
    mutation(response)
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_channel_response_boundary(
            validator.phase5_canonical(response) + b"\n",
            channel_admission(capture_fixture),
            capture_fixture["runBinding"]["rawManifestSha256"],
            expected_run_identity_raw(capture_fixture),
        )
    )


@pytest.mark.parametrize(
    "raw_factory",
    [
        lambda raw: raw[:-1],
        lambda raw: b" " + raw,
        lambda raw: raw + b"\n",
        lambda raw: b'{"schemaVersion":1,' + raw[1:],
        lambda _raw: b"\xff\n",
    ],
)
def test_channel_response_boundary_requires_one_canonical_line(
        capture_fixture, raw_factory):
    raw = validator.phase5_canonical(
        channel_response(capture_fixture),
    ) + b"\n"

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_channel_response_boundary(
            raw_factory(raw),
            channel_admission(capture_fixture),
            capture_fixture["runBinding"]["rawManifestSha256"],
            expected_run_identity_raw(capture_fixture),
        )
    )


def test_capture_runner_executes_verified_bytes_not_mutable_module_paths(
        tmp_path, monkeypatch):
    entry = copy_capture_verifier_closure(tmp_path)
    trusted_entry = entry.read_bytes()
    calls = []

    def run(*args, **kwargs):
        entry.write_bytes(b"attacker replacement")
        package = json.loads(kwargs["input"])
        calls.append((args, kwargs, package))
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=b"{}\n",
            stderr=b"",
        )

    monkeypatch.setattr(validator.subprocess, "run", run)

    assert validator._run_phase5_capture_proof_verifier(
        entry,
        b"{}\n",
        capture_verifier_identity(),
        trusted_node_path(),
    ) == b"{}\n"
    assert len(calls) == 1
    package = calls[0][2]
    assert package["operation"] == "capture-proof-validation"
    assert set(package["modules"]) == set(
        validator.PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES
    )
    assert base64.b64decode(
        package["modules"][
            "phase5-fault-verifier/verify-phase5-capture-proof.mjs"
        ],
        validate=True,
    ) == trusted_entry
    assert all(
        os.fspath(entry) not in str(argument)
        for argument in calls[0][0][0]
    )


def test_capture_runner_rejects_wrong_module_identity_before_execution(
        tmp_path, monkeypatch):
    entry = copy_capture_verifier_closure(tmp_path)
    identity = capture_verifier_identity()
    identity[
        "src/capture/phase5-capture-proof.js"
    ] = "f" * 64
    called = []
    monkeypatch.setattr(
        validator.subprocess,
        "run",
        lambda *_args, **_kwargs: called.append(True),
    )

    assert_capture_rejected(
        lambda: validator._run_phase5_capture_proof_verifier(
            entry,
            b"{}\n",
            identity,
            trusted_node_path(),
        )
    )
    assert called == []


@pytest.mark.parametrize(
    "raw_factory",
    [
        lambda raw: raw + b"\n",
        lambda raw: b" " + raw,
        lambda raw: (
            b'{"schemaVersion":2,' + raw[1:]
        ),
        lambda _raw: b"\xff",
    ],
)
def test_capture_boundary_rejects_noncanonical_session_before_runner(
        capture_fixture, raw_factory):
    called = []
    raw = raw_factory(capture_session_raw(capture_fixture))

    assert_capture_rejected(
        lambda: validator._validate_phase5_capture_proof_boundary(
            raw,
            capture_fixture["runBinding"],
            capture_fixture["trustedSignerSpkiDerBase64"],
            verifier_path=Path("unused.mjs"),
            verifier_runner=lambda *_args: called.append(True),
        )
    )
    assert called == []


def test_capture_boundary_rejects_oversize_session_before_runner(
        capture_fixture):
    called = []
    raw = b" " * (
        validator.MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES + 1
    )

    assert_capture_rejected(
        lambda: validator._validate_phase5_capture_proof_boundary(
            raw,
            capture_fixture["runBinding"],
            capture_fixture["trustedSignerSpkiDerBase64"],
            verifier_path=Path("unused.mjs"),
            verifier_runner=lambda *_args: called.append(True),
        )
    )
    assert called == []


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value["runBinding"].update(
            captureNonce="a" * 64),
        lambda value: value["runBinding"].update(
            rawManifestSha256="b" * 64),
        lambda value: value["session"]["captureProof"].update(
            captureNonce="a" * 64),
        lambda value: value["session"]["release"].update(
            releaseManifestSha256="a" * 64),
        lambda value: value["session"].update(schemaVersion=1),
    ],
)
def test_real_capture_boundary_rejects_tampered_session_or_binding(
        capture_fixture, monkeypatch, mutation):
    value = copy.deepcopy(capture_fixture)
    mutation(value)
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_proof_boundary(
            validator.phase5_canonical(value["session"]),
            value["runBinding"],
            value["trustedSignerSpkiDerBase64"],
        )
    )


def test_real_capture_boundary_rejects_replacement_external_trust(
        capture_fixture, monkeypatch):
    attacker = generated_fixture()
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE",
        os.fspath(trusted_node_path()),
    )

    assert_capture_rejected(
        lambda: validator.validate_phase5_capture_proof_boundary(
            capture_session_raw(capture_fixture),
            capture_fixture["runBinding"],
            attacker["trustedSignerSpkiDerBase64"],
        )
    )


@pytest.mark.parametrize(
    "result_mutation",
    [
        lambda result: result.update(hidden=True),
        lambda result: result.update(runId=(
            "123e4567-e89b-42d3-a456-426614174001")),
        lambda result: result.update(captureNonce="a" * 64),
        lambda result: result.update(passed=False),
    ],
)
def test_capture_boundary_exact_binds_verifier_result(
        capture_fixture, result_mutation):
    forged = copy.deepcopy(capture_fixture["expected"])
    result_mutation(forged)

    assert_capture_rejected(
        lambda: validator._validate_phase5_capture_proof_boundary(
            capture_session_raw(capture_fixture),
            capture_fixture["runBinding"],
            capture_fixture["trustedSignerSpkiDerBase64"],
            verifier_path=Path("test-verifier.mjs"),
            verifier_runner=verifier_returning(forged),
        )
    )


@pytest.mark.parametrize(
    "raw_result",
    [
        b"{}\n\n",
        b"{}",
        b'{"kind":"x", "schemaVersion":1}\n',
        b"\xff\n",
    ],
)
def test_capture_boundary_requires_one_canonical_result_line(
        capture_fixture, raw_result):
    assert_capture_rejected(
        lambda: validator._validate_phase5_capture_proof_boundary(
            capture_session_raw(capture_fixture),
            capture_fixture["runBinding"],
            capture_fixture["trustedSignerSpkiDerBase64"],
            verifier_path=Path("test-verifier.mjs"),
            verifier_runner=lambda *_args: raw_result,
        )
    )
