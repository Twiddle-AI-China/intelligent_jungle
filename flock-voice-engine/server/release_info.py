from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Mapping

PROTOCOL_FAMILY = "legacy-decoder"
PROTOCOL_VERSION = 1
_GIT_SHA = re.compile(r"[0-9a-f]{40}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
RUNTIME_OWNER = "browser"
AUDIO_OWNER = "legacy"


@dataclass(frozen=True)
class ReleaseInfo:
    release_revision: str
    source_manifest_sha256: str
    protocol_family: str
    protocol_version: int
    runtime_owner: str
    audio_owner: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ReleaseInfo":
        source = os.environ if env is None else env
        revision = source.get("FLOCK_BUILD_REVISION", "unknown").strip()
        manifest_sha256 = source.get("FLOCK_SOURCE_MANIFEST_SHA256", "unknown").strip()
        runtime_owner = source.get("FLOCK_RUNTIME_OWNER", "browser").strip()
        audio_owner = source.get("FLOCK_AUDIO_OWNER", "legacy").strip()
        if revision != "unknown" and _GIT_SHA.fullmatch(revision) is None:
            raise ValueError("FLOCK_BUILD_REVISION 必须是完整 40 位小写 Git SHA")
        if manifest_sha256 != "unknown" and _SHA256.fullmatch(manifest_sha256) is None:
            raise ValueError("FLOCK_SOURCE_MANIFEST_SHA256 必须是 64 位小写 SHA-256")
        if (revision == "unknown") != (manifest_sha256 == "unknown"):
            raise ValueError("release revision 与 source manifest 必须同时已知或同时 unknown")
        if (runtime_owner, audio_owner) != (RUNTIME_OWNER, AUDIO_OWNER):
            raise ValueError(
                "legacy-decoder 在 Phase 0–4 只能声明 runtimeOwner=browser/audioOwner=legacy"
            )
        return cls(
            revision,
            manifest_sha256,
            PROTOCOL_FAMILY,
            PROTOCOL_VERSION,
            runtime_owner,
            audio_owner,
        )

    def as_payload(self) -> dict[str, str | int]:
        return {
            "releaseRevision": self.release_revision,
            "sourceManifestSha256": self.source_manifest_sha256,
            "protocolFamily": self.protocol_family,
            "protocolVersion": self.protocol_version,
            "runtimeOwner": self.runtime_owner,
            "audioOwner": self.audio_owner,
        }
