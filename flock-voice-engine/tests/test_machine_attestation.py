from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import inspect
import json
import math
import multiprocessing
import os
from pathlib import Path
import stat
import sys

import pytest

from linux_release_security import linux_release_security

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
spec = importlib.util.spec_from_file_location("phase5_acceptance_machine", VALIDATOR)
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
SPECIES_FIXTURE = (
    ROOT / "flock-voice-engine/tests/test_phase5_species_load_samples.py"
)
species_spec = importlib.util.spec_from_file_location(
    "phase5_species_fixture_for_machine_attestation",
    SPECIES_FIXTURE,
)
species_fixture = importlib.util.module_from_spec(species_spec)
species_spec.loader.exec_module(species_fixture)

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
WINDOW = {
    "startedAtMonotonicMs": 1_000,
    "endedAtMonotonicMs": 1_801_000,
    "startedAtUnixMs": 1_700_000_000_000,
    "endedAtUnixMs": 1_700_001_800_000,
}
STAGING_OUTPUT_NAME = "staging-machine-attestation.json"
STAGING_EVIDENCE_NAME = "staging-machine-attestation.evidence"
STAGING_MARKER_NAME = (
    ".staging-machine-attestation.capture-transaction.json"
)
STAGING_TEMP_NAME = ".staging-machine-attestation.evidence.partial"
STAGING_QUARANTINE_NAME = (
    ".staging-machine-attestation.evidence.quarantine"
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


def staging_capture_inputs():
    session = fault_session()
    raw_binding = {
        name: copy.deepcopy(session[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    profile_values = {}
    for mode in ("normal", "burst"):
        value, _fixture_binding = species_fixture.valid_species_samples(mode)
        for name, item in raw_binding.items():
            value[name] = copy.deepcopy(item)
        profile_values[mode] = value
    normal_raw = acceptance.canonical(profile_values["normal"])
    burst_raw = acceptance.canonical(profile_values["burst"])
    blobs = {
        artifact: acceptance.canonical({
            "artifact": artifact,
            "ordinal": index,
        })
        for index, (artifact, _path) in enumerate(
            acceptance.PHASE5_RAW_ARTIFACTS,
            start=1,
        )
    }
    blobs["speciesNormalSamplesSha256"] = normal_raw
    blobs["speciesBurstSamplesSha256"] = burst_raw
    manifest = acceptance.phase5_raw_manifest_from_blobs(
        raw_binding,
        WINDOW,
        blobs,
    )
    manifest_raw = acceptance.canonical(manifest)
    manifest_sha256 = hashlib.sha256(manifest_raw).hexdigest()
    session["captureProof"]["rawManifestSha256"] = manifest_sha256
    session_raw = acceptance.canonical(session)
    full_binding = session_binding(session)
    return {
        "capture_intent_sha256": "c" * 64,
        "session_raw": session_raw,
        "expected_full_run_binding": full_binding,
        "normal_profile_raw": normal_raw,
        "burst_profile_raw": burst_raw,
        "raw_manifest_bundle": {
            "manifest": manifest,
            "manifestRaw": manifest_raw,
            "manifestSha256": manifest_sha256,
            "blobs": blobs,
        },
    }


def fixed_staging_host_evidence():
    key_blob = b"staging-host-key-material"
    return {
        "machine-id": b"staging-machine\n",
        "ssh-host-ed25519.pub":
            b"ssh-ed25519 " + base64.b64encode(key_blob) + b" host\n",
        "interfaces.json": json.dumps([{
            "addr_info": [
                {"local": "127.0.0.1"},
                {"local": "192.168.9.141"},
            ],
        }]).encode(),
        "gpus.txt": b"GPU-staging\n",
        "cuda-driver.txt": b"580.159.03, NVIDIA GB10, 100\n",
        "torch.json": b'{"available":true,"version":"2","cuda":"13"}\n',
        "available-memory.txt":
            b"MemTotal: 125829120 kB\nMemAvailable: 1234 kB\n",
        "architecture.txt": b"aarch64\n",
    }


def staging_transaction_marker_raw(root, inputs):
    root_state = os.stat(root, follow_symlinks=False)
    return acceptance.canonical({
        "schemaVersion": 1,
        "kind": "staging-machine-attestation-capture-transaction",
        "captureIntentSha256": inputs["capture_intent_sha256"],
        "sessionSha256": hashlib.sha256(
            inputs["session_raw"]
        ).hexdigest(),
        "releaseRoot": {
            "device": root_state.st_dev,
            "inode": root_state.st_ino,
        },
    })


def write_staging_transaction_marker(root, inputs):
    marker = root / STAGING_MARKER_NAME
    marker.write_bytes(staging_transaction_marker_raw(root, inputs))
    marker.chmod(0o400)
    return marker


def exact_tree_snapshot(root):
    result = {}

    def visit(directory):
        with os.scandir(directory) as entries:
            for entry in sorted(entries, key=lambda item: item.name):
                path = Path(entry.path)
                relative = path.relative_to(root).as_posix()
                state = entry.stat(follow_symlinks=False)
                payload = None
                if entry.is_symlink():
                    payload = os.readlink(path)
                elif entry.is_file(follow_symlinks=False):
                    payload = path.read_bytes()
                result[relative] = (
                    state.st_dev,
                    state.st_ino,
                    stat.S_IFMT(state.st_mode),
                    stat.S_IMODE(state.st_mode),
                    state.st_uid,
                    state.st_gid,
                    state.st_nlink,
                    state.st_mtime_ns,
                    state.st_ctime_ns,
                    payload,
                )
                if entry.is_dir(follow_symlinks=False):
                    visit(path)

    visit(root)
    return result


def exact_node_snapshot(path):
    state = os.stat(path, follow_symlinks=False)
    if stat.S_ISLNK(state.st_mode):
        payload = ("symlink", os.readlink(path))
    elif stat.S_ISREG(state.st_mode):
        payload = ("file", Path(path).read_bytes())
    elif stat.S_ISDIR(state.st_mode):
        payload = ("directory", exact_tree_snapshot(Path(path)))
    else:
        payload = ("other", None)
    return (
        state.st_dev,
        state.st_ino,
        stat.S_IFMT(state.st_mode),
        stat.S_IMODE(state.st_mode),
        state.st_uid,
        state.st_gid,
        state.st_nlink,
        state.st_size,
        state.st_mtime_ns,
        state.st_ctime_ns,
        payload,
    )


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


def test_staging_capture_public_surface_is_controller_owned():
    capture = import_capture("capture_machine_controller_surface")

    assert not hasattr(capture, "CANDIDATE_RUN_ROOT")
    assert not hasattr(capture, "load_fault_session_attestation")
    assert tuple(inspect.signature(
        capture.capture_staging_machine_attestation
    ).parameters) == (
        "held_release_root",
        "capture_intent_sha256",
        "session_raw",
        "expected_full_run_binding",
        "normal_profile_raw",
        "burst_profile_raw",
        "raw_manifest_bundle",
    )
    generic_parameters = inspect.signature(capture.capture).parameters
    assert tuple(generic_parameters) == (
        "output",
        "normal_profile",
        "burst_profile",
    )
    signature = inspect.signature(
        capture.capture_staging_machine_attestation
    )
    assert signature.parameters["held_release_root"].kind is (
        inspect.Parameter.POSITIONAL_OR_KEYWORD
    )
    assert all(
        signature.parameters[name].kind is inspect.Parameter.KEYWORD_ONLY
        for name in tuple(signature.parameters)[1:]
    )


@pytest.mark.parametrize("removed", [
    ["--attestation-role", "staging-phase5"],
    ["--fault-session-attestation", "session.json"],
    ["--attest", "production-baseline"],
    ["--out", "output.json"],
    ["--vllm-normal-prof", "normal.json"],
])
def test_machine_capture_cli_is_production_only_without_abbreviations(
        tmp_path, monkeypatch, removed):
    capture = import_capture(
        "capture_machine_production_cli_"
        + removed[0].replace("-", "_")
    )
    argv = [
        "capture-machine-attestation",
        "--output", str(tmp_path / "output.json"),
        "--vllm-normal-profile", str(tmp_path / "normal.json"),
        "--vllm-burst-profile", str(tmp_path / "burst.json"),
        *removed,
    ]
    monkeypatch.setattr(sys, "argv", argv)
    monkeypatch.setattr(
        capture,
        "capture",
        lambda *_args, **_kwargs: pytest.fail(
            "removed CLI input reached production capture"
        ),
    )
    with pytest.raises(SystemExit) as exc:
        capture.main()
    assert exc.value.code == 2


def test_machine_capture_cli_calls_only_fixed_production_boundary(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_production_cli_valid")
    output = tmp_path / "output.json"
    normal = tmp_path / "normal.json"
    burst = tmp_path / "burst.json"
    calls = []
    monkeypatch.setattr(
        capture,
        "capture",
        lambda *args, **kwargs: calls.append((args, kwargs)) or {},
    )
    monkeypatch.setattr(sys, "argv", [
        "capture-machine-attestation",
        "--output", str(output),
        "--vllm-normal-profile", str(normal),
        "--vllm-burst-profile", str(burst),
    ])

    assert capture.main() == 0
    assert calls == [(
        (output.resolve(), normal.resolve(), burst.resolve()),
        {},
    )]


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


def _linux_staging_input_mismatch_fails_before_host_capture_or_marker(
        tmp_path, monkeypatch, mutation):
    capture = import_capture("capture_machine_preflight_" + mutation)
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    if mutation == "capture-intent":
        inputs["capture_intent_sha256"] = "C" * 64
    elif mutation == "session-raw":
        inputs["session_raw"] = json.dumps(
            json.loads(inputs["session_raw"])
        ).encode()
    elif mutation == "full9-hidden":
        inputs["expected_full_run_binding"]["hidden"] = True
    elif mutation == "full9-type":
        inputs["expected_full_run_binding"]["captureNonce"] = True
    elif mutation == "external-binding":
        inputs["expected_full_run_binding"]["challenge"] = "f" * 64
    elif mutation == "session-digest":
        inputs["expected_full_run_binding"][
            "faultSessionEvidenceSha256"
        ] = "f" * 64
    elif mutation == "manifest-sha":
        inputs["raw_manifest_bundle"]["manifestSha256"] = "f" * 64
    elif mutation == "manifest-raw":
        inputs["raw_manifest_bundle"]["manifestRaw"] += b"\n"
    elif mutation == "manifest-declaration":
        inputs["raw_manifest_bundle"]["manifest"] = copy.deepcopy(
            inputs["raw_manifest_bundle"]["manifest"]
        )
        inputs["raw_manifest_bundle"]["manifest"]["kind"] = "wrong"
    elif mutation == "bundle-missing":
        del inputs["raw_manifest_bundle"]["manifest"]
    elif mutation == "bundle-extra":
        inputs["raw_manifest_bundle"]["hidden"] = True
    elif mutation == "blob-missing":
        inputs["raw_manifest_bundle"]["blobs"] = dict(
            inputs["raw_manifest_bundle"]["blobs"]
        )
        del inputs["raw_manifest_bundle"]["blobs"]["faultEventsSha256"]
    elif mutation == "blob-extra":
        inputs["raw_manifest_bundle"]["blobs"] = dict(
            inputs["raw_manifest_bundle"]["blobs"]
        )
        inputs["raw_manifest_bundle"]["blobs"]["hidden"] = b"hidden"
    elif mutation == "manifest-blob":
        inputs["raw_manifest_bundle"]["blobs"] = dict(
            inputs["raw_manifest_bundle"]["blobs"]
        )
        inputs["raw_manifest_bundle"]["blobs"][
            "faultEventsSha256"
        ] = b"changed"
    elif mutation == "normal-profile":
        inputs["normal_profile_raw"] += b"\n"
    elif mutation == "burst-profile":
        inputs["burst_profile_raw"] += b"\n"
    else:
        invalid_normal = json.loads(inputs["normal_profile_raw"])
        invalid_normal["kind"] = "wrong"
        invalid_normal_raw = acceptance.canonical(invalid_normal)
        bundle = inputs["raw_manifest_bundle"]
        rebound_blobs = dict(bundle["blobs"])
        rebound_blobs["speciesNormalSamplesSha256"] = invalid_normal_raw
        binding = {
            name: copy.deepcopy(
                inputs["expected_full_run_binding"][name]
            )
            for name in (
                "runId", "challenge", "release", "geometry", "profile"
            )
        }
        rebound_manifest = acceptance.phase5_raw_manifest_from_blobs(
            binding,
            bundle["manifest"]["window"],
            rebound_blobs,
        )
        rebound_manifest_raw = acceptance.canonical(rebound_manifest)
        rebound_manifest_sha = hashlib.sha256(
            rebound_manifest_raw
        ).hexdigest()
        rebound_session = json.loads(inputs["session_raw"])
        rebound_session["captureProof"]["rawManifestSha256"] = (
            rebound_manifest_sha
        )
        inputs.update(
            session_raw=acceptance.canonical(rebound_session),
            expected_full_run_binding=session_binding(rebound_session),
            normal_profile_raw=invalid_normal_raw,
            raw_manifest_bundle={
                "manifest": rebound_manifest,
                "manifestRaw": rebound_manifest_raw,
                "manifestSha256": rebound_manifest_sha,
                "blobs": rebound_blobs,
            },
        )
    host_calls = []
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: host_calls.append(True) or fixed_staging_host_evidence(),
    )

    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert host_calls == []
    assert os.listdir(root) == []


def _linux_staging_rejects_noncapability_release_root(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_noncapability_root")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    raw_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)

    class DuckHeldRoot:
        _HeldReleaseRoot__closed = False

    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("non-capability root reached host capture"),
    )
    try:
        for fake in (root, raw_fd, int(raw_fd), DuckHeldRoot()):
            with pytest.raises(
                    capture.CaptureError,
                    match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
                capture.capture_staging_machine_attestation(
                    fake,
                    **staging_capture_inputs(),
                )
    finally:
        os.close(raw_fd)
    assert os.listdir(root) == []


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
def test_capture_missing_privileged_host_key_fails(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_missing")
    normal = tmp_path / "normal"; burst = tmp_path / "burst"
    normal.write_bytes(b'[{"atMs":0,"latencyMs":1,"ok":true}]')
    burst.write_bytes(b'[{"atMs":0,"latencyMs":2,"ok":true}]')
    monkeypatch.setattr(
        capture,
        "_capture_fixed_production_host_evidence",
        lambda: (_ for _ in ()).throw(
            capture.CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        ),
    )
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.capture(tmp_path / "failed.json", normal, burst)

    monkeypatch.setattr(
        capture,
        "_capture_fixed_production_host_evidence",
        fixed_staging_host_evidence,
    )
    output = tmp_path / "production-machine-attestation.json"
    value = capture.capture(output, normal, burst)
    assert value["attestationRole"] == "production-baseline"
    assert value["runBinding"] is None
    assert value["hostname"]
    assert sorted(os.listdir(output.with_suffix(".evidence"))) == sorted(
        COMMON_EVIDENCE_FILES
    )
    acceptance.validate_attestation_evidence_integrity(output, value)


def _linux_staging_capture_fresh_publication_is_fixed_durable_and_immutable(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_staging_fresh")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    sentinel = root / "release-sentinel.txt"
    sentinel.write_bytes(b"unrelated-release-byte")
    inputs = staging_capture_inputs()
    mutable_binding = inputs["expected_full_run_binding"]
    mutable_bundle = inputs["raw_manifest_bundle"]
    host_source = fixed_staging_host_evidence()

    def capture_host():
        mutable_binding["release"]["releaseRevision"] = "f" * 40
        mutable_bundle["manifest"]["release"][
            "releaseRevision"
        ] = "f" * 40
        mutable_bundle["blobs"]["faultEventsSha256"] = b"rebound"
        return host_source

    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        capture_host,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        snapshot = capture.capture_staging_machine_attestation(
            held,
            **inputs,
        )

    evidence = root / STAGING_EVIDENCE_NAME
    output = root / STAGING_OUTPUT_NAME
    assert sorted(os.listdir(root)) == [
        "release-sentinel.txt",
        STAGING_EVIDENCE_NAME,
        STAGING_OUTPUT_NAME,
    ]
    assert sentinel.read_bytes() == b"unrelated-release-byte"
    assert stat.S_IMODE(os.stat(evidence).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(output).st_mode) == 0o400
    assert sorted(os.listdir(evidence)) == sorted(
        (*COMMON_EVIDENCE_FILES, "fault-session-attestation.json")
    )
    assert all(
        stat.S_IMODE(os.stat(evidence / name).st_mode) == 0o400
        for name in os.listdir(evidence)
    )
    assert (
        evidence / "fault-session-attestation.json"
    ).read_bytes() == inputs["session_raw"]
    assert (
        evidence / "vllm-normal-profile.json"
    ).read_bytes() == inputs["normal_profile_raw"]
    assert (
        evidence / "vllm-burst-profile.json"
    ).read_bytes() == inputs["burst_profile_raw"]

    output_raw = output.read_bytes()
    value = json.loads(output_raw)
    assert output_raw == acceptance.canonical(value)
    assert value["attestationRole"] == "staging-phase5"
    assert value["runBinding"]["challenge"] == CHALLENGE
    assert value["runBinding"]["release"] == RELEASE
    assert "hostname" not in value
    assert type(snapshot.output_raw) is bytes
    assert type(snapshot.evidence_blobs) is tuple
    assert type(snapshot.evidence_inventory) is tuple
    assert all(
        type(name) is str and type(body) is bytes
        for name, body in snapshot.evidence_blobs
    )
    assert all(
        type(item) is tuple
        and type(item[0]) is str
        and type(item[1]) is str
        for item in snapshot.evidence_inventory
    )
    assert snapshot.output_raw == output_raw
    assert snapshot.output_sha256 == hashlib.sha256(output_raw).hexdigest()
    assert tuple(name for name, _body in snapshot.evidence_blobs) == tuple(
        sorted((*COMMON_EVIDENCE_FILES, "fault-session-attestation.json"))
    )
    assert snapshot.evidence_inventory == tuple(
        (name, hashlib.sha256(body).hexdigest())
        for name, body in snapshot.evidence_blobs
    )
    assert snapshot.evidence_inventory_sha256 == hashlib.sha256(
        acceptance.canonical([
            {"name": name, "sha256": sha256}
            for name, sha256 in snapshot.evidence_inventory
        ])
    ).hexdigest()
    assert all(
        hasattr(snapshot, name)
        for name in (
            "output_raw",
            "output_sha256",
            "evidence_blobs",
            "evidence_inventory",
            "evidence_inventory_sha256",
        )
    )
    assert all(
        not hasattr(snapshot, name)
        for name in ("path", "fd", "callback", "runner", "hostname")
    )
    declared_public_fields = set(
        getattr(type(snapshot), "_fields", ())
    )
    for candidate in type(snapshot).__mro__:
        slots = getattr(candidate, "__slots__", ())
        if isinstance(slots, str):
            slots = (slots,)
        declared_public_fields.update(
            name for name in slots
            if not name.startswith("_")
        )
        declared_public_fields.update(
            name
            for name in getattr(candidate, "__annotations__", ())
            if not name.startswith("_")
        )
        declared_public_fields.update(
            name
            for name, descriptor in vars(candidate).items()
            if (
                not name.startswith("_")
                and isinstance(descriptor, property)
            )
        )
    if hasattr(snapshot, "__dict__"):
        declared_public_fields.update(
            name for name in vars(snapshot)
            if not name.startswith("_")
        )
    assert {
        "output_raw",
        "output_sha256",
        "evidence_blobs",
        "evidence_inventory",
        "evidence_inventory_sha256",
    }.issubset(declared_public_fields)

    def assert_safe_immutable(value):
        assert not isinstance(value, os.PathLike)
        assert not callable(value)
        assert (
            value is None
            or type(value) in {
                bool,
                int,
                float,
                str,
                bytes,
                tuple,
                frozenset,
            }
        )
        if type(value) is float:
            assert math.isfinite(value)
        if type(value) in {tuple, frozenset}:
            for item in value:
                assert_safe_immutable(item)

    for name in declared_public_fields:
        lowered = name.casefold()
        assert all(
            banned not in lowered
            for banned in (
                "path",
                "fd",
                "descriptor",
                "handle",
                "callback",
                "runner",
                "hostname",
                "host_name",
            )
        )
        assert_safe_immutable(getattr(snapshot, name))
    with pytest.raises(AttributeError):
        snapshot.output_raw = b"changed"
    host_source["machine-id"] = b"changed"
    assert dict(snapshot.evidence_blobs)["machine-id"] == b"staging-machine\n"


def _linux_fresh_publication_fsync_rename_output_order(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_publication_order")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    events = []
    real_write = capture._write_exclusive_file_at
    real_rename = capture._rename_noreplace
    real_fsync = capture.os.fsync
    real_composite = capture._validate_owned_staging_composite

    def write(directory_fd, name, body, mode=0o400):
        result = real_write(directory_fd, name, body, mode)
        events.append("write:" + name)
        return result

    def rename(source_fd, source_name, destination_fd, destination_name):
        result = real_rename(
            source_fd,
            source_name,
            destination_fd,
            destination_name,
        )
        events.append(f"rename:{source_name}:{destination_name}")
        return result

    def fsync(fd):
        result = real_fsync(fd)
        try:
            linked = os.readlink(f"/proc/self/fd/{fd}")
        except OSError:
            linked = "<unknown>"
        if linked == str(root):
            events.append(
                "root-fsync:"
                + (
                    "marker-present"
                    if (root / STAGING_MARKER_NAME).exists()
                    else "marker-absent"
                )
            )
        else:
            events.append("fsync:" + linked)
        return result

    def composite(*args, **kwargs):
        events.append("composite")
        return real_composite(*args, **kwargs)

    monkeypatch.setattr(capture, "_write_exclusive_file_at", write)
    monkeypatch.setattr(capture, "_rename_noreplace", rename)
    monkeypatch.setattr(capture.os, "fsync", fsync)
    monkeypatch.setattr(
        capture,
        "_validate_owned_staging_composite",
        composite,
    )
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(
            held,
            **staging_capture_inputs(),
        )

    marker_write = events.index("write:" + STAGING_MARKER_NAME)
    evidence_writes = [
        events.index("write:" + name)
        for name in (*COMMON_EVIDENCE_FILES,
                     "fault-session-attestation.json")
    ]
    evidence_rename = events.index(
        f"rename:{STAGING_TEMP_NAME}:{STAGING_EVIDENCE_NAME}"
    )
    output_write = events.index("write:" + STAGING_OUTPUT_NAME)
    composite = events.index("composite")
    root_fsyncs_with_marker = [
        index for index, event in enumerate(events)
        if event == "root-fsync:marker-present"
    ]
    root_fsyncs_without_marker = [
        index for index, event in enumerate(events)
        if event == "root-fsync:marker-absent"
    ]
    temp_fsync = next(
        index for index, event in enumerate(events)
        if event == "fsync:" + str(root / STAGING_TEMP_NAME)
    )

    assert events.index(
        "fsync:" + str(root / STAGING_MARKER_NAME)
    ) < marker_write
    for name, write_index in zip(
            (*COMMON_EVIDENCE_FILES,
             "fault-session-attestation.json"),
            evidence_writes,
            strict=True):
        assert events.index(
            "fsync:" + str(root / STAGING_TEMP_NAME / name)
        ) < write_index
    assert events.index(
        "fsync:" + str(root / STAGING_OUTPUT_NAME)
    ) < output_write
    assert any(
        marker_write < index < min(evidence_writes)
        for index in root_fsyncs_with_marker
    )
    assert max(evidence_writes) < temp_fsync < evidence_rename
    assert any(
        evidence_rename < index < output_write
        for index in root_fsyncs_with_marker
    )
    assert any(
        output_write < index < composite
        for index in root_fsyncs_with_marker
    )
    assert any(
        index > composite
        for index in root_fsyncs_without_marker
    )


def _linux_staging_evidence_only_rebuilds_byte_identical_output_without_host(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_evidence_only")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        first = capture.capture_staging_machine_attestation(held, **inputs)

    output = root / STAGING_OUTPUT_NAME
    output.unlink()
    write_staging_transaction_marker(root, inputs)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("evidence-only recovery recaptured host state"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        recovered = capture.capture_staging_machine_attestation(
            held,
            **inputs,
        )

    assert recovered == first
    assert output.read_bytes() == first.output_raw
    assert not (root / STAGING_MARKER_NAME).exists()


def _linux_evidence_only_requires_verified_marker(
        tmp_path, monkeypatch, marker_state):
    capture = import_capture(
        "capture_machine_evidence_only_marker_" + marker_state
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)
    (root / STAGING_OUTPUT_NAME).unlink()
    if marker_state == "wrong":
        marker = root / STAGING_MARKER_NAME
        marker.write_bytes(b"wrong")
        marker.chmod(0o400)
    before = exact_tree_snapshot(root)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("invalid evidence-only state recaptured host"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)
    assert exact_tree_snapshot(root) == before


def _linux_completed_leftover_marker_is_verified_then_removed(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_completed_leftover_marker")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        first = capture.capture_staging_machine_attestation(held, **inputs)
    write_staging_transaction_marker(root, inputs)
    before = {
        name: value
        for name, value in exact_tree_snapshot(root).items()
        if name != STAGING_MARKER_NAME
    }
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("completed state recaptured host"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        second = capture.capture_staging_machine_attestation(held, **inputs)
    assert second == first
    assert not (root / STAGING_MARKER_NAME).exists()
    assert exact_tree_snapshot(root) == before


def _linux_evidence_only_composite_failure_keeps_poison(
        tmp_path, monkeypatch):
    capture = import_capture(
        "capture_machine_evidence_only_composite_failure"
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)
    (root / STAGING_OUTPUT_NAME).unlink()
    write_staging_transaction_marker(root, inputs)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("evidence-only recovery recaptured host"),
    )
    monkeypatch.setattr(
        capture,
        "_validate_owned_staging_composite",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            capture.CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        ),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)
    assert (root / STAGING_EVIDENCE_NAME).is_dir()
    assert (root / STAGING_OUTPUT_NAME).is_file()
    assert (root / STAGING_MARKER_NAME).is_file()


def _linux_staging_completed_capture_is_write_free_idempotent(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_idempotent")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        first = capture.capture_staging_machine_attestation(held, **inputs)
    paths = [
        root / STAGING_OUTPUT_NAME,
        root / STAGING_EVIDENCE_NAME,
        *[
            root / STAGING_EVIDENCE_NAME / name
            for name in os.listdir(root / STAGING_EVIDENCE_NAME)
        ],
    ]
    states = {
        path: (os.stat(path).st_dev, os.stat(path).st_ino,
               os.stat(path).st_mtime_ns, os.stat(path).st_ctime_ns)
        for path in paths
    }
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("completed capture recaptured host state"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        second = capture.capture_staging_machine_attestation(held, **inputs)

    assert second == first
    assert states == {
        path: (os.stat(path).st_dev, os.stat(path).st_ino,
               os.stat(path).st_mtime_ns, os.stat(path).st_ctime_ns)
        for path in paths
    }


def _linux_staging_output_only_is_impossible_and_left_untouched(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_output_only")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    output = root / STAGING_OUTPUT_NAME
    output.write_bytes(b"poison")
    output.chmod(0o400)
    before = (os.stat(output).st_ino, output.read_bytes())
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("output-only state reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(
                held,
                **staging_capture_inputs(),
            )

    assert (os.stat(output).st_ino, output.read_bytes()) == before
    assert sorted(os.listdir(root)) == [STAGING_OUTPUT_NAME]


def _linux_owned_composite_runs_after_output_fsync_and_failure_keeps_poison(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_composite_order")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    fsynced_paths = []
    real_fsync = capture.os.fsync

    def tracked_fsync(fd):
        try:
            fsynced_paths.append(os.readlink(f"/proc/self/fd/{fd}"))
        except OSError:
            fsynced_paths.append("<unknown>")
        return real_fsync(fd)

    monkeypatch.setattr(capture.os, "fsync", tracked_fsync)

    def reject_composite(*_args, **_kwargs):
        output = root / STAGING_OUTPUT_NAME
        assert output.exists()
        assert stat.S_IMODE(os.stat(output).st_mode) == 0o400
        assert any(
            path.endswith("/" + STAGING_OUTPUT_NAME)
            for path in fsynced_paths
        )
        raise capture.CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")

    monkeypatch.setattr(
        capture,
        "_validate_owned_staging_composite",
        reject_composite,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert (root / STAGING_EVIDENCE_NAME).is_dir()
    assert (root / STAGING_OUTPUT_NAME).is_file()
    assert (root / STAGING_MARKER_NAME).is_file()


def _linux_each_verified_private_partial_state_is_recovered(
        tmp_path, monkeypatch, partial_count):
    capture = import_capture(
        f"capture_machine_partial_recovery_{partial_count}"
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    write_staging_transaction_marker(root, inputs)
    names = sorted((*COMMON_EVIDENCE_FILES,
                    "fault-session-attestation.json"))
    if partial_count >= 0:
        partial = root / STAGING_TEMP_NAME
        partial.mkdir(mode=0o700)
        for name in names[:partial_count]:
            path = partial / name
            path.write_bytes(b"interrupted")
            path.chmod(0o400)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )

    with capture._open_staging_release_root(root.resolve()) as held:
        snapshot = capture.capture_staging_machine_attestation(
            held,
            **inputs,
        )

    assert snapshot.output_raw == (root / STAGING_OUTPUT_NAME).read_bytes()
    assert sorted(os.listdir(root)) == [
        STAGING_EVIDENCE_NAME,
        STAGING_OUTPUT_NAME,
    ]
    assert not (root / STAGING_TEMP_NAME).exists()
    assert not (root / STAGING_QUARANTINE_NAME).exists()
    assert not (root / STAGING_MARKER_NAME).exists()


def _linux_interrupted_quarantine_deletion_is_recovered(
        tmp_path, monkeypatch, remaining_count):
    capture = import_capture(
        f"capture_machine_quarantine_recovery_{remaining_count}"
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    write_staging_transaction_marker(root, inputs)
    quarantine = root / STAGING_QUARANTINE_NAME
    quarantine.mkdir(mode=0o700)
    names = sorted((*COMMON_EVIDENCE_FILES,
                    "fault-session-attestation.json"))
    for name in names[-remaining_count:] if remaining_count else ():
        path = quarantine / name
        path.write_bytes(b"interrupted")
        path.chmod(0o400)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )

    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)

    assert sorted(os.listdir(root)) == [
        STAGING_EVIDENCE_NAME,
        STAGING_OUTPUT_NAME,
    ]


def _linux_private_recovery_is_durable_before_host_capture(
        tmp_path, monkeypatch, private_state):
    capture = import_capture(
        "capture_machine_recovery_durability_" + private_state
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    write_staging_transaction_marker(root, inputs)
    private_name = (
        STAGING_TEMP_NAME
        if private_state == "partial"
        else STAGING_QUARANTINE_NAME
    )
    private = root / private_name
    private.mkdir(mode=0o700)
    leaf = private / "machine-id"
    leaf.write_bytes(b"interrupted")
    leaf.chmod(0o400)
    events = []
    real_fsync = capture.os.fsync
    real_unlink = capture.os.unlink
    real_rmdir = capture.os.rmdir
    real_rename = capture._rename_noreplace

    def tracked_fsync(fd):
        try:
            linked = os.readlink(f"/proc/self/fd/{fd}")
        except OSError:
            linked = "<unknown>"
        if linked == str(root):
            events.append("fsync:root")
        elif linked.endswith("/" + STAGING_QUARANTINE_NAME):
            events.append("fsync:quarantine")
        else:
            events.append("fsync:other")
        return real_fsync(fd)

    def tracked_unlink(name, *args, **kwargs):
        result = real_unlink(name, *args, **kwargs)
        if name == "machine-id":
            events.append("unlink:private-leaf")
        return result

    def tracked_rmdir(name, *args, **kwargs):
        result = real_rmdir(name, *args, **kwargs)
        if name == STAGING_QUARANTINE_NAME:
            events.append("rmdir:quarantine")
        return result

    def tracked_rename(
            source_fd, source_name, destination_fd, destination_name):
        result = real_rename(
            source_fd,
            source_name,
            destination_fd,
            destination_name,
        )
        if (
                source_name == STAGING_TEMP_NAME
                and destination_name == STAGING_QUARANTINE_NAME):
            events.append("rename:temp-to-quarantine")
        return result

    def capture_host():
        events.append("host")
        return fixed_staging_host_evidence()

    monkeypatch.setattr(capture.os, "fsync", tracked_fsync)
    monkeypatch.setattr(capture.os, "unlink", tracked_unlink)
    monkeypatch.setattr(capture.os, "rmdir", tracked_rmdir)
    monkeypatch.setattr(capture, "_rename_noreplace", tracked_rename)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        capture_host,
    )

    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)

    host_index = events.index("host")
    leaf_unlink_index = events.index("unlink:private-leaf")
    quarantine_fsync_index = next(
        index
        for index, event in enumerate(events)
        if (
            index > leaf_unlink_index
            and event == "fsync:quarantine"
        )
    )
    rmdir_index = events.index("rmdir:quarantine")
    root_fsync_after_rmdir = next(
        index
        for index, event in enumerate(events)
        if index > rmdir_index and event == "fsync:root"
    )
    assert (
        leaf_unlink_index
        < quarantine_fsync_index
        < rmdir_index
        < root_fsync_after_rmdir
        < host_index
    )
    if private_state == "partial":
        rename_index = events.index("rename:temp-to-quarantine")
        root_fsync_after_rename = next(
            index
            for index, event in enumerate(events)
            if index > rename_index and event == "fsync:root"
        )
        assert (
            rename_index
            < root_fsync_after_rename
            < leaf_unlink_index
        )


def _linux_nonregular_candidate_fails_without_blocking(
        tmp_path, monkeypatch, candidate):
    capture = import_capture(
        "capture_machine_nonregular_" + candidate
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    public_capture = not candidate.startswith("direct-")
    if candidate in {"final-output", "evidence-leaf"}:
        monkeypatch.setattr(
            capture,
            "_capture_fixed_staging_host_evidence",
            fixed_staging_host_evidence,
        )
        with capture._open_staging_release_root(
                root.resolve()) as held:
            capture.capture_staging_machine_attestation(
                held,
                **inputs,
            )
    if candidate == "marker":
        fifo = root / STAGING_MARKER_NAME
    elif candidate == "final-output":
        fifo = root / STAGING_OUTPUT_NAME
        fifo.unlink()
    elif candidate == "evidence-leaf":
        fifo = root / STAGING_EVIDENCE_NAME / "machine-id"
        fifo.unlink()
    elif candidate in {"partial-leaf", "quarantine-leaf"}:
        write_staging_transaction_marker(root, inputs)
        private = root / (
            STAGING_TEMP_NAME
            if candidate == "partial-leaf"
            else STAGING_QUARANTINE_NAME
        )
        private.mkdir(mode=0o700)
        fifo = private / "machine-id"
    elif candidate == "direct-marker-delete":
        fifo = root / STAGING_MARKER_NAME
    elif candidate == "direct-partial-delete":
        private = root / STAGING_TEMP_NAME
        private.mkdir(mode=0o700)
        fifo = private / "machine-id"
    else:
        raise AssertionError(f"unknown candidate: {candidate}")
    os.mkfifo(fifo, mode=0o400)
    before = exact_tree_snapshot(root)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("nonregular candidate reached host capture"),
    )

    def child_operation():
        try:
            if public_capture:
                with capture._open_staging_release_root(
                        root.resolve()) as held:
                    capture.capture_staging_machine_attestation(
                        held,
                        **inputs,
                    )
            elif candidate == "direct-marker-delete":
                with capture._open_staging_release_root(
                        root.resolve()) as held:
                    root_fd, _state = capture._held_values(held)
                    capture._unlink_verified_file_at(
                        root_fd,
                        STAGING_MARKER_NAME,
                        b"not-a-marker",
                    )
            else:
                directory_fd = os.open(
                    root / STAGING_TEMP_NAME,
                    os.O_RDONLY | os.O_DIRECTORY,
                )
                try:
                    capture._unlink_partial_leaf_at(
                        directory_fd,
                        "machine-id",
                    )
                finally:
                    os.close(directory_fd)
        except capture.CaptureError:
            os._exit(0)
        except BaseException:
            os._exit(2)
        os._exit(3)

    context = multiprocessing.get_context("fork")
    process = context.Process(target=child_operation)
    process.start()
    process.join(timeout=1.0)
    blocked = process.is_alive()
    if blocked:
        process.terminate()
        process.join(timeout=2.0)
    if process.is_alive():
        process.kill()
        process.join(timeout=2.0)

    assert not blocked, f"{candidate} blocked on a nonregular node"
    assert not process.is_alive()
    assert process.exitcode == 0
    assert exact_tree_snapshot(root) == before


def _linux_unknown_or_malformed_private_partial_is_untouched(
        tmp_path, monkeypatch, malformation):
    capture = import_capture(
        "capture_machine_partial_malformed_" + malformation
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    partial = root / STAGING_TEMP_NAME
    if malformation not in {
        "unknown-private-prefix",
        "quarantine-missing-marker",
        "quarantine-extra",
    }:
        partial.mkdir(mode=0o700)
    if malformation not in {
        "missing-marker",
        "unknown-private-prefix",
        "quarantine-missing-marker",
    }:
        marker = write_staging_transaction_marker(root, inputs)
        if malformation == "wrong-marker":
            marker.chmod(0o600)
            marker.write_bytes(b"wrong")
            marker.chmod(0o400)
    if malformation == "extra-leaf":
        path = partial / "unexpected"
        path.write_bytes(b"unexpected")
        path.chmod(0o400)
    elif malformation == "leaf-symlink":
        external = tmp_path / "external"
        external.write_bytes(b"external")
        os.symlink(external, partial / "machine-id")
    elif malformation == "leaf-hardlink":
        external = tmp_path / "external"
        external.write_bytes(b"external")
        external.chmod(0o400)
        os.link(external, partial / "machine-id")
    elif malformation == "wrong-mode":
        path = partial / "machine-id"
        path.write_bytes(b"partial")
        path.chmod(0o600)
    elif malformation == "unknown-private-prefix":
        unknown = root / ".staging-machine-attestation.unknown"
        unknown.mkdir(mode=0o700)
    elif malformation == "quarantine-missing-marker":
        quarantine = root / STAGING_QUARANTINE_NAME
        quarantine.mkdir(mode=0o700)
    elif malformation == "quarantine-extra":
        quarantine = root / STAGING_QUARANTINE_NAME
        quarantine.mkdir(mode=0o700)
        extra = quarantine / "unexpected"
        extra.write_bytes(b"unexpected")
        extra.chmod(0o400)
    elif malformation == "temp-and-quarantine":
        quarantine = root / STAGING_QUARANTINE_NAME
        quarantine.mkdir(mode=0o700)
    before = {
        path.relative_to(root).as_posix(): (
            os.lstat(path).st_dev,
            os.lstat(path).st_ino,
            stat.S_IFMT(os.lstat(path).st_mode),
            stat.S_IMODE(os.lstat(path).st_mode),
            os.lstat(path).st_nlink,
            (
                os.readlink(path)
                if path.is_symlink()
                else path.read_bytes()
                if path.is_file()
                else None
            ),
        )
        for path in root.rglob("*")
    }
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("malformed partial reached host capture"),
    )

    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    after = {
        path.relative_to(root).as_posix(): (
            os.lstat(path).st_dev,
            os.lstat(path).st_ino,
            stat.S_IFMT(os.lstat(path).st_mode),
            stat.S_IMODE(os.lstat(path).st_mode),
            os.lstat(path).st_nlink,
            (
                os.readlink(path)
                if path.is_symlink()
                else path.read_bytes()
                if path.is_file()
                else None
            ),
        )
        for path in root.rglob("*")
    }
    assert after == before


def _linux_marker_binding_mutation_is_untouched(
        tmp_path, monkeypatch, mutation):
    capture = import_capture(
        "capture_machine_marker_binding_" + mutation
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    marker_value = json.loads(staging_transaction_marker_raw(root, inputs))
    if mutation == "schema":
        marker_value["schemaVersion"] = 2
    elif mutation == "kind":
        marker_value["kind"] = "wrong"
    elif mutation == "capture-intent":
        marker_value["captureIntentSha256"] = "f" * 64
    elif mutation == "session":
        marker_value["sessionSha256"] = "f" * 64
    elif mutation == "root-device":
        marker_value["releaseRoot"]["device"] += 1
    elif mutation == "root-inode":
        marker_value["releaseRoot"]["inode"] += 1
    elif mutation == "extra":
        marker_value["hidden"] = True
    marker = root / STAGING_MARKER_NAME
    if mutation == "noncanonical":
        marker.write_text(json.dumps(marker_value), encoding="utf-8")
    else:
        marker.write_bytes(acceptance.canonical(marker_value))
    marker.chmod(0o400)
    partial = root / STAGING_TEMP_NAME
    partial.mkdir(mode=0o700)
    before = exact_tree_snapshot(root)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("invalid marker reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)
    assert exact_tree_snapshot(root) == before


def _linux_private_state_security_malformation_is_untouched(
        tmp_path, monkeypatch, malformation):
    if malformation.endswith("-owner") and os.geteuid() != 0:
        return
    capture = import_capture(
        "capture_machine_private_security_" + malformation
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    marker = root / STAGING_MARKER_NAME
    external_snapshot = None
    external_root = None
    if malformation.startswith("marker-"):
        external = tmp_path / "external-marker"
        if malformation == "marker-symlink":
            external.write_bytes(staging_transaction_marker_raw(
                root, inputs))
            external.chmod(0o400)
            os.symlink(external, marker)
            external_root = tmp_path
            external_snapshot = (
                os.stat(external).st_dev,
                os.stat(external).st_ino,
                stat.S_IMODE(os.stat(external).st_mode),
                os.stat(external).st_nlink,
                external.read_bytes(),
            )
        elif malformation == "marker-hardlink":
            external.write_bytes(staging_transaction_marker_raw(
                root, inputs))
            external.chmod(0o400)
            os.link(external, marker)
            external_root = tmp_path
            external_snapshot = (
                os.stat(external).st_dev,
                os.stat(external).st_ino,
                stat.S_IMODE(os.stat(external).st_mode),
                os.stat(external).st_nlink,
                external.read_bytes(),
            )
        elif malformation == "marker-type":
            marker.mkdir(mode=0o700)
        else:
            write_staging_transaction_marker(root, inputs)
            if malformation == "marker-mode":
                marker.chmod(0o600)
            else:
                os.chown(marker, 1, 1)
    else:
        write_staging_transaction_marker(root, inputs)
        private_name = (
            STAGING_QUARANTINE_NAME
            if malformation.startswith("quarantine-")
            else STAGING_TEMP_NAME
        )
        private = root / private_name
        suffix = malformation.split("-", 1)[1]
        if suffix == "symlink":
            external = tmp_path / "external-private"
            external.mkdir(mode=0o700)
            sentinel = external / "sentinel"
            sentinel.write_bytes(b"protected")
            sentinel.chmod(0o400)
            external_root = external
            external_snapshot = exact_tree_snapshot(external)
            os.symlink(external, private, target_is_directory=True)
        elif suffix == "type":
            private.write_bytes(b"not-a-directory")
            private.chmod(0o400)
        else:
            private.mkdir(mode=0o700)
            if suffix == "mode":
                private.chmod(0o755)
            elif suffix == "owner":
                os.chown(private, 1, 1)
            elif suffix == "leaf-type":
                (private / "machine-id").mkdir(mode=0o700)
            elif suffix == "leaf-owner":
                leaf = private / "machine-id"
                leaf.write_bytes(b"partial")
                leaf.chmod(0o400)
                os.chown(leaf, 1, 1)
    before = exact_tree_snapshot(root)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("malformed private state reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)
    assert exact_tree_snapshot(root) == before
    if external_snapshot is not None:
        if external_root == tmp_path:
            external = tmp_path / "external-marker"
            assert (
                os.stat(external).st_dev,
                os.stat(external).st_ino,
                stat.S_IMODE(os.stat(external).st_mode),
                os.stat(external).st_nlink,
                external.read_bytes(),
            ) == external_snapshot
        else:
            assert exact_tree_snapshot(external_root) == external_snapshot


def _linux_partial_recovery_detects_temp_replacement_before_quarantine_rename(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_partial_replacement")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    write_staging_transaction_marker(root, inputs)
    partial = root / STAGING_TEMP_NAME
    partial.mkdir(mode=0o700)
    leaf = partial / "machine-id"
    leaf.write_bytes(b"partial")
    leaf.chmod(0o400)
    real_rename = capture._rename_noreplace
    attacked = []

    def replace_then_rename(
            source_dir_fd, source_name,
            destination_dir_fd, destination_name):
        if (source_name == STAGING_TEMP_NAME
                and destination_name == STAGING_QUARANTINE_NAME
                and not attacked):
            attacked.append(True)
            partial.rename(tmp_path / "held-original-partial")
            partial.mkdir(mode=0o700)
            replacement = partial / "machine-id"
            replacement.write_bytes(b"replacement")
            replacement.chmod(0o400)
        return real_rename(
            source_dir_fd,
            source_name,
            destination_dir_fd,
            destination_name,
        )

    monkeypatch.setattr(capture, "_rename_noreplace", replace_then_rename)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("replacement partial reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert (root / STAGING_MARKER_NAME).is_file()
    assert (root / STAGING_QUARANTINE_NAME / "machine-id").read_bytes() == (
        b"replacement"
    )
    assert (tmp_path / "held-original-partial" / "machine-id").read_bytes() == (
        b"partial"
    )


def _linux_final_evidence_rename_race_refuses_competitor_without_deletion(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_evidence_rename_race")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    real_rename = capture._rename_noreplace
    raced = []
    competitor_state = []

    def race(source_dir_fd, source_name,
             destination_dir_fd, destination_name):
        if (source_name == STAGING_TEMP_NAME
                and destination_name == STAGING_EVIDENCE_NAME
                and not raced):
            raced.append(True)
            competitor = root / STAGING_EVIDENCE_NAME
            competitor.mkdir(mode=0o700)
            competitor_state.append(
                (os.stat(competitor).st_dev, os.stat(competitor).st_ino)
            )
        return real_rename(
            source_dir_fd,
            source_name,
            destination_dir_fd,
            destination_name,
        )

    monkeypatch.setattr(capture, "_rename_noreplace", race)
    monkeypatch.setattr(
        capture.os,
        "rename",
        lambda *_args, **_kwargs: pytest.fail(
            "staging publication used os.rename fallback"
        ),
    )
    monkeypatch.setattr(
        capture.os,
        "replace",
        lambda *_args, **_kwargs: pytest.fail(
            "staging publication used os.replace fallback"
        ),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    competitor = root / STAGING_EVIDENCE_NAME
    assert os.listdir(competitor) == []
    assert (
        os.stat(competitor).st_dev,
        os.stat(competitor).st_ino,
    ) == competitor_state[0]
    assert not (root / STAGING_OUTPUT_NAME).exists()
    assert (root / STAGING_MARKER_NAME).exists()
    assert (root / STAGING_TEMP_NAME).exists()


def _linux_final_output_race_refuses_competitor_without_deletion(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_output_race")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    real_write = capture._write_exclusive_file_at
    raced = []

    def race(directory_fd, name, body, mode=0o400):
        if name == STAGING_OUTPUT_NAME and not raced:
            raced.append(True)
            output = root / STAGING_OUTPUT_NAME
            output.write_bytes(b"competitor")
            output.chmod(0o400)
        return real_write(directory_fd, name, body, mode)

    monkeypatch.setattr(capture, "_write_exclusive_file_at", race)
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert (root / STAGING_OUTPUT_NAME).read_bytes() == b"competitor"
    assert (root / STAGING_EVIDENCE_NAME).is_dir()
    assert (root / STAGING_MARKER_NAME).is_file()


def _linux_final_staging_publication_corruption_fails_closed_and_untouched(
        tmp_path, monkeypatch, corruption):
    if corruption.endswith("-owner") and os.geteuid() != 0:
        return
    capture = import_capture(
        "capture_machine_final_corruption_" + corruption
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)

    evidence = root / STAGING_EVIDENCE_NAME
    leaf = evidence / "machine-id"
    output = root / STAGING_OUTPUT_NAME
    external_path = None
    if corruption == "evidence-missing":
        leaf.unlink()
    elif corruption == "evidence-extra":
        extra = evidence / "extra"
        extra.write_bytes(b"extra")
        extra.chmod(0o400)
    elif corruption == "evidence-leaf-symlink":
        external = tmp_path / "external-leaf"
        leaf.replace(external)
        os.symlink(external, leaf)
        external_path = external
    elif corruption == "evidence-leaf-hardlink":
        os.link(leaf, tmp_path / "external-hardlink")
    elif corruption == "evidence-leaf-mode":
        leaf.chmod(0o600)
    elif corruption == "evidence-leaf-drift":
        leaf.chmod(0o600)
        leaf.write_bytes(b"drift")
        leaf.chmod(0o400)
    elif corruption == "evidence-leaf-type":
        leaf.unlink()
        leaf.mkdir(mode=0o700)
    elif corruption == "evidence-directory-symlink":
        external = tmp_path / "external-evidence"
        evidence.replace(external)
        os.symlink(external, evidence, target_is_directory=True)
        external_path = external
    elif corruption == "evidence-directory-mode":
        evidence.chmod(0o755)
    elif corruption == "evidence-directory-owner":
        os.chown(evidence, 1, 1)
    elif corruption == "output-symlink":
        external = tmp_path / "external-output"
        output.replace(external)
        os.symlink(external, output)
        external_path = external
    elif corruption == "output-hardlink":
        os.link(output, tmp_path / "external-output-hardlink")
    elif corruption == "output-mode":
        output.chmod(0o600)
    elif corruption == "output-owner":
        os.chown(output, 1, 1)
    elif corruption == "output-drift":
        output.chmod(0o600)
        output.write_bytes(b"drift")
        output.chmod(0o400)
    elif corruption == "output-noncanonical":
        value = json.loads(output.read_bytes())
        output.chmod(0o600)
        output.write_text(json.dumps(value), encoding="utf-8")
        output.chmod(0o400)
    else:
        output.unlink()
        output.mkdir(mode=0o700)

    before = exact_tree_snapshot(root)
    external_before = (
        exact_node_snapshot(external_path)
        if external_path is not None
        else None
    )
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("corrupt final state reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)
    assert exact_tree_snapshot(root) == before
    if external_path is not None:
        assert exact_node_snapshot(external_path) == external_before


def _linux_final_staging_evidence_wrong_owner_fails_closed(
        tmp_path, monkeypatch):
    if os.geteuid() != 0:
        return
    capture = import_capture("capture_machine_final_wrong_owner")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)
    leaf = root / STAGING_EVIDENCE_NAME / "machine-id"
    os.chown(leaf, 1, 1)
    before = (os.stat(leaf).st_uid, os.stat(leaf).st_gid,
              os.stat(leaf).st_ino, leaf.read_bytes())
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("wrong owner reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)
    assert (os.stat(leaf).st_uid, os.stat(leaf).st_gid,
            os.stat(leaf).st_ino, leaf.read_bytes()) == before


def _linux_held_release_root_and_parent_replacement_fail_before_capture(
        tmp_path, monkeypatch, replacement):
    capture = import_capture(
        "capture_machine_held_replacement_" + replacement
    )
    ancestor = tmp_path / "ancestor"
    ancestor.mkdir(mode=0o700)
    parent = ancestor / "parent"
    parent.mkdir(mode=0o700)
    root = parent / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("replaced held root reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        if replacement == "release-root":
            root.rename(parent / "held-original-release")
            root.mkdir(mode=0o700)
        elif replacement == "release-parent":
            parent.rename(ancestor / "held-original-parent")
            parent.mkdir(mode=0o700)
            root.mkdir(mode=0o700)
        else:
            ancestor.rename(tmp_path / "held-original-ancestor")
            ancestor.mkdir(mode=0o700)
            parent.mkdir(mode=0o700)
            root.mkdir(mode=0o700)
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert os.listdir(root) == []


def _linux_fresh_revalidates_after_host_before_any_publication(
        tmp_path, monkeypatch, mutation):
    capture = import_capture(
        "capture_machine_post_host_revalidation_" + mutation
    )
    ancestor = tmp_path / "ancestor"
    parent = ancestor / "parent"
    parent.mkdir(parents=True, mode=0o700)
    requested_root = parent / "release"
    requested_root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    host_calls = []
    injected_states = []
    release_locations = []

    def capture_host():
        host_calls.append(True)
        if mutation == "unknown-reserved-prefix":
            injected = (
                requested_root
                / ".staging-machine-attestation.injected"
            )
            injected.write_bytes(b"controller-owned-injection")
            injected.chmod(0o400)
            release_locations.append(requested_root)
        elif mutation == "release-root-relink":
            original_release = parent / "held-original-release"
            requested_root.rename(original_release)
            requested_root.mkdir(mode=0o700)
            sentinel = requested_root / "injected-sentinel"
            sentinel.write_bytes(b"replacement-root")
            sentinel.chmod(0o400)
            release_locations.extend((
                original_release,
                requested_root,
            ))
        elif mutation == "release-ancestor-relink":
            held_ancestor = tmp_path / "held-original-ancestor"
            ancestor.rename(held_ancestor)
            replacement_parent = ancestor / "parent"
            replacement_parent.mkdir(parents=True, mode=0o700)
            replacement_root = replacement_parent / "release"
            replacement_root.mkdir(mode=0o700)
            sentinel = replacement_root / "injected-sentinel"
            sentinel.write_bytes(b"replacement-ancestor")
            sentinel.chmod(0o400)
            release_locations.extend((
                held_ancestor / "parent" / "release",
                replacement_root,
            ))
        else:
            raise AssertionError(f"unknown host mutation: {mutation}")
        injected_states.extend(
            (location, exact_tree_snapshot(location))
            for location in release_locations
        )
        return fixed_staging_host_evidence()

    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        capture_host,
    )
    with capture._open_staging_release_root(
            requested_root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(
                held,
                **inputs,
            )

    assert host_calls == [True]
    assert len(injected_states) == len(release_locations)
    for location, expected_state in injected_states:
        assert exact_tree_snapshot(location) == expected_state
        for reserved_name in (
            STAGING_MARKER_NAME,
            STAGING_TEMP_NAME,
            STAGING_QUARANTINE_NAME,
            STAGING_EVIDENCE_NAME,
            STAGING_OUTPUT_NAME,
        ):
            assert not os.path.lexists(location / reserved_name)


def _linux_held_release_root_rejects_symlink_ancestor(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_held_symlink_ancestor")
    actual_top = tmp_path / "actual-top"
    actual_parent = actual_top / "deep" / "parent"
    actual_parent.mkdir(parents=True, mode=0o700)
    actual = actual_parent / "release"
    actual.mkdir(mode=0o700)
    linked_top = tmp_path / "linked-top"
    os.symlink(actual_top, linked_top, target_is_directory=True)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("symlink ancestor reached host capture"),
    )
    with pytest.raises(
            capture.CaptureError,
            match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        with capture._open_staging_release_root(
                linked_top / "deep" / "parent" / "release"):
            pytest.fail("symlink ancestor opened")
    assert os.listdir(actual) == []


def _linux_held_release_root_rejects_metadata_drift_and_closed_handle(
        tmp_path, monkeypatch, mutation):
    capture = import_capture(
        "capture_machine_held_metadata_" + mutation
    )
    parent = tmp_path / "parent"
    parent.mkdir(mode=0o700)
    root = parent / "release"
    root.mkdir(mode=0o700)
    host_calls = []
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: host_calls.append(True) or fixed_staging_host_evidence(),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        if mutation == "release-root-mode":
            root.chmod(0o755)
        elif mutation == "release-parent-mode":
            parent.chmod(0o755)
        elif mutation == "release-root-owner":
            assert os.geteuid() == 0
            os.chown(root, 1, 1)
        else:
            raise AssertionError(f"unknown metadata mutation: {mutation}")
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(
                held,
                **staging_capture_inputs(),
            )

    assert host_calls == []
    assert os.listdir(root) == []

    fresh_root = tmp_path / "fresh-release"
    fresh_root.mkdir(mode=0o700)
    with capture._open_staging_release_root(fresh_root.resolve()) as closed:
        pass
    with pytest.raises(
            capture.CaptureError,
            match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.capture_staging_machine_attestation(
            closed,
            **staging_capture_inputs(),
        )
    assert host_calls == []
    assert os.listdir(fresh_root) == []


def _linux_held_release_root_rejects_parent_alias(tmp_path, monkeypatch):
    capture = import_capture("capture_machine_held_parent_alias")
    actual = tmp_path / "release"
    actual.mkdir(mode=0o700)
    alias_parent = tmp_path / "unused"
    alias_parent.mkdir(mode=0o700)
    alias = alias_parent / ".." / "release"
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("parent alias reached host capture"),
    )
    with pytest.raises(
            capture.CaptureError,
            match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        with capture._open_staging_release_root(alias):
            pytest.fail("parent alias opened")
    assert os.listdir(actual) == []


def _linux_post_fsync_path_swap_is_detected_and_left_as_poison(
        tmp_path, monkeypatch, target):
    capture = import_capture(
        "capture_machine_post_fsync_swap_"
        + target.replace(".", "_")
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    real_fsync = capture.os.fsync
    swapped = []
    replacement_state = []

    def swap_after_fsync(fd):
        result = real_fsync(fd)
        try:
            linked = os.readlink(f"/proc/self/fd/{fd}")
        except OSError:
            return result
        if target == "temporary-leaf":
            should_swap = linked.endswith(
                "/" + STAGING_TEMP_NAME + "/machine-id"
            )
            path = root / STAGING_TEMP_NAME / "machine-id"
        elif target == "final-evidence-leaf":
            should_swap = (
                linked == str(root)
                and (root / STAGING_EVIDENCE_NAME).is_dir()
                and not (root / STAGING_OUTPUT_NAME).exists()
            )
            path = root / STAGING_EVIDENCE_NAME / "machine-id"
        elif target == "output-after-root-fsync":
            should_swap = (
                linked == str(root)
                and (root / STAGING_OUTPUT_NAME).is_file()
            )
            path = root / STAGING_OUTPUT_NAME
        elif target == "temporary-directory":
            should_swap = linked.endswith("/" + STAGING_TEMP_NAME)
            path = root / STAGING_TEMP_NAME
        elif target == "final-evidence-directory":
            should_swap = (
                linked == str(root)
                and (root / STAGING_EVIDENCE_NAME).is_dir()
                and not (root / STAGING_OUTPUT_NAME).exists()
            )
            path = root / STAGING_EVIDENCE_NAME
        else:
            should_swap = linked.endswith("/" + target)
            path = root / target
        if should_swap and not swapped:
            swapped.append(True)
            if target in {
                    "temporary-directory",
                    "final-evidence-directory"}:
                held_original = tmp_path / (
                    "held-" + target
                )
                path.rename(held_original)
                path.mkdir(mode=0o700)
                for original in held_original.iterdir():
                    replacement = path / original.name
                    replacement.write_bytes(original.read_bytes())
                    replacement.chmod(0o400)
                replacement_directory = os.stat(
                    path,
                    follow_symlinks=False,
                )
                replacement_state.append((
                    replacement_directory.st_dev,
                    replacement_directory.st_ino,
                    exact_tree_snapshot(path),
                ))
            else:
                path.unlink()
                path.write_bytes(b"replacement")
                path.chmod(0o400)
        return result

    monkeypatch.setattr(capture.os, "fsync", swap_after_fsync)
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert swapped == [True]
    if target == "temporary-leaf":
        poisoned = root / STAGING_TEMP_NAME / "machine-id"
    elif target == "final-evidence-leaf":
        poisoned = root / STAGING_EVIDENCE_NAME / "machine-id"
    elif target == "output-after-root-fsync":
        poisoned = root / STAGING_OUTPUT_NAME
    elif target == "temporary-directory":
        candidates = [
            root / STAGING_TEMP_NAME,
            root / STAGING_EVIDENCE_NAME,
        ]
        existing = [item for item in candidates if item.exists()]
        assert len(existing) == 1
        poisoned = existing[0]
    elif target == "final-evidence-directory":
        poisoned = root / STAGING_EVIDENCE_NAME
    else:
        poisoned = root / target
    if target.endswith("directory"):
        assert poisoned.is_dir()
        assert len(replacement_state) == 1
        replacement_device, replacement_inode, replacement_tree = (
            replacement_state[0]
        )
        poisoned_state = os.stat(poisoned, follow_symlinks=False)
        assert (
            poisoned_state.st_dev,
            poisoned_state.st_ino,
        ) == (
            replacement_device,
            replacement_inode,
        )
        assert exact_tree_snapshot(poisoned) == replacement_tree
        assert sorted(os.listdir(poisoned)) == sorted(
            (*COMMON_EVIDENCE_FILES,
             "fault-session-attestation.json")
        )
    else:
        assert poisoned.read_bytes() == b"replacement"


def _linux_external_full9_rejects_synchronized_session_and_output_rebind(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_external_full9")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)

    rebound_session = fault_session()
    rebound_session["runId"] = "ffffffff-ffff-4fff-afff-ffffffffffff"
    rebound_session["challenge"] = "f" * 64
    rebound_session["captureProof"]["rawManifestSha256"] = (
        inputs["raw_manifest_bundle"]["manifestSha256"]
    )
    rebound_raw = acceptance.canonical(rebound_session)
    rebound_binding = session_binding(rebound_session)
    session_path = (
        root / STAGING_EVIDENCE_NAME
        / "fault-session-attestation.json"
    )
    session_path.chmod(0o600)
    session_path.write_bytes(rebound_raw)
    session_path.chmod(0o400)
    output = root / STAGING_OUTPUT_NAME
    rebound_output = json.loads(output.read_bytes())
    rebound_output["runBinding"] = rebound_binding
    output.chmod(0o600)
    output.write_bytes(acceptance.canonical(rebound_output))
    output.chmod(0o400)
    before = (session_path.read_bytes(), output.read_bytes())
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("rebound final state reached host capture"),
    )

    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert (session_path.read_bytes(), output.read_bytes()) == before


def _linux_owned_profile_rejects_synchronized_evidence_output_rebind(
        tmp_path, monkeypatch):
    capture = import_capture("capture_machine_owned_profile_rebind")
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)

    profile_path = (
        root / STAGING_EVIDENCE_NAME / "vllm-normal-profile.json"
    )
    profile = json.loads(profile_path.read_bytes())
    alternate_response = acceptance.canonical({
        "choices": [{
            "message": {
                "content": ' { "ok" : true } ',
            },
        }],
    })
    profile["samples"][0]["responseBodyBase64"] = base64.b64encode(
        alternate_response
    ).decode("ascii")
    rebound_profile_raw = acceptance.canonical(profile)
    session_value = json.loads(inputs["session_raw"])
    acceptance.validate_phase5_species_load_samples_bytes(
        rebound_profile_raw,
        {
            name: copy.deepcopy(session_value[name])
            for name in (
                "runId",
                "challenge",
                "release",
                "geometry",
                "profile",
            )
        },
        "normal",
    )
    profile_path.chmod(0o600)
    profile_path.write_bytes(rebound_profile_raw)
    profile_path.chmod(0o400)
    output = root / STAGING_OUTPUT_NAME
    output_value = json.loads(output.read_bytes())
    output_value["environmentEvidence"]["vllmNormalProfile"] = (
        hashlib.sha256(rebound_profile_raw).hexdigest()
    )
    output.chmod(0o600)
    output.write_bytes(acceptance.canonical(output_value))
    output.chmod(0o400)
    before = exact_tree_snapshot(root)
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("profile rebound final state reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)
    assert exact_tree_snapshot(root) == before


def _linux_fresh_same_byte_creation_inode_swap_is_detected(
        tmp_path, monkeypatch, target):
    capture = import_capture(
        "capture_machine_fresh_same_byte_creation_" + target
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    host_calls = []
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: (
            host_calls.append(True)
            or fixed_staging_host_evidence()
        ),
    )
    real_write = capture._write_exclusive_file_at
    replacement_inode = []

    def swap_after_write(directory_fd, name, body, mode=0o400):
        creation_state = real_write(
            directory_fd,
            name,
            body,
            mode,
        )
        linked_directory = os.readlink(
            f"/proc/self/fd/{directory_fd}"
        )
        should_swap = (
            (
                target == "temporary-leaf"
                and name == "machine-id"
                and linked_directory.endswith("/" + STAGING_TEMP_NAME)
            )
            or (
                target == "marker"
                and name == STAGING_MARKER_NAME
                and linked_directory == str(root)
            )
            or (
                target == "output"
                and name == STAGING_OUTPUT_NAME
                and linked_directory == str(root)
            )
        )
        if should_swap and not replacement_inode:
            path = Path(linked_directory) / name
            path.rename(tmp_path / ("held-created-" + target))
            path.write_bytes(body)
            path.chmod(0o400)
            replacement_state = os.stat(
                path,
                follow_symlinks=False,
            )
            assert replacement_state.st_ino != creation_state.inode
            replacement_inode.append(replacement_state.st_ino)
        return creation_state

    monkeypatch.setattr(
        capture,
        "_write_exclusive_file_at",
        swap_after_write,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert host_calls == [True]
    assert len(replacement_inode) == 1
    if target == "temporary-leaf":
        candidates = [
            root / STAGING_TEMP_NAME / "machine-id",
            root / STAGING_EVIDENCE_NAME / "machine-id",
        ]
        existing = [path for path in candidates if path.exists()]
        assert len(existing) == 1
        poisoned = existing[0]
    elif target == "marker":
        poisoned = root / STAGING_MARKER_NAME
    else:
        poisoned = root / STAGING_OUTPUT_NAME
    assert os.stat(
        poisoned,
        follow_symlinks=False,
    ).st_ino == replacement_inode[0]
    assert stat.S_IMODE(os.stat(poisoned).st_mode) == 0o400
    assert (root / STAGING_MARKER_NAME).is_file()


def _linux_verified_marker_same_byte_swap_before_unlink_is_detected(
        tmp_path, monkeypatch, state):
    capture = import_capture(
        "capture_machine_verified_marker_swap_" + state
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    if state != "fresh":
        if state == "recovery":
            write_staging_transaction_marker(root, inputs)
        else:
            monkeypatch.setattr(
                capture,
                "_capture_fixed_staging_host_evidence",
                fixed_staging_host_evidence,
            )
            with capture._open_staging_release_root(
                    root.resolve()) as held:
                capture.capture_staging_machine_attestation(
                    held,
                    **inputs,
                )
            if state == "evidence-only":
                (root / STAGING_OUTPUT_NAME).unlink()
            write_staging_transaction_marker(root, inputs)

    host_calls = []
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: (
            host_calls.append(True)
            or fixed_staging_host_evidence()
        ),
    )
    swapped_inode = []
    poison_snapshot = []

    def swap_marker():
        marker = root / STAGING_MARKER_NAME
        marker_raw = marker.read_bytes()
        original_inode = os.stat(
            marker,
            follow_symlinks=False,
        ).st_ino
        marker.rename(tmp_path / ("held-verified-marker-" + state))
        marker.write_bytes(marker_raw)
        marker.chmod(0o400)
        replacement_inode = os.stat(
            marker,
            follow_symlinks=False,
        ).st_ino
        assert replacement_inode != original_inode
        swapped_inode.append(replacement_inode)
        poison_snapshot.append(exact_tree_snapshot(root))

    if state == "recovery":
        real_verify = capture._verify_marker

        def verify_then_swap(*args, **kwargs):
            marker_state = real_verify(*args, **kwargs)
            if not swapped_inode:
                swap_marker()
            return marker_state

        monkeypatch.setattr(
            capture,
            "_verify_marker",
            verify_then_swap,
        )
    else:
        real_composite = capture._validate_owned_staging_composite

        def composite_then_swap(*args, **kwargs):
            snapshot = real_composite(*args, **kwargs)
            if not swapped_inode:
                swap_marker()
            return snapshot

        monkeypatch.setattr(
            capture,
            "_validate_owned_staging_composite",
            composite_then_swap,
        )

    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert len(swapped_inode) == 1
    marker = root / STAGING_MARKER_NAME
    assert os.stat(
        marker,
        follow_symlinks=False,
    ).st_ino == swapped_inode[0]
    assert exact_tree_snapshot(root) == poison_snapshot[0]
    assert host_calls == ([True] if state == "fresh" else [])


def _linux_same_byte_final_inode_swap_is_detected(
        tmp_path, monkeypatch, target):
    capture = import_capture(
        "capture_machine_same_byte_final_swap_" + target
    )
    root = tmp_path / "release"
    root.mkdir(mode=0o700)
    inputs = staging_capture_inputs()
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        fixed_staging_host_evidence,
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        capture.capture_staging_machine_attestation(held, **inputs)

    original_path = (
        root / STAGING_EVIDENCE_NAME
        if target == "evidence-directory"
        else root / STAGING_OUTPUT_NAME
    )
    original_inode = os.stat(
        original_path,
        follow_symlinks=False,
    ).st_ino
    real_output_builder = capture._staging_output_from_evidence
    swapped = []
    poison_snapshot = []

    def swap_then_build(evidence, owned):
        if not swapped:
            held_original = tmp_path / ("held-original-" + target)
            original_path.rename(held_original)
            if target == "evidence-directory":
                original_path.mkdir(mode=0o700)
                for source in held_original.iterdir():
                    replacement = original_path / source.name
                    replacement.write_bytes(source.read_bytes())
                    replacement.chmod(0o400)
            else:
                original_path.write_bytes(held_original.read_bytes())
                original_path.chmod(0o400)
            replacement_inode = os.stat(
                original_path,
                follow_symlinks=False,
            ).st_ino
            assert replacement_inode != original_inode
            swapped.append(replacement_inode)
            poison_snapshot.append(exact_tree_snapshot(root))
        return real_output_builder(evidence, owned)

    monkeypatch.setattr(
        capture,
        "_staging_output_from_evidence",
        swap_then_build,
    )
    monkeypatch.setattr(
        capture,
        "_capture_fixed_staging_host_evidence",
        lambda: pytest.fail("same-byte final swap reached host capture"),
    )
    with capture._open_staging_release_root(root.resolve()) as held:
        with pytest.raises(
                capture.CaptureError,
                match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
            capture.capture_staging_machine_attestation(held, **inputs)

    assert len(swapped) == 1
    assert os.stat(
        original_path,
        follow_symlinks=False,
    ).st_ino == swapped[0]
    assert exact_tree_snapshot(root) == poison_snapshot[0]


@linux_release_security
def test_capture_derives_identity_and_writes_hash_bound_raw_evidence(
        tmp_path, monkeypatch):
    sequence = 0

    def run(helper, *args):
        nonlocal sequence
        sequence += 1
        case_root = tmp_path / f"case-{sequence:03d}"
        case_root.mkdir(mode=0o700)
        with monkeypatch.context() as isolated:
            helper(case_root, isolated, *args)

    for mutation in (
        "capture-intent",
        "session-raw",
        "full9-hidden",
        "full9-type",
        "external-binding",
        "session-digest",
        "manifest-sha",
        "manifest-raw",
        "manifest-declaration",
        "bundle-missing",
        "bundle-extra",
        "blob-missing",
        "blob-extra",
        "manifest-blob",
        "normal-profile",
        "burst-profile",
        "normal-profile-schema",
    ):
        run(
            _linux_staging_input_mismatch_fails_before_host_capture_or_marker,
            mutation,
        )
    run(_linux_staging_rejects_noncapability_release_root)
    for post_host_mutation in (
        "unknown-reserved-prefix",
        "release-root-relink",
        "release-ancestor-relink",
    ):
        run(
            _linux_fresh_revalidates_after_host_before_any_publication,
            post_host_mutation,
        )
    for nonregular_candidate in (
        "marker",
        "final-output",
        "evidence-leaf",
        "partial-leaf",
        "quarantine-leaf",
        "direct-marker-delete",
        "direct-partial-delete",
    ):
        run(
            _linux_nonregular_candidate_fails_without_blocking,
            nonregular_candidate,
        )
    run(
        _linux_staging_capture_fresh_publication_is_fixed_durable_and_immutable
    )
    run(_linux_fresh_publication_fsync_rename_output_order)
    run(
        _linux_staging_evidence_only_rebuilds_byte_identical_output_without_host
    )
    for marker_state in ("missing", "wrong"):
        run(
            _linux_evidence_only_requires_verified_marker,
            marker_state,
        )
    run(_linux_completed_leftover_marker_is_verified_then_removed)
    run(_linux_evidence_only_composite_failure_keeps_poison)
    run(_linux_staging_completed_capture_is_write_free_idempotent)
    run(_linux_staging_output_only_is_impossible_and_left_untouched)
    run(
        _linux_owned_composite_runs_after_output_fsync_and_failure_keeps_poison
    )
    for partial_count in range(-1, 12):
        run(
            _linux_each_verified_private_partial_state_is_recovered,
            partial_count,
        )
    for remaining_count in (0, 1, 5, 11):
        run(
            _linux_interrupted_quarantine_deletion_is_recovered,
            remaining_count,
        )
    for private_state in ("partial", "quarantine"):
        run(
            _linux_private_recovery_is_durable_before_host_capture,
            private_state,
        )
    for malformation in (
        "missing-marker",
        "wrong-marker",
        "extra-leaf",
        "leaf-symlink",
        "leaf-hardlink",
        "wrong-mode",
        "unknown-private-prefix",
        "quarantine-missing-marker",
        "quarantine-extra",
        "temp-and-quarantine",
    ):
        run(
            _linux_unknown_or_malformed_private_partial_is_untouched,
            malformation,
        )
    for marker_mutation in (
        "schema",
        "kind",
        "capture-intent",
        "session",
        "root-device",
        "root-inode",
        "extra",
        "noncanonical",
    ):
        run(
            _linux_marker_binding_mutation_is_untouched,
            marker_mutation,
        )
    for security_malformation in (
        "marker-symlink",
        "marker-hardlink",
        "marker-type",
        "marker-mode",
        "marker-owner",
        "temp-symlink",
        "temp-type",
        "temp-mode",
        "temp-owner",
        "temp-leaf-type",
        "temp-leaf-owner",
        "quarantine-symlink",
        "quarantine-type",
        "quarantine-mode",
        "quarantine-owner",
        "quarantine-leaf-type",
        "quarantine-leaf-owner",
    ):
        run(
            _linux_private_state_security_malformation_is_untouched,
            security_malformation,
        )
    run(
        _linux_partial_recovery_detects_temp_replacement_before_quarantine_rename
    )
    run(
        _linux_final_evidence_rename_race_refuses_competitor_without_deletion
    )
    run(_linux_final_output_race_refuses_competitor_without_deletion)
    for corruption in (
        "evidence-missing",
        "evidence-extra",
        "evidence-leaf-symlink",
        "evidence-leaf-hardlink",
        "evidence-leaf-mode",
        "evidence-leaf-drift",
        "evidence-leaf-type",
        "evidence-directory-symlink",
        "evidence-directory-mode",
        "evidence-directory-owner",
        "output-symlink",
        "output-hardlink",
        "output-mode",
        "output-owner",
        "output-drift",
        "output-noncanonical",
        "output-type",
    ):
        run(
            _linux_final_staging_publication_corruption_fails_closed_and_untouched,
            corruption,
        )
    run(_linux_final_staging_evidence_wrong_owner_fails_closed)
    for replacement in (
        "release-root",
        "release-parent",
        "release-ancestor",
    ):
        run(
            _linux_held_release_root_and_parent_replacement_fail_before_capture,
            replacement,
        )
    run(_linux_held_release_root_rejects_parent_alias)
    run(_linux_held_release_root_rejects_symlink_ancestor)
    for metadata_mutation in (
        "release-root-mode",
        "release-parent-mode",
        *(
            ("release-root-owner",)
            if os.geteuid() == 0
            else ()
        ),
    ):
        run(
            _linux_held_release_root_rejects_metadata_drift_and_closed_handle,
            metadata_mutation,
        )
    for target in (
        STAGING_MARKER_NAME,
        STAGING_OUTPUT_NAME,
        "temporary-leaf",
        "final-evidence-leaf",
        "output-after-root-fsync",
        "temporary-directory",
        "final-evidence-directory",
    ):
        run(
            _linux_post_fsync_path_swap_is_detected_and_left_as_poison,
            target,
        )
    run(
        _linux_external_full9_rejects_synchronized_session_and_output_rebind
    )
    run(
        _linux_owned_profile_rejects_synchronized_evidence_output_rebind
    )
    for creation_swap_target in (
        "marker",
        "temporary-leaf",
        "output",
    ):
        run(
            _linux_fresh_same_byte_creation_inode_swap_is_detected,
            creation_swap_target,
        )
    for marker_swap_state in (
        "fresh",
        "recovery",
        "evidence-only",
        "completed",
    ):
        run(
            _linux_verified_marker_same_byte_swap_before_unlink_is_detected,
            marker_swap_state,
        )
    for final_swap_target in (
        "evidence-directory",
        "output",
    ):
        run(
            _linux_same_byte_final_inode_swap_is_detected,
            final_swap_target,
        )
