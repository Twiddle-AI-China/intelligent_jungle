from __future__ import annotations

import copy
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_fault_boundary", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

fixture_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_fault_boundary", SUMMARY_TEST)
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)

VERIFIER_SOURCE_FILES = {
    "phase5-fault-verifier/verify-phase5-fault-evidence.mjs":
        ROOT / "flock-voice-engine/runtime/tools/"
        "verify-phase5-fault-evidence.mjs",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs":
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-evidence.mjs",
    "phase5-fault-verifier/lib/phase5-fault-validation.mjs":
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-validation.mjs",
    "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs":
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-transport-projection.mjs",
    "phase5-fault-verifier/lib/phase5-fault-semantics.mjs":
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-semantics.mjs",
}
SUMMARY_VERIFIER_FIELDS = {
    "phase5-fault-verifier/verify-phase5-fault-evidence.mjs":
        "verifyPhase5FaultEvidenceMjsSha256",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs":
        "phase5FaultEvidenceMjsSha256",
    "phase5-fault-verifier/lib/phase5-fault-validation.mjs":
        "phase5FaultValidationMjsSha256",
    "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs":
        "phase5FaultTransportProjectionMjsSha256",
    "phase5-fault-verifier/lib/phase5-fault-semantics.mjs":
        "phase5FaultSemanticsMjsSha256",
}


def verifier_identity() -> dict[str, str]:
    return {
        name: hashlib.sha256(path.read_bytes()).hexdigest()
        for name, path in VERIFIER_SOURCE_FILES.items()
    }


def bind_summary_verifier_identity(summary: dict) -> None:
    identity = verifier_identity()
    for deploy_name, summary_name in SUMMARY_VERIFIER_FIELDS.items():
        summary["acceptanceTool"][summary_name] = identity[deploy_name]


def test_validator_pins_exact_current_fault_verifier_closure():
    assert validator.PHASE5_FAULT_VERIFIER_PINNED_SHA256 == (
        verifier_identity()
    )


def test_summary_cannot_self_assert_a_replacement_verifier_identity():
    summary, _fault_raw, _run_binding = bound_summary()
    bind_summary_verifier_identity(summary)
    replaced = hashlib.sha256(b"attacker replacement verifier").hexdigest()
    summary["acceptanceTool"][
        "verifyPhase5FaultEvidenceMjsSha256"
    ] = replaced

    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_FAULT_VALIDATION_REQUIRED$"):
        validator._phase5_fault_verifier_identity_from_summary(summary)


def trusted_node_path() -> Path:
    discovered = shutil.which("node")
    assert discovered is not None
    return Path(discovered).resolve()


def copy_verifier_closure(root: Path) -> Path:
    for name, source in VERIFIER_SOURCE_FILES.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    return root / "phase5-fault-verifier/verify-phase5-fault-evidence.mjs"


def bound_summary() -> tuple[dict, bytes, dict]:
    summary = fixture.structurally_valid_summary()
    fault_raw = validator.canonical({
        "schemaVersion": 2,
        "kind": "test-fault-evidence-owned-by-node-verifier",
    })
    fault_sha = hashlib.sha256(fault_raw).hexdigest()
    summary["rawArtifacts"]["faultEventsSha256"] = fault_sha
    summary["faultValidation"]["evidence"]["faultEventsSha256"] = fault_sha
    run_binding = {
        "runId": summary["runId"],
        "challenge": summary["challenge"],
        "release": copy.deepcopy(summary["release"]),
        "geometry": copy.deepcopy(summary["geometry"]),
        "profile": copy.deepcopy(summary["profile"]),
        "signerSpkiSha256": summary["session"]["signerSpkiSha256"],
        "faultSessionEvidenceSha256":
            summary["session"]["faultSessionEvidenceSha256"],
    }
    return summary, fault_raw, run_binding


def verifier_returning(result: dict, seen: list | None = None):
    def run(verifier_path: Path, envelope: bytes) -> bytes:
        if seen is not None:
            seen.append((verifier_path, envelope))
        return validator.canonical(result) + b"\n"
    return run


def test_fault_boundary_passes_only_canonical_raw_through_exact_envelope():
    summary, fault_raw, run_binding = bound_summary()
    seen = []
    verifier_path = Path("trusted-verifier.mjs")

    result = validator._validate_phase5_summary_fault_boundary(
        summary,
        fault_raw,
        run_binding,
        include_client_projection=False,
        verifier_path=verifier_path,
        verifier_runner=verifier_returning(summary["faultValidation"], seen),
    )

    assert result == summary["faultValidation"]
    assert len(seen) == 1
    assert seen[0][0] == verifier_path
    assert seen[0][1] == validator.canonical({
        "evidence": validator.strict_json_bytes(
            fault_raw, "PHASE5_FAULT_VALIDATION_REQUIRED"),
        "runBinding": run_binding,
    }) + b"\n"


