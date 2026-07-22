from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from server.release_info import PROTOCOL_FAMILY, PROTOCOL_VERSION, ReleaseInfo


def test_defaults_describe_current_phase_zero_ownership() -> None:
    with patch.dict(os.environ, {}, clear=True):
        info = ReleaseInfo.from_env()
    assert info.release_revision == "unknown"
    assert info.source_manifest_sha256 == "unknown"
    assert info.protocol_family == "legacy-decoder" == PROTOCOL_FAMILY
    assert info.protocol_version == 1 == PROTOCOL_VERSION
    assert info.runtime_owner == "browser"
    assert info.audio_owner == "legacy"


def test_reads_full_git_revision_with_phase_zero_owners() -> None:
    revision = "3cf686eb1dd2ed356594904e2f366805ae7dd11a"
    manifest_sha256 = "a" * 64
    with patch.dict(os.environ, {
        "FLOCK_BUILD_REVISION": revision,
        "FLOCK_SOURCE_MANIFEST_SHA256": manifest_sha256,
        "FLOCK_RUNTIME_OWNER": "browser",
        "FLOCK_AUDIO_OWNER": "legacy",
    }, clear=True):
        info = ReleaseInfo.from_env()
    assert info.as_payload() == {
        "releaseRevision": revision,
        "sourceManifestSha256": manifest_sha256,
        "protocolFamily": "legacy-decoder",
        "protocolVersion": 1,
        "runtimeOwner": "browser",
        "audioOwner": "legacy",
    }


@pytest.mark.parametrize("name,value", [
    ("FLOCK_BUILD_REVISION", "not-a-git-sha"),
    ("FLOCK_SOURCE_MANIFEST_SHA256", "not-a-sha256"),
    ("FLOCK_RUNTIME_OWNER", "server"),
    ("FLOCK_AUDIO_OWNER", "world"),
])
def test_rejects_invalid_release_identity(name: str, value: str) -> None:
    with patch.dict(os.environ, {name: value}, clear=True):
        with pytest.raises(ValueError):
            ReleaseInfo.from_env()


def test_revision_and_manifest_must_be_declared_together() -> None:
    with patch.dict(os.environ, {"FLOCK_BUILD_REVISION": "b" * 40}, clear=True):
        with pytest.raises(ValueError):
            ReleaseInfo.from_env()
