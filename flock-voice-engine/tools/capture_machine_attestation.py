#!/usr/bin/env python3
"""Capture machine identity from kernel/host evidence; never accepts claimed identity."""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import socket
import subprocess
import sys
import platform
import shutil
from pathlib import Path

try:
    from validate_phase5_acceptance import (
        AcceptanceError,
        canonical,
        canonical_machine_addresses,
        fault_session_binding_from_bytes,
        memory_class_bytes,
        parse_meminfo_bytes,
        read_regular_file_no_follow,
    )
except ModuleNotFoundError:  # importlib-based unit loading does not add this directory to sys.path
    _spec = importlib.util.spec_from_file_location(
        "validate_phase5_acceptance", Path(__file__).with_name("validate_phase5_acceptance.py"))
    _validator = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_validator)
    canonical = _validator.canonical
    canonical_machine_addresses = _validator.canonical_machine_addresses
    fault_session_binding_from_bytes = _validator.fault_session_binding_from_bytes
    memory_class_bytes = _validator.memory_class_bytes
    parse_meminfo_bytes = _validator.parse_meminfo_bytes
    read_regular_file_no_follow = _validator.read_regular_file_no_follow
    AcceptanceError = _validator.AcceptanceError


CANDIDATE_RUN_ROOT = Path("/run/flock-phase5-candidate")
FAULT_SESSION_ATTESTATION_NAME = "phase5-fault-session-attestation.json"