def test_fault_boundary_invokes_the_real_fixed_node_composite(monkeypatch):
    if shutil.which("node") is None:
        pytest.skip("node unavailable")
    fixture_url = (
        ROOT
        / "flock-voice-engine/runtime/test/tools/"
        "phase5-fault-validation-fixture.js"
    ).as_uri()
    validation_url = (
        ROOT
        / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-validation.mjs"
    ).as_uri()
    evidence_url = (
        ROOT
        / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-evidence.mjs"
    ).as_uri()
    script = f"""
import {{ signedFixture }} from {fixture_url!r};
import {{ validatePhase5FaultEvidence }} from {validation_url!r};
import {{ canonicalJson }} from {evidence_url!r};
const {{ evidence, runBinding }} = signedFixture();
const result = validatePhase5FaultEvidence(evidence, runBinding);
process.stdout.write(canonicalJson({{ evidence, runBinding, result }}));
"""
    generated = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    value = validator.strict_json_bytes(
        generated.stdout, "PHASE5_FAULT_VALIDATION_REQUIRED")
    fault_raw = validator.canonical(value["evidence"])
    fault_sha = hashlib.sha256(fault_raw).hexdigest()

    summary = fixture.structurally_valid_summary()
    result = value["result"]
    for name in ("runId", "challenge", "release", "geometry", "profile", "window"):
        summary[name] = copy.deepcopy(result[name])
    summary["session"] = {
        "signerSpkiSha256": result["signerSpkiSha256"],
        "faultSessionEvidenceSha256": result["faultSessionEvidenceSha256"],
    }
    summary["rawArtifacts"]["faultEventsSha256"] = fault_sha
    summary["faultValidation"] = copy.deepcopy(result)
    summary["acceptanceProjection"]["release"] = copy.deepcopy(result["release"])
    summary["acceptanceProjection"]["geometry"] = copy.deepcopy(result["geometry"])
    bind_summary_verifier_identity(summary)
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE", os.fspath(trusted_node_path()))

    assert validator.validate_phase5_summary_fault_boundary(
        summary,
        fault_raw,
        value["runBinding"],
    ) == result


def test_fixed_node_memory_runner_returns_owned_signed_client_projection(
        monkeypatch):
    if shutil.which("node") is None:
        pytest.skip("node unavailable")
    fixture_url = (
        ROOT
        / "flock-voice-engine/runtime/test/tools/"
        "phase5-fault-validation-fixture.js"
    ).as_uri()
    validation_url = (
        ROOT
        / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-validation.mjs"
    ).as_uri()
    evidence_url = (
        ROOT
        / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-evidence.mjs"
    ).as_uri()
    script = f"""
import {{ signedFixture }} from {fixture_url!r};
import {{
  validatePhase5FaultEvidenceWithClientProjection,
}} from {validation_url!r};
import {{ canonicalJson }} from {evidence_url!r};
const {{ evidence, runBinding }} = signedFixture();
const expected = validatePhase5FaultEvidenceWithClientProjection(
  evidence,
  runBinding,
);
process.stdout.write(canonicalJson({{ evidence, runBinding, expected }}));
"""
    generated = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    fixture_value = validator.strict_json_bytes(
        generated.stdout,
        "PHASE5_FAULT_VALIDATION_REQUIRED",
    )
    envelope = validator.canonical({
        "evidence": fixture_value["evidence"],
        "runBinding": fixture_value["runBinding"],
    }) + b"\n"

    result_raw = validator._run_phase5_fault_verifier(
        validator.phase5_fault_verifier_path(),
        envelope,
        verifier_identity(),
        trusted_node_path(),
        include_client_projection=True,
    )
    result = validator.strict_json_bytes(
        result_raw[:-1],
        "PHASE5_FAULT_VALIDATION_REQUIRED",
    )

    assert result == fixture_value["expected"]
    binding = {
        name: copy.deepcopy(fixture_value["runBinding"][name])
        for name in (
            "runId", "challenge", "release", "geometry", "profile",
        )
    }
    owned = validator._phase5_client_signed_transport_projection(
        result["signedTransportProjection"],
        binding,
        result["faultValidation"]["window"],
        "PHASE5_FAULT_VALIDATION_REQUIRED",
    )
    assert owned["kind"] == (
        "phase5-client-observations-signed-transport-projection")
    assert len(owned["runtimeOpens"]) == 6
    assert len(owned["audioLifecycle"]) == 4
    assert len(owned["discontinuities"]) == 8

    fault_raw = validator.canonical(fixture_value["evidence"])
    fault_sha = hashlib.sha256(fault_raw).hexdigest()
    summary = fixture.structurally_valid_summary()
    fault_validation = result["faultValidation"]
    for name in (
            "runId", "challenge", "release", "geometry", "profile",
            "window"):
        summary[name] = copy.deepcopy(fault_validation[name])
    summary["session"] = {
        "signerSpkiSha256":
            fault_validation["signerSpkiSha256"],
        "faultSessionEvidenceSha256":
            fault_validation["faultSessionEvidenceSha256"],
    }
    summary["rawArtifacts"]["faultEventsSha256"] = fault_sha
    summary["faultValidation"] = copy.deepcopy(fault_validation)
    summary["acceptanceProjection"]["release"] = copy.deepcopy(
        fault_validation["release"])
    summary["acceptanceProjection"]["geometry"] = copy.deepcopy(
        fault_validation["geometry"])
    bind_summary_verifier_identity(summary)
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE", os.fspath(trusted_node_path()))

    boundary_result = (
        validator.validate_phase5_summary_fault_projection_boundary(
            summary,
            fault_raw,
            fixture_value["runBinding"],
        )
    )
    assert boundary_result == result


