from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
spec = importlib.util.spec_from_file_location("phase5_acceptance_machine", VALIDATOR)
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)

H = "a" * 64


def attestation(address="192.168.9.140", machine="b", key="c", gpu="GPU-one"):
    return {"schemaVersion": 1, "hostname": "host", "machineIdSha256": machine * 64,
            "sshHostKeySha256": "SHA256:" + key * 43,
            "canonicalInterfaceAddresses": [address], "gpuUuids": [gpu],
            "platform": {"architecture": "aarch64", "gpuModel": "NVIDIA GB10",
                         "driverVersion": "1", "torchVersion": "2", "cudaVersion": "13",
                         "cudaAvailable": True, "availableMemoryBytes": 1024},
            "rawEvidence": {name: H for name in ("machineId", "sshHostKey", "interfaces", "gpus")},
            "environmentEvidence": {name: H for name in ("cudaDriver", "torch", "availableMemory",
                                                           "architecture", "vllmNormalProfile",
                                                           "vllmBurstProfile")}}


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
    production = attestation(); staging = attestation("192.168.9.141", "d", "e", "GPU-two")
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


def test_ssh_fingerprint_is_openssh_sha256(monkeypatch):
    capture_path = ROOT / "flock-voice-engine/tools/capture_machine_attestation.py"
    capture_spec = importlib.util.spec_from_file_location("capture_machine", capture_path)
    capture = importlib.util.module_from_spec(capture_spec); capture_spec.loader.exec_module(capture)
    key_blob = b"binary-ed25519-key"
    public = b"ssh-ed25519 " + base64.b64encode(key_blob) + b" test\n"
    expected = "SHA256:" + base64.b64encode(hashlib.sha256(key_blob).digest()).decode().rstrip("=")
    assert capture.ssh_fingerprint(public) == expected


def test_capture_missing_privileged_host_key_fails(tmp_path):
    capture_path = ROOT / "flock-voice-engine/tools/capture_machine_attestation.py"
    capture_spec = importlib.util.spec_from_file_location("capture_machine_missing", capture_path)
    capture = importlib.util.module_from_spec(capture_spec); capture_spec.loader.exec_module(capture)
    normal = tmp_path / "normal"; burst = tmp_path / "burst"
    normal.write_text("{}"); burst.write_text("{}")
    with pytest.raises(capture.CaptureError, match="MACHINE_ATTESTATION_CAPTURE_FAILED"):
        capture.capture(tmp_path / "out.json", normal, burst,
                        machine_id_path=tmp_path / "machine-id",
                        ssh_key_path=tmp_path / "missing-host-key")


def test_capture_derives_identity_and_writes_hash_bound_raw_evidence(tmp_path, monkeypatch):
    capture_path = ROOT / "flock-voice-engine/tools/capture_machine_attestation.py"
    capture_spec = importlib.util.spec_from_file_location("capture_machine_positive", capture_path)
    capture = importlib.util.module_from_spec(capture_spec); capture_spec.loader.exec_module(capture)
    monkeypatch.setattr(capture.sys, "platform", "linux")
    monkeypatch.setattr(capture.platform, "machine", lambda: "aarch64")
    key_blob = b"real-key-material"
    files = {"machine": b"machine-one\n",
             "key": b"ssh-ed25519 " + base64.b64encode(key_blob) + b" host\n",
             "normal": b'[{"atMs":0,"latencyMs":1,"ok":true}]',
             "burst": b'[{"atMs":0,"latencyMs":2,"ok":true}]',
             "memory": b"MemAvailable: 1234 kB\n"}
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
    value = capture.capture(output, paths["normal"], paths["burst"], paths["machine"],
                            paths["key"], paths["memory"])
    assert value["canonicalInterfaceAddresses"] == ["192.168.9.141"]
    assert value["gpuUuids"] == ["GPU-z"]
    acceptance.validate_attestation_evidence(output, value)
    (output.with_suffix(".evidence") / "interfaces.json").write_bytes(b"[]")
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_attestation_evidence(output, value)