class CaptureError(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def command_bytes(args: list[str]) -> bytes:
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def ssh_fingerprint(public_key: bytes) -> str:
    try:
        parts = public_key.strip().split()
        if parts[0] != b"ssh-ed25519":
            raise ValueError
        decoded = base64.b64decode(parts[1], validate=True)
    except (IndexError, ValueError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    return "SHA256:" + base64.b64encode(hashlib.sha256(decoded).digest()).decode().rstrip("=")


def interface_addresses(raw: bytes) -> list[str]:
    try:
        records = json.loads(raw)
        addresses = [item["local"] for interface in records
                     for item in interface.get("addr_info", []) if "local" in item]
    except (UnicodeError, json.JSONDecodeError, TypeError, KeyError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    return canonical_machine_addresses(addresses)


def load_fault_session_attestation(attestation_role: str,
                                   path: Path | None = None) -> tuple[bytes | None, dict | None]:
    if attestation_role not in {"production-baseline", "staging-phase5"}:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    if attestation_role == "production-baseline":
        if path is not None:
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        return None, None
    if path is not None:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    session_path = CANDIDATE_RUN_ROOT / FAULT_SESSION_ATTESTATION_NAME
    try:
        raw = read_regular_file_no_follow(
            session_path, "EQUIVALENT_STAGING_REQUIRED")
        binding = fault_session_binding_from_bytes(raw)
    except (OSError, PermissionError, AcceptanceError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    return raw, binding


def capture(output: Path, normal_profile: Path, burst_profile: Path,
            machine_id_path: Path = Path("/etc/machine-id"),
            ssh_key_path: Path = Path("/etc/ssh/ssh_host_ed25519_key.pub"),
            memory_path: Path = Path("/proc/meminfo"), *,
            attestation_role: str = "production-baseline",
            fault_session_attestation_path: Path | None = None) -> dict:
    evidence_dir = output.with_suffix(".evidence")
    transaction_marker = evidence_dir / ".capture-transaction.json"
    if (not output.exists() and transaction_marker.is_file()
            and transaction_marker.read_bytes() == canonical({
                "schemaVersion": 1, "output": output.name})):
        shutil.rmtree(evidence_dir)
    if output.exists():
        raise CaptureError("MACHINE_ATTESTATION_OUTPUT_EXISTS")
    if evidence_dir.exists():
        raise CaptureError("MACHINE_ATTESTATION_OUTPUT_EXISTS")
    fault_session_raw, run_binding = load_fault_session_attestation(
        attestation_role, fault_session_attestation_path)
    if os.name != "posix" or not sys.platform.startswith("linux"):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    try:
        machine = machine_id_path.read_bytes()
        ssh_key = ssh_key_path.read_bytes()
        normal = normal_profile.read_bytes()
        burst = burst_profile.read_bytes()
    except (OSError, PermissionError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    interfaces = command_bytes(["ip", "-j", "address", "show"])
    gpus = command_bytes(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"])
    cuda_driver = command_bytes(["nvidia-smi", "--query-gpu=driver_version,name,memory.total",
                                 "--format=csv,noheader"])
    torch = command_bytes(["python3", "-c", "import json,torch; print(json.dumps({"
                           "'version':torch.__version__,'cuda':torch.version.cuda,"
                           "'available':torch.cuda.is_available()}))"])
    try:
        memory = memory_path.read_bytes()
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    gpu_uuids = sorted(set(line.strip() for line in gpus.decode().splitlines() if line.strip()))
    addresses = interface_addresses(interfaces)
    if not gpu_uuids or not addresses:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    try:
        driver_version, gpu_model, _gpu_memory = [item.strip()
            for item in cuda_driver.decode().splitlines()[0].split(",", 2)]
        torch_value = json.loads(torch)
        total_memory_bytes, available_memory_bytes = parse_meminfo_bytes(memory)
        architecture = platform.machine().lower()
        if (not driver_version or not gpu_model or torch_value.get("available") is not True
                or not isinstance(torch_value.get("version"), str)
                or not isinstance(torch_value.get("cuda"), str)
                or architecture not in {"aarch64", "arm64"} or available_memory_bytes <= 0):
            raise ValueError
        stable_memory_class_bytes = memory_class_bytes(total_memory_bytes)
    except (UnicodeError, json.JSONDecodeError, StopIteration, ValueError, IndexError, KeyError,
            AcceptanceError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    blobs = {"machine-id": machine, "ssh-host-ed25519.pub": ssh_key,
             "interfaces.json": interfaces, "gpus.txt": gpus,
             "cuda-driver.txt": cuda_driver, "torch.json": torch,
             "available-memory.txt": memory, "vllm-normal-profile.json": normal,
             "vllm-burst-profile.json": burst,
             "architecture.txt": (architecture + "\n").encode()}
    if fault_session_raw is not None:
        blobs["fault-session-attestation.json"] = fault_session_raw
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_evidence = output.parent / f".{evidence_dir.name}-{os.getpid()}"
    temporary_output = output.parent / f".{output.name}-{os.getpid()}"
    if temporary_evidence.exists() or temporary_output.exists():
        raise CaptureError("MACHINE_ATTESTATION_OUTPUT_EXISTS")
    temporary_evidence.mkdir(mode=0o700)
    try:
        (temporary_evidence / ".capture-transaction.json").write_bytes(canonical({
            "schemaVersion": 1, "output": output.name}))
        for name, body in blobs.items():
            (temporary_evidence / name).write_bytes(body)
        value = {
            "schemaVersion": 2,
            "attestationRole": attestation_role,
            "runBinding": run_binding,
            "hostname": socket.gethostname(),
            "machineIdSha256": digest(machine),
            "sshHostKeySha256": ssh_fingerprint(ssh_key),
            "canonicalInterfaceAddresses": addresses,
            "gpuUuids": gpu_uuids,
            "platform": {"architecture": "aarch64" if architecture == "arm64" else architecture,
                          "gpuModel": gpu_model, "driverVersion": driver_version,
                          "torchVersion": torch_value["version"], "cudaVersion": torch_value["cuda"],
                          "cudaAvailable": True, "availableMemoryBytes": available_memory_bytes,
                          "totalMemoryBytes": total_memory_bytes,
                          "memoryClassBytes": stable_memory_class_bytes},
            "rawEvidence": {"machineId": digest(machine), "sshHostKey": digest(ssh_key),
                            "interfaces": digest(interfaces), "gpus": digest(gpus)},
            "environmentEvidence": {"cudaDriver": digest(cuda_driver), "torch": digest(torch),
                                    "availableMemory": digest(memory),
                                    "architecture": digest(blobs["architecture.txt"]),
                                    "vllmNormalProfile": digest(normal),
                                    "vllmBurstProfile": digest(burst)},
        }
        temporary_output.write_bytes(canonical(value))
        os.replace(temporary_evidence, evidence_dir)
        os.replace(temporary_output, output)
        transaction_marker.unlink()
        return value
    except OSError as exc:
        shutil.rmtree(temporary_evidence, ignore_errors=True)
        shutil.rmtree(evidence_dir, ignore_errors=True)
        temporary_output.unlink(missing_ok=True)
        output.unlink(missing_ok=True)
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--vllm-normal-profile", required=True, type=Path)
    parser.add_argument("--vllm-burst-profile", required=True, type=Path)
    parser.add_argument("--attestation-role",
                        choices=("production-baseline", "staging-phase5"),
                        default="production-baseline")
    parser.add_argument("--fault-session-attestation", type=Path)
    args = parser.parse_args()
    try:
        capture(args.output.resolve(), args.vllm_normal_profile.resolve(),
                args.vllm_burst_profile.resolve(),
                attestation_role=args.attestation_role,
                fault_session_attestation_path=(
                    args.fault_session_attestation.resolve()
                    if args.fault_session_attestation is not None else None))
    except CaptureError as exc:
        print(str(exc))
        return 2
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