def test_fixed_node_memory_runner_rejects_non_boolean_projection_mode(
        monkeypatch):
    called = []
    monkeypatch.setattr(
        validator,
        "_phase5_fault_verifier_snapshots",
        lambda *_args, **_kwargs: called.append(True),
    )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._run_phase5_fault_verifier(
            Path("unused-verifier.mjs"),
            b"{}\n",
            {},
            include_client_projection=1,
        )

    assert called == []


@pytest.mark.parametrize("raw", [
    b'{"kind":"test-fault-evidence-owned-by-node-verifier","schemaVersion":2}\n',
    b'{"schemaVersion":2,"kind":"test-fault-evidence-owned-by-node-verifier"}',
    b'{"schemaVersion":2,"schemaVersion":2,'
    b'"kind":"test-fault-evidence-owned-by-node-verifier"}',
    b"\xff",
])
def test_fault_boundary_rejects_noncanonical_fault_raw_before_verifier(raw):
    summary, _fault_raw, run_binding = bound_summary()
    called = []

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._validate_phase5_summary_fault_boundary(
            summary,
            raw,
            run_binding,
            include_client_projection=False,
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=verifier_returning(
                summary["faultValidation"], called),
        )

    assert called == []


@pytest.mark.parametrize("suffix", [b"", b"\n\n", b"hidden", b" \n"])
def test_fault_boundary_rejects_noncanonical_or_partial_verifier_stdout(suffix):
    summary, fault_raw, run_binding = bound_summary()

    def run(_path, _envelope):
        return validator.canonical(summary["faultValidation"]) + suffix

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._validate_phase5_summary_fault_boundary(
            summary,
            fault_raw,
            run_binding,
            include_client_projection=False,
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=run,
        )


def test_fault_boundary_maps_verifier_failure_without_accepting_partial_output():
    summary, fault_raw, run_binding = bound_summary()

    def run(_path, _envelope):
        raise RuntimeError("attacker-controlled verifier detail")

    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_FAULT_VALIDATION_REQUIRED$"):
        validator._validate_phase5_summary_fault_boundary(
            summary,
            fault_raw,
            run_binding,
            include_client_projection=False,
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=run,
        )


def test_fault_boundary_requires_canonical_byte_equality_not_python_numeric_equality():
    summary, fault_raw, run_binding = bound_summary()
    rebound = copy.deepcopy(summary["faultValidation"])
    rebound["evidence"]["scenarioEventCount"] = 35.0
    assert rebound == summary["faultValidation"]
    assert validator.canonical(rebound) != validator.canonical(
        summary["faultValidation"])

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._validate_phase5_summary_fault_boundary(
            summary,
            fault_raw,
            run_binding,
            include_client_projection=False,
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=verifier_returning(rebound),
        )


