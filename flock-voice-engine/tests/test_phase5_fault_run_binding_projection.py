from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_fault_run_binding_projection",
    TOOL,
)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
CHALLENGE = "1" * 64
CAPTURE_NONCE = "8" * 64
RAW_MANIFEST_SHA256 = "9" * 64


def full_binding() -> dict:
    return {
        "runId": RUN_ID,
        "challenge": CHALLENGE,
        "release": {
            "releaseManifestSha256": "2" * 64,
            "releaseRevision": "3" * 40,
            "sourceManifestSha256": "4" * 64,
            "audioArtifactSha256": "5" * 64,
        },
        "geometry": {
            "sampleRate": 44100,
            "blockFrames": 4096,
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
        "signerSpkiSha256": "6" * 64,
        "faultSessionEvidenceSha256": "7" * 64,
        "captureNonce": CAPTURE_NONCE,
        "rawManifestSha256": RAW_MANIFEST_SHA256,
    }


def assert_capture_binding_rejected(value: object) -> None:
    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_CAPTURE_PROOF_RUN_BINDING_INVALID$"):
        validator.phase5_fault_run_binding_projection(value)


def test_full_v2_binding_is_rejected_by_legacy_validator_until_projected():
    value = full_binding()

    with pytest.raises(
            validator.AcceptanceError,
            match=r"^EQUIVALENT_STAGING_REQUIRED$"):
        validator.validate_fault_session_binding(value)

    projected = validator.phase5_fault_run_binding_projection(value)
    validator.validate_fault_session_binding(projected)


def test_legacy_validator_rejects_dict_subclass_hiding_capture_fields():
    class HidingCaptureFields(dict):
        def __iter__(self):
            return iter(
                key
                for key in super().keys()
                if key not in {"captureNonce", "rawManifestSha256"}
            )

    with pytest.raises(
            validator.AcceptanceError,
            match=r"^EQUIVALENT_STAGING_REQUIRED$"):
        validator.validate_fault_session_binding(
            HidingCaptureFields(full_binding()))


def test_projection_returns_only_the_exact_legacy_seven_fields():
    value = full_binding()

    projected = validator.phase5_fault_run_binding_projection(value)

    assert set(projected) == validator.FAULT_SESSION_BINDING_FIELDS
    assert projected == {
        name: value[name]
        for name in (
            "runId",
            "challenge",
            "release",
            "geometry",
            "profile",
            "signerSpkiSha256",
            "faultSessionEvidenceSha256",
        )
    }
    assert "captureNonce" not in projected
    assert "rawManifestSha256" not in projected


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(hidden=True),
        lambda value: value.pop("captureNonce"),
        lambda value: value.pop("rawManifestSha256"),
        lambda value: value.update(captureNonce="8" * 63),
        lambda value: value.update(rawManifestSha256="9" * 65),
        lambda value: value.update(captureNonce=8),
        lambda value: value.update(rawManifestSha256=False),
        lambda value: value.update(captureNonce="A" * 64),
        lambda value: value.update(rawManifestSha256="g" * 64),
    ],
)
def test_projection_rejects_extra_missing_or_invalid_capture_fields(mutation):
    value = full_binding()
    mutation(value)

    assert_capture_binding_rejected(value)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(
            runId="123e4567-e89b-12d3-a456-426614174000"),
        lambda value: value.update(challenge="1" * 63),
        lambda value: value["release"].update(
            releaseManifestSha256="2" * 63),
        lambda value: value["release"].update(hidden=True),
        lambda value: value["geometry"].update(sampleRate=44100.0),
        lambda value: value["geometry"].update(poolSize=True),
        lambda value: value["profile"].update(clients=4.0),
        lambda value: value["profile"].update(durationMinutes=31),
        lambda value: value.update(signerSpkiSha256="6" * 63),
        lambda value: value.update(faultSessionEvidenceSha256=None),
    ],
)
def test_projection_revalidates_every_legacy_identity_and_contract(mutation):
    value = full_binding()
    mutation(value)

    assert_capture_binding_rejected(value)


def test_projection_is_a_deep_validator_owned_snapshot():
    source = full_binding()

    projected = validator.phase5_fault_run_binding_projection(source)
    source["runId"] = "ffffffff-ffff-4fff-afff-ffffffffffff"
    source["release"]["releaseRevision"] = "f" * 40
    source["geometry"]["rowVoices"][0] = "attacker"
    source["profile"]["speciesModel"] = "attacker"

    assert projected["runId"] == RUN_ID
    assert projected["release"]["releaseRevision"] == "3" * 40
    assert projected["geometry"]["rowVoices"] == [
        "bass", "pad", "lead", "pluck", "pad",
    ]
    assert projected["profile"]["speciesModel"] == "bird_agent"
    assert type(projected) is dict
    assert type(projected["release"]) is dict
    assert type(projected["geometry"]["rowVoices"]) is list


def test_projection_uses_one_canonical_snapshot_even_if_dict_proxy_mutates():
    class MutatingDictProxy(dict):
        def items(self):
            captured = list(super().items())
            super().__setitem__(
                "runId",
                "ffffffff-ffff-4fff-afff-ffffffffffff",
            )
            return iter(captured)

    source = MutatingDictProxy(full_binding())

    projected = validator.phase5_fault_run_binding_projection(source)

    assert source["runId"] == "ffffffff-ffff-4fff-afff-ffffffffffff"
    assert projected["runId"] == RUN_ID
    assert type(projected) is dict


def test_projection_maps_proxy_accessor_failure_to_stable_error():
    class FailingDictProxy(dict):
        def items(self):
            raise RuntimeError("attacker-controlled accessor")

    assert_capture_binding_rejected(FailingDictProxy(full_binding()))


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update({"captureNonce": float("nan")}),
        lambda value: value.update({1: "non-string-key"}),
        lambda value: value["geometry"].update(
            rowVoices=("bass", "pad", "lead", "pluck", object())),
    ],
)
def test_projection_fails_closed_at_the_python_canonical_boundary(mutation):
    value = full_binding()
    mutation(value)

    assert_capture_binding_rejected(value)


def test_projection_breaks_source_aliases_before_returning():
    value = full_binding()
    shared = value["release"]
    value["release"] = shared
    before = copy.deepcopy(value)

    projected = validator.phase5_fault_run_binding_projection(value)
    shared["releaseRevision"] = "f" * 40

    assert projected["release"] == before["release"]
    assert projected["release"] is not shared
