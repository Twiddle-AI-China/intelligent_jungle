from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

from linux_release_security import linux_release_security

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
spec = importlib.util.spec_from_file_location("phase5_acceptance_machine", VALIDATOR)
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)

H = "a" * 64
GIB = 1024 ** 3
RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
CHALLENGE = "1" * 64
CAPTURE_NONCE = "8" * 64
RAW_MANIFEST_SHA256 = "9" * 64
RELEASE = {
    "releaseManifestSha256": "2" * 64,
    "releaseRevision": "3" * 40,
    "sourceManifestSha256": "4" * 64,
    "audioArtifactSha256": "5" * 64,
}
GEOMETRY = {
    "sampleRate": 44100,
    "blockFrames": 4096,
    "poolSize": 5,
    "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
}
PROFILE = {
    "clients": 4,
    "slowClient": 4,
    "durationMinutes": 30,
    "speciesEndpoint": "http://127.0.0.1:8081/v1",
    "speciesModel": "bird_agent",
}
ED25519_SPKI = bytes.fromhex("302a300506032b6570032100") + bytes(range(32))
COMMON_EVIDENCE_FILES = (
    "machine-id",
    "ssh-host-ed25519.pub",
    "interfaces.json",
    "gpus.txt",
    "cuda-driver.txt",
    "torch.json",
    "available-memory.txt",
    "architecture.txt",
    "vllm-normal-profile.json",
    "vllm-burst-profile.json",
)


def fault_session():
    return {
        "schemaVersion": 2,
        "kind": "phase5-fault-session-attestation",
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "release": copy.deepcopy(RELEASE),
        "geometry": copy.deepcopy(GEOMETRY),
        "profile": copy.deepcopy(PROFILE),
        "signer": {
            "algorithm": "Ed25519",
            "publicKeySpkiDerBase64": base64.b64encode(ED25519_SPKI).decode("ascii"),
            "publicKeySpkiSha256": hashlib.sha256(ED25519_SPKI).hexdigest(),
        },
        "captureProof": {
            "captureNonce": CAPTURE_NONCE,
            "rawManifestSha256": RAW_MANIFEST_SHA256,
            "signature": base64.b64encode(b"\0" * 64).decode("ascii"),
        },
    }


def session_binding(session=None):
    value = fault_session() if session is None else session
    return {
        "runId": value["runId"],
        "challenge": value["challenge"],
        "release": copy.deepcopy(value["release"]),
        "geometry": copy.deepcopy(value["geometry"]),
        "profile": copy.deepcopy(value["profile"]),
        "signerSpkiSha256": value["signer"]["publicKeySpkiSha256"],
        "faultSessionEvidenceSha256": hashlib.sha256(
            acceptance.canonical(value)).hexdigest(),
        "captureNonce": value["captureProof"]["captureNonce"],
        "rawManifestSha256":
            value["captureProof"]["rawManifestSha256"],
    }


def attestation(address="192.168.9.140", machine="b", key="c", gpu="GPU-one",
                driver="580.159.03", cuda="13", total_memory=128 * GIB,
                role="production-baseline", run_binding=None):
    if role == "staging-phase5" and run_binding is None:
        run_binding = session_binding()
    return {"schemaVersion": 2, "attestationRole": role, "runBinding": run_binding,
            "hostname": "host", "machineIdSha256": machine * 64,
            "sshHostKeySha256": "SHA256:" + key * 43,
            "canonicalInterfaceAddresses": [address], "gpuUuids": [gpu],
            "platform": {"architecture": "aarch64", "gpuModel": "NVIDIA GB10",
                         "driverVersion": driver, "torchVersion": "2", "cudaVersion": cuda,
                         "cudaAvailable": True, "availableMemoryBytes": 120 * GIB,
                         "totalMemoryBytes": total_memory,
                         "memoryClassBytes": acceptance.memory_class_bytes(total_memory)},
            "rawEvidence": {name: H for name in ("machineId", "sshHostKey", "interfaces", "gpus")},
            "environmentEvidence": {name: H for name in ("cudaDriver", "torch", "availableMemory",
                                                           "architecture", "vllmNormalProfile",
                                                           "vllmBurstProfile")}}