@pytest.mark.parametrize("linked_parent", [False, True])
def test_default_fault_verifier_runner_rejects_leaf_and_parent_symlinks(
        tmp_path, monkeypatch, linked_parent):
    real_root = tmp_path / "real"
    real_verifier = copy_verifier_closure(real_root)
    try:
        if linked_parent:
            candidate_root = tmp_path / "candidate"
            candidate_root.mkdir()
            candidate_parent = candidate_root / "phase5-fault-verifier"
            os.symlink(
                real_root / "phase5-fault-verifier",
                candidate_parent,
                target_is_directory=True,
            )
            candidate = candidate_parent / real_verifier.name
        else:
            candidate = real_verifier
            external = tmp_path / "external-verifier.mjs"
            candidate.replace(external)
            real_verifier = external
            os.symlink(real_verifier, candidate)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")

    called = []
    monkeypatch.setattr(
        validator.subprocess,
        "run",
        lambda *args, **kwargs: called.append((args, kwargs)),
    )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._run_phase5_fault_verifier(
            candidate, b"{}\n", verifier_identity())

    assert called == []


def test_default_fault_verifier_runner_rejects_symlinked_import_dependency(
        tmp_path, monkeypatch):
    entry = copy_verifier_closure(tmp_path)
    dependency = (
        entry.parent / "lib" / "phase5-fault-semantics.mjs")
    external = tmp_path / "external-semantics.mjs"
    dependency.replace(external)
    try:
        os.symlink(external, dependency)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")
    called = []
    monkeypatch.setattr(
        validator.subprocess,
        "run",
        lambda *args, **kwargs: called.append((args, kwargs)),
    )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._run_phase5_fault_verifier(
            entry, b"{}\n", verifier_identity())

    assert called == []


def test_default_fault_verifier_executes_verified_snapshots_not_mutable_paths(
        tmp_path, monkeypatch):
    entry = copy_verifier_closure(tmp_path)
    trusted_entry = entry.read_bytes()
    node_path = trusted_node_path()
    calls = []
    monkeypatch.setenv(
        "NODE_OPTIONS",
        "--import=file:///attacker-controlled-preload.mjs",
    )
    monkeypatch.setenv("NODE_PATH", os.fspath(tmp_path / "attacker-modules"))
    monkeypatch.setenv("LD_PRELOAD", os.fspath(tmp_path / "attacker.so"))
    monkeypatch.setenv(
        "LD_LIBRARY_PATH", os.fspath(tmp_path / "attacker-libraries"))
    monkeypatch.setenv(
        "DYLD_INSERT_LIBRARIES", os.fspath(tmp_path / "attacker.dylib"))
    monkeypatch.setenv(
        "DYLD_LIBRARY_PATH", os.fspath(tmp_path / "attacker-libraries"))
    monkeypatch.setenv("PATH", os.fspath(tmp_path / "attacker-bin"))

    def run(*args, **kwargs):
        entry.write_bytes(b"malicious entry")
        package = json.loads(kwargs["input"])
        calls.append((args, kwargs, package))
        entry.write_bytes(trusted_entry)
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout=b"{}\n", stderr=b"")

    monkeypatch.setattr(validator.subprocess, "run", run)

    assert validator._run_phase5_fault_verifier(
        entry,
        b"{}\n",
        verifier_identity(),
        node_path,
    ) == b"{}\n"
    assert len(calls) == 1
    assert calls[0][2]["schemaVersion"] == 2
    assert calls[0][2]["operation"] == "fault-validation"
    assert base64.b64decode(calls[0][2]["modules"][
        "phase5-fault-verifier/verify-phase5-fault-evidence.mjs"
    ], validate=True) == trusted_entry
    assert all(
        os.fspath(entry) not in str(argument)
        for argument in calls[0][0][0]
    )
    child_environment = calls[0][1]["env"]
    expected_environment = {}
    if os.name == "nt" and os.environ.get("SystemRoot"):
        expected_environment["SystemRoot"] = os.environ["SystemRoot"]
    assert child_environment == expected_environment


def test_default_fault_verifier_executes_posix_node_from_same_verified_fd(
        tmp_path, monkeypatch):
    entry = copy_verifier_closure(tmp_path)
    node_path = tmp_path / "approved-node"
    replaced_path = tmp_path / "approved-node.replaced"
    attacker_path = tmp_path / "attacker-node"
    trusted_node = b"trusted node executable"
    node_path.write_bytes(trusted_node)
    attacker_path.write_bytes(b"attacker node executable")
    monkeypatch.setattr(sys, "platform", "linux")
    calls = []

    def run(arguments, **kwargs):
        descriptor_path = arguments[0]
        assert descriptor_path.startswith("/proc/self/fd/")
        descriptor = int(descriptor_path.rsplit("/", 1)[1])
        assert kwargs["pass_fds"] == (descriptor,)
        try:
            node_path.replace(replaced_path)
            attacker_path.replace(node_path)
        except PermissionError:
            # Windows locks an open executable descriptor; that also prevents
            # the pathname swap while this forced-POSIX unit probe is active.
            pass
        os.lseek(descriptor, 0, os.SEEK_SET)
        assert os.read(descriptor, len(trusted_node) + 1) == trusted_node
        calls.append((arguments, kwargs))
        return subprocess.CompletedProcess(
            args=arguments, returncode=0, stdout=b"{}\n", stderr=b"")

    monkeypatch.setattr(validator.subprocess, "run", run)

    assert validator._run_phase5_fault_verifier(
        entry,
        b"{}\n",
        verifier_identity(),
        node_path,
    ) == b"{}\n"
    assert len(calls) == 1


