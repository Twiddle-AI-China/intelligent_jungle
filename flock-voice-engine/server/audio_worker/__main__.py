"""生产 worker entry；禁止导入 legacy app。"""
from __future__ import annotations

import sys
from pathlib import Path

from server.audio_worker.identity import load_trusted_release_manifest, load_verified_asset_bundle, load_worker_identity
from server.audio_worker.ipc_server import IpcServer, IpcServerError
from server.audio_worker.model_host import ModelHost
from server.audio_worker.worker import AudioWorker
from server.config import EngineConfig


def main() -> int:
    identity_path = Path("/release/audio-identity.json")
    manifest_path = Path("/release/audio-artifact-manifest.json")
    asset_bundle = None
    try:
        identity = load_worker_identity(identity_path, manifest_path)
        release = load_trusted_release_manifest(
            Path("/release/release-manifest.json"), Path("/release/release-manifest.json.sha256"), identity,
        )
        asset_bundle = load_verified_asset_bundle(identity_path, manifest_path, expected_identity=identity)
        if asset_bundle.manifest_sha256 != identity["audioArtifactSha256"]:
            raise RuntimeError("AUDIO_IDENTITY_BUNDLE_MISMATCH")
        geometry = release["geometry"]
        config = EngineConfig(sample_rate=geometry["sampleRate"], block_samples=geometry["blockFrames"],
                              pool_size=geometry["poolSize"], backend="brave-voices", device="cuda")
        model_host = ModelHost(config, geometry, asset_bundle=asset_bundle)
        server = IpcServer("/run/flock-audio/audio.sock", identity)
        AudioWorker(server, model_host, identity_path, manifest_path, identity=identity).run()
    except (RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    finally:
        if asset_bundle is not None:
            asset_bundle.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