def staging_attestation(address="192.168.9.141", machine="d", key="e", gpu="GPU-two",
                        **kwargs):
    return attestation(address, machine, key, gpu, role="staging-phase5", **kwargs)


def import_capture(name="capture_machine_role_binding"):
    capture_path = ROOT / "flock-voice-engine/tools/capture_machine_attestation.py"
    capture_spec = importlib.util.spec_from_file_location(name, capture_path)
    capture = importlib.util.module_from_spec(capture_spec)
    capture_spec.loader.exec_module(capture)
    return capture


def write_machine_evidence(path, value, session=None):
    evidence = path.with_suffix(".evidence")
    evidence.mkdir()
    key_blob = b"host-key-material"
    bodies = {
        "machine-id": b"machine-one\n",
        "ssh-host-ed25519.pub":
            b"ssh-ed25519 " + base64.b64encode(key_blob) + b" host\n",
        "interfaces.json": json.dumps([{
            "addr_info": [{"local": value["canonicalInterfaceAddresses"][0]}],
        }]).encode(),
        "gpus.txt": (value["gpuUuids"][0] + "\n").encode(),
        "cuda-driver.txt": (
            f'{value["platform"]["driverVersion"]}, '
            f'{value["platform"]["gpuModel"]}, 100\n').encode(),
        "torch.json": acceptance.canonical({
            "available": True,
            "version": value["platform"]["torchVersion"],
            "cuda": value["platform"]["cudaVersion"],
        }),
        "available-memory.txt":
            b"MemTotal: 125829120 kB\nMemAvailable: 1234 kB\n",
        "architecture.txt": b"aarch64\n",
        "vllm-normal-profile.json": b'[{"atMs":0,"latencyMs":1,"ok":true}]',
        "vllm-burst-profile.json": b'[{"atMs":0,"latencyMs":2,"ok":true}]',
    }
    value["machineIdSha256"] = hashlib.sha256(bodies["machine-id"]).hexdigest()
    value["sshHostKeySha256"] = (
        "SHA256:" + base64.b64encode(hashlib.sha256(key_blob).digest())
        .decode().rstrip("="))
    value["rawEvidence"] = {
        field: hashlib.sha256(bodies[name]).hexdigest()
        for field, name in {
            "machineId": "machine-id",
            "sshHostKey": "ssh-host-ed25519.pub",
            "interfaces": "interfaces.json",
            "gpus": "gpus.txt",
        }.items()
    }
    value["environmentEvidence"] = {
        field: hashlib.sha256(bodies[name]).hexdigest()
        for field, name in {
            "cudaDriver": "cuda-driver.txt",
            "torch": "torch.json",
            "availableMemory": "available-memory.txt",
            "architecture": "architecture.txt",
            "vllmNormalProfile": "vllm-normal-profile.json",
            "vllmBurstProfile": "vllm-burst-profile.json",
        }.items()
    }
    value["platform"]["totalMemoryBytes"] = 120 * GIB
    value["platform"]["availableMemoryBytes"] = 1234 * 1024
    value["platform"]["memoryClassBytes"] = 128 * GIB
    for name, body in bodies.items():
        (evidence / name).write_bytes(body)
    if session is not None:
        (evidence / "fault-session-attestation.json").write_bytes(
            acceptance.canonical(session))
    path.write_bytes(acceptance.canonical(value))
    return evidence


def test_shared_loopback_and_link_local_addresses_are_ignored():
    production = ["127.0.0.1", "::1", "169.254.10.20", "fe80::1%eth0", "192.168.9.140"]
    staging = ["127.0.0.1", "::1", "169.254.10.20", "fe80::1%eth1", "192.168.9.141"]
    assert acceptance.canonical_machine_addresses(production) == ["192.168.9.140"]
    assert acceptance.canonical_machine_addresses(staging) == ["192.168.9.141"]
    acceptance.assert_machine_address_sets_are_distinct(production, staging)


