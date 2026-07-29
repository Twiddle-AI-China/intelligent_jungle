from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest


ENGINE = Path(__file__).resolve().parents[1]
TOOL = ENGINE / "tools/validate_phase5_acceptance.py"
NODE = shutil.which("node")

validator_spec = importlib.util.spec_from_file_location(
    "phase5_species_raw_recorder_cross_runtime",
    TOOL,
)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

EXPECTED_BINDING = {
    "runId": "12345678-1234-4234-8234-123456789abc",
    "challenge": "a" * 64,
    "release": {
        "releaseManifestSha256": "b" * 64,
        "releaseRevision": "c" * 40,
        "sourceManifestSha256": "d" * 64,
        "audioArtifactSha256": "e" * 64,
    },
    "geometry": {
        "sampleRate": 44_100,
        "blockFrames": 4_096,
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
}

NODE_HARNESS = r"""
import {
  createPhase5SpeciesRawRecorder,
} from './runtime/tools/lib/phase5-species-raw-recorder.mjs';

const mode = process.argv.at(-1);
const binding = {
  runId: '12345678-1234-4234-8234-123456789abc',
  challenge: 'a'.repeat(64),
  release: {
    releaseManifestSha256: 'b'.repeat(64),
    releaseRevision: 'c'.repeat(40),
    sourceManifestSha256: 'd'.repeat(64),
    audioArtifactSha256: 'e'.repeat(64),
  },
  geometry: {
    sampleRate: 44_100,
    blockFrames: 4_096,
    poolSize: 5,
    rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'],
  },
  profile: {
    clients: 4,
    slowClient: 4,
    durationMinutes: 30,
    speciesEndpoint: 'http://127.0.0.1:8081/v1',
    speciesModel: 'bird_agent',
  },
};
const window = {
  startedAtMonotonicMs: 1_000,
  endedAtMonotonicMs: 1_801_000,
  startedAtUnixMs: 1_700_000_000_000,
  endedAtUnixMs: 1_700_001_800_000,
};
const responseBytes = Buffer.from(
  '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}',
);
const clock = {
  monotonicMs: window.startedAtMonotonicMs + 1,
  unixMs: window.startedAtUnixMs + 1,
};
const recorder = createPhase5SpeciesRawRecorder({
  mode,
  binding,
  window,
  monotonicNow: () => clock.monotonicMs,
  unixNow: () => clock.unixMs,
  timeoutSignalFactory: () => new AbortController().signal,
  fetchImpl: async () => {
    const started = { ...clock };
    let delivered = false;
    return {
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            clock.monotonicMs = started.monotonicMs + 100;
            clock.unixMs = started.unixMs + 100;
            return { done: false, value: responseBytes };
          },
          async cancel() {},
          releaseLock() {},
        }),
      },
      arrayBuffer: async () => {
        throw new Error('bounded stream must be preferred');
      },
    };
  },
});
const batches = mode === 'normal' ? 855 : 171;
const finalStartedRelative = mode === 'normal' ? 1_790_000 : 1_750_000;
for (let index = 0; index < batches; index += 1) {
  const relative = 1 + Math.floor(
    index * (finalStartedRelative - 1) / (batches - 1),
  );
  clock.monotonicMs = window.startedAtMonotonicMs + relative;
  clock.unixMs = window.startedAtUnixMs + relative;
  await recorder.dispatchBatch();
}
process.stdout.write(recorder.finalizeAcceptedBytes());
"""


@pytest.mark.skipif(NODE is None, reason="node is required")
@pytest.mark.parametrize(
    ("mode", "expected_requests"),
    [("normal", 855), ("burst", 684)],
)
def test_node_recorder_bytes_pass_python_v2_validator(
        mode: str,
        expected_requests: int) -> None:
    completed = subprocess.run(
        [NODE, "--input-type=module", "-e", NODE_HARNESS, mode],
        cwd=ENGINE,
        check=True,
        capture_output=True,
        timeout=30,
    )

    result = validator.validate_phase5_species_load_samples_bytes(
        completed.stdout,
        EXPECTED_BINDING,
        mode,
    )

    assert result["requestCount"] == expected_requests
    assert result["errors"] == 0
    assert result["value"]["profile"] == EXPECTED_BINDING["profile"]
