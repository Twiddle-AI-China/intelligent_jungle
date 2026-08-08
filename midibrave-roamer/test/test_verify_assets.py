from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from verify_assets import AssetVerificationError, verify_assets


class VerifyAssetsTest(unittest.TestCase):
    def test_complete_bundle_passes_and_tampered_checkpoint_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            models = root / "models"
            vendor = root / "vendor"
            calibration = root / "calibration"
            checkpoint = models / "voice.pt"
            config = vendor / "midibrave-v2" / "configs" / "voice.yaml"
            source = vendor / "midibrave-v2" / "src" / "midibrave" / "__init__.py"
            calibration_file = calibration / "voice.npy"
            for path, content in (
                (checkpoint, b"checkpoint"),
                (config, b"config"),
                (source, b"source"),
                (calibration_file, b"calibration"),
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            digest = lambda value: hashlib.sha256(value).hexdigest()
            manifest = root / "models.json"
            manifest.write_text(json.dumps({"models": [{
                "engine": "midibrave-v2",
                "checkpoint": {"filename": checkpoint.name, "bytes": 10, "sha256": digest(b"checkpoint")},
                "config": config.name,
                "configSha256": digest(b"config"),
                "calibration": calibration_file.name,
            }]}))

            self.assertEqual(len(verify_assets(manifest, models, vendor, calibration)), 3)
            checkpoint.write_bytes(b"tampered!!")
            with self.assertRaises(AssetVerificationError):
                verify_assets(manifest, models, vendor, calibration)


if __name__ == "__main__":
    unittest.main()