def test_canonical_nonlocal_address_collision_still_fails():
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.assert_machine_address_sets_are_distinct(["::ffff:192.168.9.140"],
                                                            ["192.168.9.140"])


@pytest.mark.parametrize("field", ["machineIdSha256", "sshHostKeySha256", "gpuUuids",
                                    "canonicalInterfaceAddresses"])
def test_stable_identity_collision_fails_even_when_hostname_differs(field):
    production = attestation(); staging = staging_attestation()
    staging["hostname"] = "different-name"
    staging[field] = copy.deepcopy(production[field])
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_machine_separation(production, staging)


def test_filtering_to_empty_and_noncanonical_claim_fail_closed():
    value = attestation(); value["canonicalInterfaceAddresses"] = ["127.0.0.1"]
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation(value)
    value["canonicalInterfaceAddresses"] = ["2001:0DB8:0:0:0:0:0:1"]
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation(value)


@pytest.mark.parametrize("mutation", [
    lambda value: value["platform"].update(driverVersion="581.0"),
    lambda value: value["platform"].update(cudaVersion="13.1"),
    lambda value: value["platform"].update(
        totalMemoryBytes=64 * GIB, memoryClassBytes=64 * GIB),
])
def test_equivalent_machine_requires_same_driver_cuda_and_memory_class(mutation):
    production = attestation()
    staging = staging_attestation()
    mutation(staging)
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_machine_equivalence(production, staging)


def test_memory_class_is_derived_and_nearby_totals_share_the_same_class():
    production = attestation(total_memory=121 * GIB)
    staging = staging_attestation(total_memory=123 * GIB)
    assert production["platform"]["memoryClassBytes"] == 128 * GIB
    assert staging["platform"]["memoryClassBytes"] == 128 * GIB
    acceptance.validate_machine_equivalence(production, staging)
    assert acceptance.memory_class_bytes(120 * GIB - 1) == 128 * GIB
    assert acceptance.memory_class_bytes(120 * GIB) == 128 * GIB

    staging["platform"]["memoryClassBytes"] = 112 * GIB
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation(staging)

    staging = staging_attestation()
    staging["platform"]["availableMemoryBytes"] = (
        staging["platform"]["totalMemoryBytes"] + 1)
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation(staging)


@pytest.mark.parametrize("raw", [
    b"MemTotal: 125829120 MB\nMemAvailable: 1234 kB\n",
    b"MemTotal: 125829120 kB\nMemTotal: 125829120 kB\nMemAvailable: 1234 kB\n",
    b"MemTotal: 125829120 kB\n",
    b"MemTotal: not-a-number kB\nMemAvailable: 1234 kB\n",
    b"MemTotal: 125829120 kB\nMemAvailable: 125829121 kB\n",
])
def test_meminfo_requires_unique_decimal_kib_fields_and_available_within_total(raw):
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.parse_meminfo_bytes(raw)


def test_meminfo_parser_returns_bound_total_and_available_bytes():
    assert acceptance.parse_meminfo_bytes(
        b"MemTotal:       125829120 kB\nMemFree: 1 kB\nMemAvailable:\t1234 kB\n"
    ) == (120 * GIB, 1234 * 1024)


def test_ssh_fingerprint_is_openssh_sha256(monkeypatch):
    capture = import_capture("capture_machine")
    key_blob = b"binary-ed25519-key"
    public = b"ssh-ed25519 " + base64.b64encode(key_blob) + b" test\n"
    expected = "SHA256:" + base64.b64encode(hashlib.sha256(key_blob).digest()).decode().rstrip("=")
    assert capture.ssh_fingerprint(public) == expected