@pytest.mark.parametrize("mutation", [
    lambda value: value.pop(
        "phase5-fault-verifier/lib/phase5-fault-semantics.mjs"),
    lambda value: value.update({
        "phase5-fault-verifier/lib/phase5-fault-semantics.mjs": "f" * 64,
    }),
])
def test_default_fault_verifier_requires_trusted_exact_module_digests(
        tmp_path, monkeypatch, mutation):
    entry = copy_verifier_closure(tmp_path)
    identity = verifier_identity()
    mutation(identity)
    called = []
    monkeypatch.setattr(
        validator.subprocess,
        "run",
        lambda *args, **kwargs: called.append((args, kwargs)),
    )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._run_phase5_fault_verifier(
            entry,
            b"{}\n",
            identity,
            trusted_node_path(),
        )

    assert called == []


def test_fault_boundary_requires_summary_owned_exact_verifier_identity(
        monkeypatch):
    summary, fault_raw, run_binding = bound_summary()
    monkeypatch.setenv(
        "PHASE5_APPROVED_NODE_EXE", os.fspath(trusted_node_path()))

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator.validate_phase5_summary_fault_boundary(
            summary,
            fault_raw,
            run_binding,
        )


def test_injected_timeout_maps_to_stable_fault_validation_error():
    summary, fault_raw, run_binding = bound_summary()

    def run(_path, _envelope):
        raise subprocess.TimeoutExpired(["node"], 30)

    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_FAULT_VALIDATION_REQUIRED$"):
        validator._validate_phase5_summary_fault_boundary(
            summary,
            fault_raw,
            run_binding,
            include_client_projection=False,
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=run,
        )


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(
        runId="ffffffff-ffff-4fff-afff-ffffffffffff"),
    lambda value: value.update(challenge="f" * 64),
    lambda value: value["release"].update(releaseManifestSha256="f" * 64),
    lambda value: value["geometry"].update(sampleRate=48_000),
    lambda value: value["profile"].update(durationMinutes=31),
    lambda value: value["window"].update(
        startedAtMonotonicMs=2_000, endedAtMonotonicMs=1_802_000),
    lambda value: value["session"].update(signerSpkiSha256="f" * 64),
    lambda value: value["session"].update(
        faultSessionEvidenceSha256="f" * 64),
    lambda value: value["rawArtifacts"].update(faultEventsSha256="f" * 64),
    lambda value: value["faultValidation"]["evidence"].update(
        projectedStateCount=22),
])
def test_fault_boundary_rejects_each_summary_or_result_rebind(mutation):
    summary, fault_raw, run_binding = bound_summary()
    trusted_result = copy.deepcopy(summary["faultValidation"])
    mutation(summary)

    with pytest.raises(validator.AcceptanceError):
        validator._validate_phase5_summary_fault_boundary(
            summary,
            fault_raw,
            run_binding,
            include_client_projection=False,
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=verifier_returning(trusted_result),
        )


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(runId="ffffffff-ffff-4fff-afff-ffffffffffff"),
    lambda value: value.update(challenge="f" * 64),
    lambda value: value["release"].update(releaseManifestSha256="f" * 64),
    lambda value: value["geometry"].update(sampleRate=48_000),
    lambda value: value["profile"].update(durationMinutes=31),
    lambda value: value.update(signerSpkiSha256="f" * 64),
    lambda value: value.update(faultSessionEvidenceSha256="f" * 64),
    lambda value: value.update(hidden=True),
])
def test_fault_boundary_rejects_untrusted_run_binding_before_verifier(mutation):
    summary, fault_raw, run_binding = bound_summary()
    mutation(run_binding)
    called = []

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_FAULT_VALIDATION_REQUIRED"):
        validator._validate_phase5_summary_fault_boundary(
            summary,
            fault_raw,
            run_binding,
            include_client_projection=False,
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=verifier_returning(
                summary["faultValidation"], called),
        )

    assert called == []