def test_attestation_roles_and_run_binding_are_exact():
    production = attestation()
    staging = staging_attestation()
    acceptance.validate_attestation(production)
    acceptance.validate_attestation(staging)
    acceptance.validate_machine_equivalence(production, staging)

    mutations = [
        lambda value: value.update(attestationRole="staging-phase5"),
        lambda value: value.update(runBinding=session_binding()),
        lambda value: value.update(attestationRole="unknown"),
        lambda value: value.update(hidden=True),
    ]
    for mutation in mutations:
        invalid = attestation()
        mutation(invalid)
        with pytest.raises(acceptance.AcceptanceError,
                           match="EQUIVALENT_STAGING_REQUIRED"):
            acceptance.validate_attestation(invalid)

    missing = staging_attestation()
    missing["runBinding"] = None
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation(missing)


@pytest.mark.parametrize("mutation", [
    lambda value: value["runBinding"].update(runId="not-a-uuid"),
    lambda value: value["runBinding"].update(challenge="0" * 63),
    lambda value: value["runBinding"]["release"].update(releaseRevision="0" * 39),
    lambda value: value["runBinding"]["release"].update(hidden=True),
    lambda value: value["runBinding"]["geometry"].update(sampleRate=True),
    lambda value: value["runBinding"]["profile"].update(clients=True),
    lambda value: value["runBinding"].update(signerSpkiSha256="0" * 63),
    lambda value: value["runBinding"].update(captureNonce="0" * 63),
    lambda value: value["runBinding"].update(rawManifestSha256="A" * 64),
    lambda value: value["runBinding"].update(hidden=True),
])
def test_staging_run_binding_rejects_type_shape_and_hidden_field_attacks(mutation):
    value = staging_attestation()
    mutation(value)
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation(value)


def test_staging_rejects_legacy_seven_field_binding_but_production_null_remains():
    full = session_binding()
    legacy = acceptance.phase5_fault_run_binding_projection(full)
    value = staging_attestation(run_binding=legacy)

    with pytest.raises(
            acceptance.AcceptanceError,
            match=r"^EQUIVALENT_STAGING_REQUIRED$"):
        acceptance.validate_attestation(value)

    production = attestation()
    acceptance.validate_attestation(production)
    assert production["runBinding"] is None


def test_machine_equivalence_requires_production_then_staging_roles():
    production = attestation()
    staging = staging_attestation()
    wrong_production = copy.deepcopy(production)
    wrong_production["attestationRole"] = "staging-phase5"
    wrong_production["runBinding"] = session_binding()
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_machine_equivalence(wrong_production, staging)

    wrong_staging = copy.deepcopy(staging)
    wrong_staging["attestationRole"] = "production-baseline"
    wrong_staging["runBinding"] = None
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_machine_equivalence(production, wrong_staging)


def test_capture_role_gate_reads_only_fixed_candidate_root_session(tmp_path, monkeypatch):
    capture = import_capture()
    session = fault_session()
    candidate_root = tmp_path / "candidate-run"
    candidate_root.mkdir()
    monkeypatch.setattr(capture, "CANDIDATE_RUN_ROOT", candidate_root)
    session_path = candidate_root / "phase5-fault-session-attestation.json"
    session_path.write_bytes(acceptance.canonical(session))

    assert capture.load_fault_session_attestation("production-baseline") == (None, None)
    raw, binding = capture.load_fault_session_attestation(
        "staging-phase5")
    assert raw == acceptance.canonical(session)
    assert binding == session_binding(session)
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.load_fault_session_attestation("production-baseline", session_path)
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.load_fault_session_attestation(
            "staging-phase5", tmp_path / "phase5-fault-session-attestation.json")

    copied_fault_events = copy.deepcopy(session)
    copied_fault_events["kind"] = "isolated-equivalent-spark-fault-events"
    copied_fault_events["scenarioEvents"] = []
    session_path.write_bytes(acceptance.canonical(copied_fault_events))
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.load_fault_session_attestation("staging-phase5")


def test_capture_rejects_candidate_session_file_and_parent_symlinks(tmp_path, monkeypatch):
    capture = import_capture("capture_machine_candidate_reparse")
    real_root = tmp_path / "real-candidate-run"
    real_root.mkdir()
    real_session = real_root / "phase5-fault-session-attestation.json"
    real_session.write_bytes(acceptance.canonical(fault_session()))

    linked_session_root = tmp_path / "linked-session-run"
    linked_session_root.mkdir()
    os.symlink(real_session,
               linked_session_root / "phase5-fault-session-attestation.json")
    monkeypatch.setattr(capture, "CANDIDATE_RUN_ROOT", linked_session_root)
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.load_fault_session_attestation("staging-phase5")

    linked_parent = tmp_path / "linked-parent"
    os.symlink(real_root, linked_parent, target_is_directory=True)
    monkeypatch.setattr(capture, "CANDIDATE_RUN_ROOT", linked_parent)
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.load_fault_session_attestation("staging-phase5")


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=1),
    lambda value: value.update(runId="123e4567-e89b-12d3-a456-426614174000"),
    lambda value: value.update(challenge="f" * 63),
    lambda value: value["release"].update(releaseManifestSha256="f" * 63),
    lambda value: value["release"].update(hidden=True),
    lambda value: value["geometry"].update(blockFrames=2048),
    lambda value: value["geometry"].update(poolSize=True),
    lambda value: value["profile"].update(slowClient=3),
    lambda value: value["profile"].update(durationMinutes=30.0),
    lambda value: value["profile"].update(speciesEndpoint="http://localhost:8081/v1"),
    lambda value: value["signer"].update(algorithm="ed25519"),
    lambda value: value["signer"].update(publicKeySpkiSha256="0" * 64),
    lambda value: value["signer"].update(
        publicKeySpkiDerBase64=base64.b64encode(b"\0" * 44).decode("ascii"),
        publicKeySpkiSha256=hashlib.sha256(b"\0" * 44).hexdigest()),
    lambda value: value["captureProof"].update(captureNonce="0" * 63),
    lambda value: value["captureProof"].update(rawManifestSha256="A" * 64),
    lambda value: value["captureProof"].update(signature="not-base64"),
    lambda value: value["captureProof"].update(hidden=True),
    lambda value: value.update(hidden=True),
])
def test_fault_session_rejects_run_release_profile_spki_and_hidden_attacks(mutation):
    value = fault_session()
    mutation(value)
    with pytest.raises(acceptance.AcceptanceError,
                       match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.fault_session_binding_from_bytes(acceptance.canonical(value))


def test_fault_session_rejects_noncanonical_and_duplicate_json(tmp_path):
    value = fault_session()
    path = tmp_path / "phase5-fault-session-attestation.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(acceptance.AcceptanceError,
                       match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.fault_session_binding_from_bytes(path.read_bytes())

    canonical = acceptance.canonical(value)
    path.write_bytes(
        b'{"challenge":"' + CHALLENGE.encode() + b'",' + canonical[1:])
    with pytest.raises(acceptance.AcceptanceError,
                       match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.fault_session_binding_from_bytes(path.read_bytes())


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=2.0),
    lambda value: value.update(machineIdSha256=1),
    lambda value: value.update(sshHostKeySha256=None),
    lambda value: value["rawEvidence"].update(machineId=float("nan")),
    lambda value: value["environmentEvidence"].update(cudaDriver=False),
])
def test_machine_attestation_version_and_hash_types_fail_closed(mutation):
    value = attestation()
    mutation(value)
    with pytest.raises(acceptance.AcceptanceError,
                       match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation(value)


def test_attestation_evidence_recomputes_session_and_forbids_it_for_production(tmp_path):
    production_path = tmp_path / "production-machine-attestation.json"
    production = attestation()
    production_evidence = write_machine_evidence(production_path, production)
    acceptance.validate_attestation_evidence_integrity(
        production_path, production)
    (production_evidence / "fault-session-attestation.json").write_bytes(
        acceptance.canonical(fault_session()))
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(
            production_path, production)

    staging_path = tmp_path / "staging-machine-attestation.json"
    session = fault_session()
    staging = staging_attestation(run_binding=session_binding(session))
    staging_evidence = write_machine_evidence(staging_path, staging, session)
    acceptance.validate_attestation_evidence_integrity(
        staging_path, staging)

    tampered = copy.deepcopy(session)
    tampered["challenge"] = "f" * 64
    (staging_evidence / "fault-session-attestation.json").write_bytes(
        acceptance.canonical(tampered))
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(
            staging_path, staging)


def test_synchronized_valid_session_rebind_requires_composite_trust_root(tmp_path):
    staging_path = tmp_path / "staging-machine-attestation.json"
    session = fault_session()
    expected_run_binding = session_binding(session)
    staging = staging_attestation(run_binding=expected_run_binding)
    staging_evidence = write_machine_evidence(staging_path, staging, session)
    assert acceptance.validate_staging_attestation_composite_evidence(
        staging_path, staging, expected_run_binding) == expected_run_binding

    rebound = fault_session()
    rebound["runId"] = "ffffffff-ffff-4fff-afff-ffffffffffff"
    rebound["challenge"] = "f" * 64
    rebound["release"] = {
        "releaseManifestSha256": "6" * 64,
        "releaseRevision": "7" * 40,
        "sourceManifestSha256": "8" * 64,
        "audioArtifactSha256": "9" * 64,
    }
    rebound_binding = session_binding(rebound)
    staging["runBinding"] = rebound_binding
    (staging_evidence / "fault-session-attestation.json").write_bytes(
        acceptance.canonical(rebound))
    staging_path.write_bytes(acceptance.canonical(staging))
    assert acceptance.validate_attestation_evidence_integrity(
        staging_path, staging) == rebound_binding
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_staging_attestation_composite_evidence(
            staging_path, staging, expected_run_binding)


def test_machine_attestation_evidence_requires_exact_role_inventory(tmp_path):
    production_path = tmp_path / "production-machine-attestation.json"
    production = attestation()
    production_evidence = write_machine_evidence(production_path, production)
    (production_evidence / "unexpected.bin").write_bytes(b"unexpected")
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(
            production_path, production)
    (production_evidence / "unexpected.bin").unlink()
    (production_evidence / "stolen-fault-session.json").write_bytes(
        acceptance.canonical(fault_session()))
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(
            production_path, production)

    staging_path = tmp_path / "staging-machine-attestation.json"
    session = fault_session()
    staging = staging_attestation(run_binding=session_binding(session))
    staging_evidence = write_machine_evidence(staging_path, staging, session)
    (staging_evidence / "fault-session-attestation.json").unlink()
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(
            staging_path, staging)
    (staging_evidence / "fault-session-attestation.json").write_bytes(
        acceptance.canonical(session))
    (staging_evidence / "unexpected.bin").write_bytes(b"unexpected")
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(
            staging_path, staging)


@pytest.mark.parametrize("name", COMMON_EVIDENCE_FILES)
def test_machine_attestation_rejects_each_raw_evidence_symlink(tmp_path, name):
    path = tmp_path / "production-machine-attestation.json"
    value = attestation()
    evidence = write_machine_evidence(path, value)
    raw_path = evidence / name
    external = tmp_path / f"external-{name.replace('.', '-')}"
    raw_path.replace(external)
    os.symlink(external, raw_path)
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(path, value)


def test_machine_attestation_rejects_attestation_directory_and_parent_symlinks(tmp_path):
    path = tmp_path / "production-machine-attestation.json"
    value = attestation()
    evidence = write_machine_evidence(path, value)

    actual_attestation = tmp_path / "actual-machine-attestation.json"
    path.replace(actual_attestation)
    os.symlink(actual_attestation, path)
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(path, value)
    path.unlink()
    actual_attestation.replace(path)

    actual_evidence = tmp_path / "actual-machine-evidence"
    evidence.replace(actual_evidence)
    os.symlink(actual_evidence, evidence, target_is_directory=True)
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(path, value)
    evidence.unlink()
    actual_evidence.replace(evidence)

    real_parent = tmp_path / "real-parent"
    real_parent.mkdir()
    parent_path = real_parent / "production-machine-attestation.json"
    parent_value = attestation()
    write_machine_evidence(parent_path, parent_value)
    linked_parent = tmp_path / "linked-parent"
    os.symlink(real_parent, linked_parent, target_is_directory=True)
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence_integrity(
            linked_parent / parent_path.name, parent_value)


@linux_release_security
def test_capture_missing_privileged_host_key_fails(tmp_path):
    capture = import_capture("capture_machine_missing")
    normal = tmp_path / "normal"; burst = tmp_path / "burst"
    normal.write_text("{}"); burst.write_text("{}")
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.capture(tmp_path / "out.json", normal, burst,
                        machine_id_path=tmp_path / "machine-id",
                        ssh_key_path=tmp_path / "missing-host-key")


@linux_release_security
def test_capture_derives_identity_and_writes_hash_bound_raw_evidence(tmp_path, monkeypatch):
    capture = import_capture("capture_machine_positive")
    monkeypatch.setattr(capture.sys, "platform", "linux")
    monkeypatch.setattr(capture.platform, "machine", lambda: "aarch64")
    key_blob = b"real-key-material"
    files = {"machine": b"machine-one\n",
             "key": b"ssh-ed25519 " + base64.b64encode(key_blob) + b" host\n",
             "normal": b'[{"atMs":0,"latencyMs":1,"ok":true}]',
             "burst": b'[{"atMs":0,"latencyMs":2,"ok":true}]',
             "memory": b"MemTotal: 125829120 kB\nMemAvailable: 1234 kB\n"}
    paths = {}
    for name, body in files.items():
        paths[name] = tmp_path / name; paths[name].write_bytes(body)
    interfaces = json.dumps([{"addr_info": [{"local": "127.0.0.1"},
        {"local": "192.168.9.141"}, {"local": "fe80::1"}]}]).encode()
    outputs = iter([interfaces, b"GPU-z\n", b"driver, NVIDIA GB10, 100\n",
                    b'{"available":true,"version":"2","cuda":"13"}\n'])
    monkeypatch.setattr(capture, "command_bytes", lambda _args: next(outputs))
    output = tmp_path / "staging-machine-attestation.json"
    stale = output.with_suffix(".evidence"); stale.mkdir()
    (stale / ".capture-transaction.json").write_bytes(capture.canonical({
        "schemaVersion": 1, "output": output.name}))
    (stale / "partial").write_text("interrupted")
    session = fault_session()
    candidate_root = tmp_path / "candidate-run"
    candidate_root.mkdir()
    monkeypatch.setattr(capture, "CANDIDATE_RUN_ROOT", candidate_root)
    session_path = candidate_root / "phase5-fault-session-attestation.json"
    session_path.write_bytes(acceptance.canonical(session))
    value = capture.capture(output, paths["normal"], paths["burst"], paths["machine"],
                            paths["key"], paths["memory"],
                            attestation_role="staging-phase5")
    assert value["schemaVersion"] == 2
    assert value["attestationRole"] == "staging-phase5"
    assert value["runBinding"] == session_binding(session)
    assert value["canonicalInterfaceAddresses"] == ["192.168.9.141"]
    assert value["gpuUuids"] == ["GPU-z"]
    assert value["platform"]["totalMemoryBytes"] == 120 * GIB
    assert value["platform"]["memoryClassBytes"] == 128 * GIB
    acceptance.validate_staging_attestation_composite_evidence(
        output, value, session_binding(session))
    (output.with_suffix(".evidence") / "interfaces.json").write_bytes(b"[]")
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_staging_attestation_composite_evidence(
            output, value, session_binding(session))
