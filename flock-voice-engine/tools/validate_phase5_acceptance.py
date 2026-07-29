#!/usr/bin/env python3
"""Fail-closed validator for Phase 5 equivalent-host acceptance evidence."""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import ipaddress
import json
import math
import os
import posixpath
import re
import stat
import subprocess
import sys
from pathlib import Path

HEX = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
SSH_FINGERPRINT = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
JS_MAX_SAFE_INTEGER = 9007199254740991
PHASE5_WINDOW_DURATION_MS = 30 * 60 * 1000
MAX_PHASE5_FAULT_ENVELOPE_BYTES = 128 * 1024 * 1024
MAX_PHASE5_FAULT_RESULT_BYTES = 16 * 1024 * 1024
MAX_PHASE5_FAULT_MODULE_BYTES = 8 * 1024 * 1024
MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES = 1024 * 1024
MAX_PHASE5_CAPTURE_PROOF_RESULT_BYTES = 1024 * 1024
MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_PHASE5_CAPTURE_RUN_IDENTITY_BYTES = 64 * 1024
PHASE5_FAULT_VERIFIER_DEPLOY_NAMES = (
    "phase5-fault-verifier/verify-phase5-fault-evidence.mjs",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs",
    "phase5-fault-verifier/lib/phase5-fault-validation.mjs",
    "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs",
    "phase5-fault-verifier/lib/phase5-fault-semantics.mjs",
)
PHASE5_FAULT_VERIFIER_SUMMARY_FIELDS = (
    (
        "phase5-fault-verifier/verify-phase5-fault-evidence.mjs",
        "verifyPhase5FaultEvidenceMjsSha256",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-evidence.mjs",
        "phase5FaultEvidenceMjsSha256",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-validation.mjs",
        "phase5FaultValidationMjsSha256",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs",
        "phase5FaultTransportProjectionMjsSha256",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-semantics.mjs",
        "phase5FaultSemanticsMjsSha256",
    ),
)
PHASE5_FAULT_VERIFIER_PINNED_SHA256 = {
    "phase5-fault-verifier/verify-phase5-fault-evidence.mjs":
        "a060e706482cc4afa2602fb9b91573256c3c6ab0627b2f6b50df2d3a16f1289b",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs":
        "cfc31dced58aedcd74021f209b72ec5adc8905fe3716c1ff872d34ba1bc5a36e",
    "phase5-fault-verifier/lib/phase5-fault-validation.mjs":
        "6e2bc73e8082aafb5d8c352cb4302c86f6b0fd542dbe38f65a715daff040c3b3",
    "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs":
        "2591d6936b7eae70697f2da8ae2d7399f40da55e6ed78ac01bfa2247ba88213e",
    "phase5-fault-verifier/lib/phase5-fault-semantics.mjs":
        "50017bddef51a52ae2a946f7d6a801f75afe0ee45912f11b47844c98e025372b",
}
PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES = (
    "phase5-fault-verifier/verify-phase5-capture-proof.mjs",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs",
    "src/capture/phase5-capture-proof.js",
    "src/capture/capture-wire.js",
)
PHASE5_CAPTURE_VERIFIER_PINNED_SHA256 = {
    "phase5-fault-verifier/verify-phase5-capture-proof.mjs":
        "08c9f64a06c7dcfccafe3198255b06c8922fc881c5f908b356e61b5b011fef25",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs":
        "cfc31dced58aedcd74021f209b72ec5adc8905fe3716c1ff872d34ba1bc5a36e",
    "src/capture/phase5-capture-proof.js":
        "082eead43d6e3c6c9bd9b618fee5c2cb4a7db16319e99b97ad21b7465ce922db",
    "src/capture/capture-wire.js":
        "3f044e7db25387a223ae8a1775ee3231bafd635c874c20e89dcd67e6c7e9fa1b",
}
_PHASE5_SUMMARY_OWNED_VERIFIER_IDENTITY = object()
_PHASE5_CAPTURE_OWNED_VERIFIER_IDENTITY = object()
PHASE5_RAW_ARTIFACTS = (
    ("faultEventsSha256", "acceptance-evidence/fault-events.json"),
    ("soakRunSha256", "acceptance-evidence/soak-run.json"),
    (
        "rawRuntimeReadySamplesSha256",
        "acceptance-evidence/runtime-ready-samples.json",
    ),
    (
        "rawUiStateLagSamplesSha256",
        "acceptance-evidence/ui-state-lag-samples.json",
    ),
    ("rawRenderSamplesSha256", "acceptance-evidence/render-samples.json"),
    (
        "clientObservationsSha256",
        "acceptance-evidence/client-observations.json",
    ),
    (
        "speciesNormalSamplesSha256",
        "acceptance-evidence/species-normal-samples.json",
    ),
    (
        "speciesBurstSamplesSha256",
        "acceptance-evidence/species-burst-samples.json",
    ),
    ("phase5E2eSha256", "acceptance-evidence/phase5-e2e.json"),
    ("leaseEvidenceSha256", "acceptance-evidence/lease-evidence.json"),
    ("productionGraphSha256", "production-graph.json"),
    (
        "productionMachineAttestationSha256",
        "production-machine-attestation.json",
    ),
    ("listeningChecklistSha256", "listening-checklist.json"),
    ("equivalenceSha256", "staging-equivalence.json"),
)
MAX_PHASE5_RAW_MANIFEST_BYTES = 1024 * 1024
MAX_PHASE5_RENDER_SAMPLES_BYTES = 16 * 1024 * 1024
MAX_PHASE5_LATENCY_SAMPLES_BYTES = 8 * 1024 * 1024
MAX_PHASE5_CLIENT_OBSERVATIONS_BYTES = 64 * 1024 * 1024
MAX_PHASE5_CLIENT_EVENTS = 100_000
MAX_PHASE5_SPECIES_SAMPLES_BYTES = 64 * 1024 * 1024
MAX_PHASE5_SPECIES_RESPONSE_BYTES = 1024 * 1024
PHASE5_RAW_ARTIFACT_MAX_BYTES = {
    "faultEventsSha256": MAX_PHASE5_FAULT_ENVELOPE_BYTES,
    "soakRunSha256": 16 * 1024 * 1024,
    "rawRuntimeReadySamplesSha256": MAX_PHASE5_LATENCY_SAMPLES_BYTES,
    "rawUiStateLagSamplesSha256": MAX_PHASE5_LATENCY_SAMPLES_BYTES,
    "rawRenderSamplesSha256": MAX_PHASE5_RENDER_SAMPLES_BYTES,
    "clientObservationsSha256": MAX_PHASE5_CLIENT_OBSERVATIONS_BYTES,
    "speciesNormalSamplesSha256": MAX_PHASE5_SPECIES_SAMPLES_BYTES,
    "speciesBurstSamplesSha256": MAX_PHASE5_SPECIES_SAMPLES_BYTES,
    "phase5E2eSha256": 16 * 1024 * 1024,
    "leaseEvidenceSha256": 8 * 1024 * 1024,
    "productionGraphSha256": 16 * 1024 * 1024,
    "productionMachineAttestationSha256": 8 * 1024 * 1024,
    "listeningChecklistSha256": 8 * 1024 * 1024,
    "equivalenceSha256": 8 * 1024 * 1024,
}
PHASE5_RENDER_SAMPLE_CADENCE_MS = 250
PHASE5_RENDER_BLOCK_DURATION_MS = 4096 / 44100 * 1000
PHASE5_UI_SAMPLE_CADENCE_MS = 2000
PHASE5_CLIENT_PCM_BYTE_LENGTH = 32_800
PHASE5_CLIENT_PCM_FRAME_COUNT = 4_096
PHASE5_CLIENT_MAX_PCM_GAP_MS = 1_000
PHASE5_FAULT_MEMORY_RUNNER = r"""
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fail = () => {
  throw new Error('PHASE5_FAULT_VALIDATION_REQUIRED');
};
const exactKeys = (value, expected) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === expected.length
  && expected.every((name) => Object.hasOwn(value, name))
);
const faultModuleNames = Object.freeze([
  'phase5-fault-verifier/verify-phase5-fault-evidence.mjs',
  'phase5-fault-verifier/lib/phase5-fault-evidence.mjs',
  'phase5-fault-verifier/lib/phase5-fault-validation.mjs',
  'phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs',
  'phase5-fault-verifier/lib/phase5-fault-semantics.mjs',
]);
const captureModuleNames = Object.freeze([
  'phase5-fault-verifier/verify-phase5-capture-proof.mjs',
  'phase5-fault-verifier/lib/phase5-fault-evidence.mjs',
  'src/capture/phase5-capture-proof.js',
  'src/capture/capture-wire.js',
]);
const operations = Object.freeze({
  'fault-validation': Object.freeze({
    moduleNames: faultModuleNames,
    entry:
      'phase5-fault-verifier/verify-phase5-fault-evidence.mjs',
    exportName: 'verifyPhase5FaultEnvelopeBytes',
  }),
  'fault-validation-with-client-projection': Object.freeze({
    moduleNames: faultModuleNames,
    entry:
      'phase5-fault-verifier/verify-phase5-fault-evidence.mjs',
    exportName:
      'verifyPhase5FaultEnvelopeWithClientProjectionBytes',
  }),
  'capture-proof-validation': Object.freeze({
    moduleNames: captureModuleNames,
    entry:
      'phase5-fault-verifier/verify-phase5-capture-proof.mjs',
    exportName: 'verifyPhase5CaptureProofEnvelopeBytes',
  }),
});
const allowedBuiltins = new Set([
  'node:crypto',
  'node:fs',
  'node:path',
  'node:url',
  'node:util',
]);
const decodeBase64 = (value) => {
  if (typeof value !== 'string') fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail();
  return bytes;
};

const packageBytes = readFileSync(0);
let payload;
try {
  payload = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(packageBytes),
  );
} catch {
  fail();
}
if (!exactKeys(payload, [
  'schemaVersion', 'kind', 'operation', 'modules', 'envelope',
])
    || payload.schemaVersion !== 2
    || payload.kind !== 'phase5-fault-verifier-memory-package') {
  fail();
}
const operation = operations[payload.operation];
if (operation === undefined
    || !exactKeys(payload.modules, operation.moduleNames)) fail();

const sourceByIdentifier = new Map();
for (const name of operation.moduleNames) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true })
      .decode(decodeBase64(payload.modules[name]));
  } catch {
    fail();
  }
  sourceByIdentifier.set(`file:///${name}`, source);
}
const envelope = decodeBase64(payload.envelope);
const moduleCache = new Map();

const sourceModule = (identifier) => {
  if (moduleCache.has(identifier)) return moduleCache.get(identifier);
  const source = sourceByIdentifier.get(identifier);
  if (typeof source !== 'string') fail();
  const module = new vm.SourceTextModule(source, {
    identifier,
    initializeImportMeta(meta) {
      meta.url = identifier;
    },
  });
  moduleCache.set(identifier, module);
  return module;
};

const builtinModule = async (identifier) => {
  if (!allowedBuiltins.has(identifier)) fail();
  if (moduleCache.has(identifier)) return moduleCache.get(identifier);
  const namespace = await import(identifier);
  const exports = Object.keys(namespace);
  const module = new vm.SyntheticModule(exports, function initialize() {
    for (const name of exports) this.setExport(name, namespace[name]);
  }, { identifier });
  moduleCache.set(identifier, module);
  return module;
};

const linker = async (specifier, referencingModule) => {
  if (specifier.startsWith('node:')) return builtinModule(specifier);
  let identifier;
  try {
    identifier = new URL(specifier, referencingModule.identifier).href;
  } catch {
    fail();
  }
  return sourceModule(identifier);
};

const entry = sourceModule(
  `file:///${operation.entry}`,
);
await entry.link(linker);
await entry.evaluate();
const verify = entry.namespace[operation.exportName];
if (typeof verify !== 'function') fail();
const result = verify(envelope);
if (!(result instanceof Uint8Array)) fail();
process.stdout.write(Buffer.from(result));
""".strip()
GIB = 1024 ** 3
MIN_EQUIVALENT_MEMORY_BYTES = 64 * GIB
MEMINFO_LINE = re.compile(r"^(MemTotal|MemAvailable):[ \t]+([0-9]+)[ \t]+kB$")
ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")
ATTESTATION_ROLES = {"production-baseline", "staging-phase5"}
FAULT_SESSION_RELEASE_FIELDS = {
    "releaseManifestSha256", "releaseRevision",
    "sourceManifestSha256", "audioArtifactSha256",
}
FAULT_SESSION_GEOMETRY_FIELDS = {
    "sampleRate", "blockFrames", "poolSize", "rowVoices",
}
FAULT_SESSION_PROFILE_FIELDS = {
    "clients", "slowClient", "durationMinutes", "speciesEndpoint", "speciesModel",
}
FAULT_SESSION_BINDING_FIELDS = {
    "runId", "challenge", "release", "geometry", "profile",
    "signerSpkiSha256", "faultSessionEvidenceSha256",
}
PHASE5_FAULT_RUN_BINDING_PROJECTION_FIELDS = (
    "runId", "challenge", "release", "geometry", "profile",
    "signerSpkiSha256", "faultSessionEvidenceSha256",
)
PHASE5_FAULT_RUN_BINDING_V2_FIELDS = (
    FAULT_SESSION_BINDING_FIELDS
    | {"captureNonce", "rawManifestSha256"}
)
FAULT_SESSION_TOP_FIELDS = {
    "schemaVersion", "kind", "runId", "challenge", "release",
    "geometry", "profile", "signer",
}
MACHINE_EVIDENCE_FILES = {
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
}
FAULT_SESSION_EVIDENCE_FILE = "fault-session-attestation.json"
LEASE_SURFACES = ("demo", "tracks", "new-ui")
LEASE_SPECIES = ("bass", "pad", "lead", "pluck")
LEASE_HTTP_LIMITS = {"demo": 12, "tracks": 16, "new-ui": 96}
LEASE_ENTRY_PATHS = {"demo": "/demo.html", "tracks": "/tracks.html", "new-ui": "/"}
LEASE_SOCKET_PATHS = {
    "demo": ["/decoder"],
    "tracks": ["/decoder?split=1"],
    "new-ui": [
        "/api/v1/audio",
        "/api/v1/audio",
        "/api/v1/runtime",
        "/api/v1/runtime",
        "/decoder",
    ],
}
ASCII_LOWER = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
)
STATIC_MIME_BY_EXTENSION = {
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
REQUIRED_STATIC_ROUTES = {
    "/": "mvp/index.html",
    "/index.html": "mvp/index.html",
    "/demo.html": "flock-voice-engine/client/demo.html",
    "/tracks.html": "flock-voice-engine/client/tracks.html",
    "/voice-client.js": "flock-voice-engine/client/voice-client.js",
    "/voice-client-production.js":
        "flock-voice-engine/client/voice-client-production.js",
    "/pcm-player-worklet.js":
        "flock-voice-engine/client/pcm-player-worklet.js",
    "/assets/timbre/latent_map.json":
        "flock-voice-engine/assets/timbre/latent_map.json",
    "/assets/timbre/voice_maps/bass.json":
        "flock-voice-engine/assets/timbre/voice_maps/bass.json",
    "/assets/timbre/voice_maps/lead.json":
        "flock-voice-engine/assets/timbre/voice_maps/lead.json",
    "/assets/timbre/voice_maps/pad.json":
        "flock-voice-engine/assets/timbre/voice_maps/pad.json",
    "/assets/timbre/voice_maps/pluck.json":
        "flock-voice-engine/assets/timbre/voice_maps/pluck.json",
}
APPROVED_STATIC_ROOT_EDGE = {
    "source": "flock-voice-engine/runtime/src/simulation-runtime.js",
    "kind": "js.url",
    "specifier": "../../assets/timbre/voice_maps/",
    "resolved": "flock-voice-engine/assets/timbre/voice_maps",
}
APPROVED_STATIC_ROOT_FILES = {
    f"flock-voice-engine/assets/timbre/voice_maps/{name}.json"
    for name in ("bass", "lead", "pad", "pluck")
}
PRODUCTION_EXTERNAL_EDGES = {
    "external:configurable-audio-worklet": {
        "kind": "js.audio-worklet",
        "specifier": "external:configurable-audio-worklet",
        "sources": {"flock-voice-engine/client/voice-client.js"},
    },
    "external:configurable-fetch": {
        "kind": "js.fetch",
        "specifier": "external:configurable-fetch",
        "sources": {"flock-voice-engine/client/voice-client.js"},
    },
    "external:ws": {
        "kind": "js.external",
        "specifier": "ws",
        "sources": {
            "flock-voice-engine/runtime/src/api/audio-ws.js",
            "flock-voice-engine/runtime/src/api/legacy-routes.js",
            "flock-voice-engine/runtime/src/api/runtime-ws.js",
            "flock-voice-engine/runtime/src/runtime-app.js",
        },
    },
}
PRODUCTION_RUNTIME_API_SOURCES = {
    "/api/decoder-status": {
        "flock-voice-engine/client/voice-client-production.js",
    },
    "/api/v1/bootstrap": {"mvp/src/server-main.js"},
    "/api/v1/latent-maps/bass": {"mvp/src/server-main.js"},
    "/api/v1/latent-maps/melody": {"mvp/src/server-main.js"},
    "/api/v1/latent-maps/pad": {"mvp/src/server-main.js"},
}
INTERNAL_EDGE_KINDS = {
    "html.src",
    "js.audio-worklet",
    "js.fetch",
    "js.import",
    "js.static-asset",
    "js.url",
    "python.from",
    "python.from-name",
}
PRODUCTION_GRAPH_INNER_SHA256 = (
    "f761950093e9aa83f633c8aa83a5c4494fe67c90295d7358c0f2ff1df854631b"
)
PRODUCTION_GRAPH_ROOTS = {
    "mvp/index.html",
    "flock-voice-engine/runtime/src/index.js",
    "flock-voice-engine/server/audio_worker/__main__.py",
    "flock-voice-engine/client/demo.html",
    "flock-voice-engine/client/tracks.html",
    "flock-voice-engine/client/voice-client.js",
    "flock-voice-engine/client/voice-client-production.js",
    "flock-voice-engine/client/pcm-player-worklet.js",
    "flock-voice-engine/assets/timbre/latent_map.json",
    "flock-voice-engine/assets/timbre/voice_maps/bass.json",
    "flock-voice-engine/assets/timbre/voice_maps/lead.json",
    "flock-voice-engine/assets/timbre/voice_maps/pad.json",
    "flock-voice-engine/assets/timbre/voice_maps/pluck.json",
}
PRODUCTION_GRAPH_FILE_COUNT = 165
PRODUCTION_GRAPH_EDGE_COUNT = 256
PRODUCTION_GRAPH_ROUTE_COUNT = 68


class AcceptanceError(RuntimeError):
    pass


def reject(code: str) -> None:
    raise AcceptanceError(code)


def canonical(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()


def _phase5_ecmascript_number(value: int | float) -> str:
    """Render a finite JSON number with ECMAScript/JSON.stringify spelling."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("PHASE5_JSON_NUMBER_REQUIRED")
    if isinstance(value, int):
        if abs(value) > JS_MAX_SAFE_INTEGER:
            raise ValueError("PHASE5_SAFE_JSON_INTEGER_REQUIRED")
        return str(value)
    if not math.isfinite(value):
        raise ValueError("PHASE5_FINITE_JSON_NUMBER_REQUIRED")
    if value == 0:
        return "0"

    sign = "-" if value < 0 else ""
    text = repr(abs(value)).lower()
    if "e" in text:
        coefficient, raw_exponent = text.split("e", 1)
        exponent = int(raw_exponent)
    else:
        coefficient = text
        exponent = 0
    if "." in coefficient:
        whole, fractional = coefficient.split(".", 1)
    else:
        whole, fractional = coefficient, ""
    digits = (whole + fractional).lstrip("0")
    decimal_exponent = exponent - len(fractional)
    if not digits:
        return "0"
    while len(digits) > 1 and digits.endswith("0"):
        digits = digits[:-1]
        decimal_exponent += 1

    decimal_point = len(digits) + decimal_exponent
    magnitude = abs(value)
    if 1e-6 <= magnitude < 1e21:
        if decimal_point <= 0:
            body = "0." + "0" * (-decimal_point) + digits
        elif decimal_point >= len(digits):
            body = digits + "0" * (decimal_point - len(digits))
        else:
            body = (
                digits[:decimal_point]
                + "."
                + digits[decimal_point:]
            )
        return sign + body

    body = digits[0]
    if len(digits) > 1:
        body += "." + digits[1:]
    scientific_exponent = decimal_point - 1
    exponent_sign = "+" if scientific_exponent >= 0 else "-"
    return (
        sign
        + body
        + "e"
        + exponent_sign
        + str(abs(scientific_exponent))
    )


def phase5_canonical(value: object) -> bytes:
    """Canonical JSON bytes compatible with Node's sorted JSON.stringify."""
    def render(item: object) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, (int, float)):
            return _phase5_ecmascript_number(item)
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False)
        if isinstance(item, list):
            return "[" + ",".join(render(child) for child in item) + "]"
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise TypeError("PHASE5_JSON_OBJECT_KEY_REQUIRED")
            return "{" + ",".join(
                json.dumps(key, ensure_ascii=False) + ":" + render(item[key])
                for key in sorted(
                    item,
                    key=lambda key: key.encode(
                        "utf-16-be",
                        errors="surrogatepass",
                    ),
                )
            ) + "}"
        raise TypeError("PHASE5_JSON_VALUE_REQUIRED")

    return render(value).encode("utf-8")


def _reject_duplicate_members(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("DUPLICATE_JSON_MEMBER")
        value[key] = item
    return value


def _reject_json_constant(value):
    raise ValueError(f"NON_JSON_NUMBER:{value}")


def strict_json_bytes(raw: bytes, code: str) -> object:
    try:
        text = raw.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_members,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError, OverflowError,
            RecursionError) as exc:
        raise AcceptanceError(code) from exc


def decode_canonical_base64(value: object, code: str) -> bytes:
    try:
        if not isinstance(value, str):
            reject(code)
        raw = base64.b64decode(value, validate=True)
        if base64.b64encode(raw).decode("ascii") != value:
            reject(code)
        return raw
    except (binascii.Error, UnicodeError, ValueError, TypeError) as exc:
        if isinstance(exc, AcceptanceError):
            raise
        raise AcceptanceError(code) from exc


def finite_json_number(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _reparse_or_symlink(path_stat: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return (stat.S_ISLNK(path_stat.st_mode)
            or bool(getattr(path_stat, "st_file_attributes", 0) & reparse_flag))


def _assert_absolute_no_reparse_chain(path: Path, code: str) -> None:
    candidate = Path(path)
    if not candidate.is_absolute():
        reject(code)
    while True:
        try:
            path_stat = candidate.lstat()
        except OSError as exc:
            raise AcceptanceError(code) from exc
        if _reparse_or_symlink(path_stat):
            reject(code)
        parent = candidate.parent
        if parent == candidate:
            return
        candidate = parent


def read_regular_file_no_follow(
        path: Path,
        code: str,
        *,
        max_bytes: int | None = None) -> bytes:
    candidate = Path(path)
    if (max_bytes is not None
            and (type(max_bytes) is not int or max_bytes < 1)):
        reject(code)
    _assert_absolute_no_reparse_chain(candidate, code)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(candidate, flags)
    except OSError as exc:
        raise AcceptanceError(code) from exc
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode)
                or _reparse_or_symlink(before)
                or (max_bytes is not None
                    and before.st_size > max_bytes)):
            reject(code)
        chunks = []
        received = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            received += len(chunk)
            if max_bytes is not None and received > max_bytes:
                reject(code)
            chunks.append(chunk)
        after = os.fstat(descriptor)
        stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
        if (not stat.S_ISREG(after.st_mode)
                or _reparse_or_symlink(after)
                or any(getattr(before, name) != getattr(after, name)
                       for name in stable_fields)):
            reject(code)
        raw = b"".join(chunks)
        if len(raw) != after.st_size:
            reject(code)
    except OSError as exc:
        raise AcceptanceError(code) from exc
    finally:
        os.close(descriptor)
    _assert_absolute_no_reparse_chain(candidate, code)
    return raw


def _exact_regular_file_inventory(directory: Path, expected: set[str],
                                  code: str) -> dict[str, Path]:
    candidate = Path(directory)
    _assert_absolute_no_reparse_chain(candidate, code)
    try:
        directory_stat = candidate.lstat()
        entries = list(candidate.iterdir())
    except OSError as exc:
        raise AcceptanceError(code) from exc
    if not stat.S_ISDIR(directory_stat.st_mode):
        reject(code)
    by_name = {entry.name: entry for entry in entries}
    if len(by_name) != len(entries) or set(by_name) != expected:
        reject(code)
    for entry in entries:
        _assert_absolute_no_reparse_chain(entry, code)
        try:
            entry_stat = entry.lstat()
        except OSError as exc:
            raise AcceptanceError(code) from exc
        if not stat.S_ISREG(entry_stat.st_mode):
            reject(code)
    return by_name


def _exact_child_path(parent: Path, expected_name: str, code: str) -> Path:
    """Resolve one child while rejecting case aliases and duplicate spellings."""
    candidate = Path(parent)
    _assert_absolute_no_reparse_chain(candidate, code)
    try:
        entries = list(candidate.iterdir())
    except OSError as exc:
        raise AcceptanceError(code) from exc
    exact = [entry for entry in entries if entry.name == expected_name]
    aliases = [
        entry for entry in entries
        if entry.name.casefold() == expected_name.casefold()
    ]
    if len(exact) != 1 or len(aliases) != 1:
        reject(code)
    return exact[0]


def _phase5_exact_bundle_path(
        root: Path,
        relative_posix_path: str,
        code: str) -> Path:
    current = Path(root)
    if not current.is_absolute():
        reject(code)
    for segment in relative_posix_path.split("/"):
        current = _exact_child_path(current, segment, code)
    return current


def js_safe_integer(value: object, *, minimum: int) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return minimum <= value <= JS_MAX_SAFE_INTEGER


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise AcceptanceError("EVIDENCE_FILE_MISSING") from exc
    return digest.hexdigest()


def load_canonical_json(path: Path, code: str) -> dict:
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AcceptanceError(code) from exc
    if not isinstance(value, dict) or raw != canonical(value):
        reject(code)
    return value


def safe_static_route_url(value: object) -> bool:
    if (not isinstance(value, str) or not value.startswith("/") or value.startswith("//")
            or any(character in value for character in ("%", "\\", "?", "#"))
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)):
        return False
    if value == "/":
        return True
    segments = value[1:].split("/")
    return not value.endswith("/") and all(segment not in {"", ".", ".."} for segment in segments)


def canonical_repo_path(value: object) -> bool:
    if (not isinstance(value, str) or not value or value.startswith(("/", "./"))
            or value.endswith("/") or "\\" in value or "//" in value
            or any(ord(character) < 0x20 or ord(character) == 0x7f
                   for character in value)):
        return False
    return all(segment not in {"", ".", ".."} for segment in value.split("/"))


def static_mime(repo_path: str) -> str | None:
    return STATIC_MIME_BY_EXTENSION.get(Path(repo_path).suffix.lower())


def expected_static_routes(files: list[str]) -> dict[str, str] | None:
    file_set = set(files)
    expected = dict(REQUIRED_STATIC_ROUTES)
    if any(repo_path not in file_set for repo_path in expected.values()):
        return None
    for repo_path in files:
        if not repo_path.startswith("mvp/") or repo_path == "mvp/index.html":
            continue
        if not repo_path.startswith(("mvp/src/", "mvp/assets/")):
            return None
        url = f"/{repo_path.removeprefix('mvp/')}"
        if url in expected:
            return None
        expected[url] = repo_path
    return expected


def source_matches_edge_kind(source: str, kind: str) -> bool:
    lower_source = source.lower()
    if kind == "html.src":
        return lower_source.endswith((".htm", ".html"))
    if kind.startswith("python."):
        return source.endswith(".py")
    if kind == "js.fetch":
        return lower_source.endswith((".htm", ".html", ".js", ".mjs"))
    return lower_source.endswith((".js", ".mjs"))


def target_matches_edge_kind(resolved: str, kind: str) -> bool:
    lower_resolved = resolved.lower()
    if kind in {"html.src", "js.audio-worklet"}:
        return lower_resolved.endswith((".js", ".mjs"))
    if kind == "js.import":
        return lower_resolved.endswith((".js", ".mjs", ".json"))
    if kind.startswith("python."):
        return resolved.endswith(".py")
    return True


def resolved_internal_specifier(edge: dict) -> str:
    source = edge["source"]
    specifier = edge["specifier"]
    if specifier.startswith("/assets/"):
        candidate = f"flock-voice-engine{specifier}"
    elif specifier.startswith("/"):
        candidate = specifier[1:]
    elif specifier.startswith("assets/") and source.startswith("mvp/src/"):
        candidate = f"mvp/{specifier}"
    else:
        candidate = posixpath.join(posixpath.dirname(source), specifier)
    return posixpath.normpath(candidate).removesuffix("/")


def valid_production_graph_edge(edge: dict, files: set[str]) -> bool:
    source = edge["source"]
    kind = edge["kind"]
    specifier = edge["specifier"]
    resolved = edge["resolved"]
    if (source not in files or not source_matches_edge_kind(source, kind)
            or any(ord(character) < 0x20 or ord(character) == 0x7f
                   for character in specifier)):
        return False
    if resolved.startswith("external:"):
        expected = PRODUCTION_EXTERNAL_EDGES.get(resolved)
        return (expected is not None
                and kind == expected["kind"]
                and specifier == expected["specifier"]
                and source in expected["sources"])
    if resolved.startswith("runtime-api:"):
        target = resolved.removeprefix("runtime-api:")
        return (kind == "js.runtime-api"
                and specifier == target
                and source in PRODUCTION_RUNTIME_API_SOURCES.get(target, set()))
    if kind not in INTERNAL_EDGE_KINDS or not canonical_repo_path(resolved):
        return False
    if (not kind.startswith("python.")
            and resolved_internal_specifier(edge) != resolved):
        return False
    if resolved in files:
        return target_matches_edge_kind(resolved, kind)
    descendants = {
        repo_path for repo_path in files
        if repo_path.startswith(f"{resolved}/")
    }
    return (all(edge.get(key) == value
                for key, value in APPROVED_STATIC_ROOT_EDGE.items())
            and descendants == APPROVED_STATIC_ROOT_FILES)


def production_edge_sort_key(edge: dict) -> bytes:
    value = json.dumps({
        "source": edge["source"],
        "line": edge["line"],
        "kind": edge["kind"],
        "specifier": edge["specifier"],
        "resolved": edge["resolved"],
    }, separators=(",", ":"), ensure_ascii=False)
    return value.encode("utf-16-be", errors="surrogatepass")


def _schema_matches(value: object, schema: dict, root: dict) -> bool:
    if ("allOf" in schema
            and not all(_schema_matches(value, child, root)
                        for child in schema["allOf"])):
        return False
    if "$ref" in schema:
        target = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            target = target[part]
        return _schema_matches(value, target, root)
    if "const" in schema and value != schema["const"]:
        return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict): return False
        properties = schema.get("properties", {})
        if any(name not in value for name in schema.get("required", [])): return False
        if schema.get("additionalProperties") is False and set(value) - set(properties): return False
        return all(name not in value or _schema_matches(value[name], child, root)
                   for name, child in properties.items())
    if kind == "array":
        if not isinstance(value, list): return False
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", float("inf")):
            return False
        if schema.get("uniqueItems") and len({canonical(item) for item in value}) != len(value): return False
        if "prefixItems" in schema and any(index >= len(value)
                or not _schema_matches(value[index], child, root)
                for index, child in enumerate(schema["prefixItems"])): return False
        return "items" not in schema or all(_schema_matches(item, schema["items"], root) for item in value)
    if kind == "string":
        return (isinstance(value, str)
                and not any(0xD800 <= ord(character) <= 0xDFFF
                            for character in value)
                and len(value) >= schema.get("minLength", 0)
                and len(value) <= schema.get("maxLength", math.inf)
                and ("pattern" not in schema or re.fullmatch(schema["pattern"], value) is not None))
    if kind == "integer":
        return (isinstance(value, int) and not isinstance(value, bool)
                and value >= schema.get("minimum", -math.inf)
                and value <= schema.get("maximum", math.inf))
    if kind == "number":
        return (finite_json_number(value)
                and value >= schema.get("minimum", -math.inf)
                and value <= schema.get("maximum", math.inf))
    if kind == "boolean": return isinstance(value, bool)
    return True


def validate_declared_schema(value: object, filename: str, code: str) -> None:
    tool_path = Path(__file__).resolve()
    source = tool_path.parents[1] / "release" / filename
    candidates = (
        (tool_path.with_name("phase5-summary") / filename, source)
        if filename == "phase5-summary.schema.json"
        else (tool_path.with_name(filename), source)
    )
    schema = None
    for schema_path in candidates:
        try:
            schema_path.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise AcceptanceError(code) from exc
        raw = read_regular_file_no_follow(schema_path, code)
        parsed = strict_json_bytes(raw, code)
        if not isinstance(parsed, dict):
            reject(code)
        schema = parsed
        break
    if schema is None:
        reject(code)
    if not _schema_matches(value, schema, schema):
        reject(code)


def validate_phase5_summary_structure(value: object) -> None:
    """仅校验冻结的 v2 summary 结构，不信任其中的投影结果。"""
    code = "PHASE5_SUMMARY_INVALID"
    validate_declared_schema(value, "phase5-summary.schema.json", code)
    try:
        windows = (value["window"], value["faultValidation"]["window"])
        if any(
            window["endedAtMonotonicMs"] - window["startedAtMonotonicMs"]
                != PHASE5_WINDOW_DURATION_MS
            or window["endedAtUnixMs"] - window["startedAtUnixMs"]
                != PHASE5_WINDOW_DURATION_MS
            for window in windows
        ):
            reject(code)
    except (KeyError, TypeError, OverflowError) as exc:
        raise AcceptanceError(code) from exc


def _phase5_raw_binding_snapshot(value: object, code: str) -> dict:
    try:
        raw = canonical(value)
        binding = strict_json_bytes(raw, code)
        if (raw != canonical(binding)
                or not _exact_object(binding, {
                    "runId", "challenge", "release", "geometry", "profile",
                })
                or not isinstance(binding["runId"], str)
                or UUID_V4.fullmatch(binding["runId"]) is None
                or not isinstance(binding["challenge"], str)
                or HEX.fullmatch(binding["challenge"]) is None):
            reject(code)
        validate_fault_session_release(binding["release"])
        validate_fault_session_geometry(binding["geometry"])
        validate_fault_session_profile(binding["profile"])
        return binding
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OverflowError, RecursionError,
            RuntimeError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _validate_phase5_raw_window(value: object, code: str) -> None:
    fields = {
        "startedAtMonotonicMs", "endedAtMonotonicMs",
        "startedAtUnixMs", "endedAtUnixMs",
    }
    if (not _exact_object(value, fields)
            or any(type(value[name]) is not int
                   or not 0 <= value[name] <= JS_MAX_SAFE_INTEGER
                   for name in fields)
            or value["endedAtMonotonicMs"]
               - value["startedAtMonotonicMs"] != PHASE5_WINDOW_DURATION_MS
            or value["endedAtUnixMs"]
               - value["startedAtUnixMs"] != PHASE5_WINDOW_DURATION_MS):
        reject(code)


def validate_phase5_render_samples_bytes(
        raw: bytes,
        expected_binding: object) -> dict:
    """Validate canonical render observations and recompute their projection."""
    code = "PHASE5_RENDER_SAMPLES_INVALID"
    top_fields = {
        "schemaVersion", "kind", "runId", "challenge", "release",
        "geometry", "profile", "window", "samples",
    }
    sample_fields = {
        "sequence", "atMonotonicMs", "atUnixMs",
        "renderP95Ms", "renderP99Ms", "blockDurationMs",
        "recentUnderruns",
    }
    binding_fields = (
        "runId", "challenge", "release", "geometry", "profile",
    )
    try:
        if (not isinstance(raw, bytes)
                or not 1 <= len(raw) <= MAX_PHASE5_RENDER_SAMPLES_BYTES):
            reject(code)
        value = strict_json_bytes(raw, code)
        if (raw != phase5_canonical(value)
                or not _exact_object(value, top_fields)
                or type(value["schemaVersion"]) is not int
                or value["schemaVersion"] != 2
                or value["kind"]
                   != "isolated-equivalent-spark-phase5-render-samples"):
            reject(code)

        binding = _phase5_raw_binding_snapshot({
            name: value[name] for name in binding_fields
        }, code)
        expected = _phase5_raw_binding_snapshot(expected_binding, code)
        if canonical(binding) != canonical(expected):
            reject(code)

        window = value["window"]
        _validate_phase5_raw_window(window, code)
        samples = value["samples"]
        minimum = math.floor(
            PHASE5_WINDOW_DURATION_MS
            / PHASE5_RENDER_SAMPLE_CADENCE_MS
            * 0.90
        )
        maximum = (
            PHASE5_WINDOW_DURATION_MS
            // PHASE5_RENDER_SAMPLE_CADENCE_MS
            + 1
        )
        if (not isinstance(samples, list)
                or not minimum <= len(samples) <= maximum):
            reject(code)

        monotonic_times = []
        unix_times = []
        render_p95_ratios = []
        render_p99_ratios = []
        for index, sample in enumerate(samples, start=1):
            if (not _exact_object(sample, sample_fields)
                    or type(sample["sequence"]) is not int
                    or sample["sequence"] != index):
                reject(code)
            at_monotonic = sample["atMonotonicMs"]
            at_unix = sample["atUnixMs"]
            if (type(at_monotonic) is not int
                    or type(at_unix) is not int
                    or not 0 <= at_monotonic <= JS_MAX_SAFE_INTEGER
                    or not 0 <= at_unix <= JS_MAX_SAFE_INTEGER
                    or not window["startedAtMonotonicMs"]
                           <= at_monotonic
                           <= window["endedAtMonotonicMs"]
                    or not window["startedAtUnixMs"]
                           <= at_unix
                           <= window["endedAtUnixMs"]
                    or abs(
                        (at_monotonic - window["startedAtMonotonicMs"])
                        - (at_unix - window["startedAtUnixMs"])
                    ) > 1):
                reject(code)

            render_p95 = sample["renderP95Ms"]
            render_p99 = sample["renderP99Ms"]
            block_duration = sample["blockDurationMs"]
            if (not finite_json_number(render_p95)
                    or not finite_json_number(render_p99)
                    or not finite_json_number(block_duration)
                    or render_p95 < 0
                    or render_p95 > JS_MAX_SAFE_INTEGER
                    or render_p99 < render_p95
                    or render_p99 > JS_MAX_SAFE_INTEGER
                    or block_duration != PHASE5_RENDER_BLOCK_DURATION_MS
                    or type(sample["recentUnderruns"]) is not int
                    or sample["recentUnderruns"] != 0):
                reject(code)
            monotonic_times.append(at_monotonic)
            unix_times.append(at_unix)
            render_p95_ratios.append(render_p95 / block_duration)
            render_p99_ratios.append(render_p99 / block_duration)

        if (monotonic_times[0] - window["startedAtMonotonicMs"] > 500
                or unix_times[0] - window["startedAtUnixMs"] > 500
                or window["endedAtMonotonicMs"]
                   - monotonic_times[-1] > 750
                or window["endedAtUnixMs"] - unix_times[-1] > 750
                or any(
                    right <= left or right - left > 1000
                    for left, right in zip(
                        monotonic_times, monotonic_times[1:])
                )
                or any(
                    right <= left or right - left > 1000
                    for left, right in zip(
                        unix_times, unix_times[1:])
                )):
            reject(code)

        return {
            "value": value,
            "projection": {
                "renderP95BlockFraction": nearest_rank(
                    render_p95_ratios, .95, code),
                "renderP99BlockFraction": nearest_rank(
                    render_p99_ratios, .99, code),
            },
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _phase5_latency_samples_document(
        raw: bytes,
        expected_binding: object,
        kind: str,
        code: str) -> tuple[dict, dict, list]:
    top_fields = {
        "schemaVersion", "kind", "runId", "challenge", "release",
        "geometry", "profile", "window", "samples",
    }
    if (not isinstance(raw, bytes)
            or not 1 <= len(raw) <= MAX_PHASE5_LATENCY_SAMPLES_BYTES):
        reject(code)
    value = strict_json_bytes(raw, code)
    if (raw != phase5_canonical(value)
            or not _exact_object(value, top_fields)
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 2
            or value["kind"] != kind):
        reject(code)
    binding_fields = (
        "runId", "challenge", "release", "geometry", "profile",
    )
    binding = _phase5_raw_binding_snapshot({
        name: value[name] for name in binding_fields
    }, code)
    expected = _phase5_raw_binding_snapshot(expected_binding, code)
    if canonical(binding) != canonical(expected):
        reject(code)
    window = value["window"]
    _validate_phase5_raw_window(window, code)
    samples = value["samples"]
    if not isinstance(samples, list):
        reject(code)
    return value, window, samples


def _phase5_dual_clock_interval(
        started_monotonic: object,
        started_unix: object,
        ended_monotonic: object,
        ended_unix: object,
        window: dict,
        code: str) -> int:
    values = (
        started_monotonic, started_unix,
        ended_monotonic, ended_unix,
    )
    if (any(type(item) is not int
            or not 0 <= item <= JS_MAX_SAFE_INTEGER
            for item in values)
            or not window["startedAtMonotonicMs"]
                   <= started_monotonic
                   <= ended_monotonic
                   <= window["endedAtMonotonicMs"]
            or not window["startedAtUnixMs"]
                   <= started_unix
                   <= ended_unix
                   <= window["endedAtUnixMs"]
            or abs(
                (started_monotonic - window["startedAtMonotonicMs"])
                - (started_unix - window["startedAtUnixMs"])
            ) > 1
            or abs(
                (ended_monotonic - window["startedAtMonotonicMs"])
                - (ended_unix - window["startedAtUnixMs"])
            ) > 1):
        reject(code)
    monotonic_duration = ended_monotonic - started_monotonic
    unix_duration = ended_unix - started_unix
    if abs(monotonic_duration - unix_duration) > 1:
        reject(code)
    return monotonic_duration


def validate_phase5_runtime_ready_samples_bytes(
        raw: bytes,
        expected_binding: object) -> dict:
    """Recompute four-client runtime ready latency from raw dual-clock pairs."""
    code = "PHASE5_RUNTIME_READY_SAMPLES_INVALID"
    sample_fields = {
        "sequence", "client", "connectionGeneration",
        "openedAtMonotonicMs", "openedAtUnixMs",
        "readyAtMonotonicMs", "readyAtUnixMs",
        "readyFrameSha256",
    }
    try:
        value, window, samples = _phase5_latency_samples_document(
            raw,
            expected_binding,
            "isolated-equivalent-spark-phase5-runtime-ready-samples",
            code,
        )
        if len(samples) != 4:
            reject(code)
        latencies = []
        for index, sample in enumerate(samples, start=1):
            if (not _exact_object(sample, sample_fields)
                    or type(sample["sequence"]) is not int
                    or sample["sequence"] != index
                    or type(sample["client"]) is not int
                    or sample["client"] != index
                    or type(sample["connectionGeneration"]) is not int
                    or sample["connectionGeneration"] != 1
                    or not isinstance(sample["readyFrameSha256"], str)
                    or HEX.fullmatch(sample["readyFrameSha256"]) is None):
                reject(code)
            if (sample["openedAtMonotonicMs"]
                    <= window["startedAtMonotonicMs"]
                    or sample["openedAtUnixMs"]
                       <= window["startedAtUnixMs"]):
                reject(code)
            latencies.append(_phase5_dual_clock_interval(
                sample["openedAtMonotonicMs"],
                sample["openedAtUnixMs"],
                sample["readyAtMonotonicMs"],
                sample["readyAtUnixMs"],
                window,
                code,
            ))
        return {
            "value": value,
            "projection": {
                "runtimeReadyP95Ms": nearest_rank(latencies, .95, code),
            },
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_ui_state_lag_samples_bytes(
        raw: bytes,
        expected_binding: object) -> dict:
    """Recompute UI snapshot lag from canonical request/observation clocks."""
    code = "PHASE5_UI_STATE_LAG_SAMPLES_INVALID"
    sample_fields = {
        "sequence", "client", "connectionGeneration", "probeSeq",
        "sentAtMonotonicMs", "sentAtUnixMs",
        "observedAtMonotonicMs", "observedAtUnixMs",
        "snapshotFrameSha256",
    }
    try:
        value, window, samples = _phase5_latency_samples_document(
            raw,
            expected_binding,
            "isolated-equivalent-spark-phase5-ui-state-lag-samples",
            code,
        )
        minimum = math.floor(
            PHASE5_WINDOW_DURATION_MS
            / PHASE5_UI_SAMPLE_CADENCE_MS
            * 0.95
        )
        maximum = (
            PHASE5_WINDOW_DURATION_MS // PHASE5_UI_SAMPLE_CADENCE_MS
            + 1
        )
        if not minimum <= len(samples) <= maximum:
            reject(code)

        probe_sequences = [0, 0, 0, 0]
        generations = [None, None, None, None]
        sent_monotonic = []
        sent_unix = []
        observed_monotonic = []
        observed_unix = []
        latencies = []
        for index, sample in enumerate(samples, start=1):
            expected_client = (index - 1) % 4 + 1
            if (not _exact_object(sample, sample_fields)
                    or type(sample["sequence"]) is not int
                    or sample["sequence"] != index
                    or type(sample["client"]) is not int
                    or sample["client"] != expected_client
                    or type(sample["connectionGeneration"]) is not int
                    or not 1
                           <= sample["connectionGeneration"]
                           <= JS_MAX_SAFE_INTEGER
                    or type(sample["probeSeq"]) is not int
                    or not isinstance(sample["snapshotFrameSha256"], str)
                    or HEX.fullmatch(sample["snapshotFrameSha256"]) is None):
                reject(code)
            client_index = expected_client - 1
            previous_generation = generations[client_index]
            generation = sample["connectionGeneration"]
            if previous_generation is None:
                if generation != 1:
                    reject(code)
                expected_probe = 1
            elif generation == previous_generation:
                expected_probe = probe_sequences[client_index] + 1
            elif generation == previous_generation + 1:
                expected_probe = 1
            else:
                reject(code)
            if sample["probeSeq"] != expected_probe:
                reject(code)
            probe_sequences[client_index] = expected_probe
            generations[client_index] = generation
            latencies.append(_phase5_dual_clock_interval(
                sample["sentAtMonotonicMs"],
                sample["sentAtUnixMs"],
                sample["observedAtMonotonicMs"],
                sample["observedAtUnixMs"],
                window,
                code,
            ))
            sent_monotonic.append(sample["sentAtMonotonicMs"])
            sent_unix.append(sample["sentAtUnixMs"])
            observed_monotonic.append(sample["observedAtMonotonicMs"])
            observed_unix.append(sample["observedAtUnixMs"])

        clock_streams = (
            sent_monotonic, sent_unix,
            observed_monotonic, observed_unix,
        )
        if (sent_monotonic[0] - window["startedAtMonotonicMs"] > 4000
                or sent_unix[0] - window["startedAtUnixMs"] > 4000
                or window["endedAtMonotonicMs"]
                   - observed_monotonic[-1] > 6000
                or window["endedAtUnixMs"] - observed_unix[-1] > 6000
                or any(
                    any(
                        right <= left or right - left > 8000
                        for left, right in zip(stream, stream[1:])
                    )
                    for stream in clock_streams
                )):
            reject(code)
        return {
            "value": value,
            "projection": {
                "uiStateLagP95Ms": nearest_rank(latencies, .95, code),
            },
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _phase5_client_safe_integer(
        value: object,
        *,
        positive: bool = False,
        maximum: int = JS_MAX_SAFE_INTEGER) -> bool:
    lower = 1 if positive else 0
    return type(value) is int and lower <= value <= maximum


def _phase5_client_decimal_frame(value: object, code: str) -> int:
    if (not isinstance(value, str)
            or re.fullmatch(r"(?:0|[1-9][0-9]*)", value) is None):
        reject(code)
    parsed = int(value)
    if parsed > JS_MAX_SAFE_INTEGER:
        reject(code)
    return parsed


def _phase5_client_nonempty_string(
        value: object,
        *,
        maximum: int = 256) -> bool:
    return (isinstance(value, str)
            and 1 <= len(value) <= maximum
            and "\x00" not in value)


def _phase5_client_clock(
        at_monotonic: object,
        at_unix: object,
        window: dict,
        code: str) -> tuple[int, int]:
    if (not _phase5_client_safe_integer(at_monotonic)
            or not _phase5_client_safe_integer(at_unix)
            or not window["startedAtMonotonicMs"]
                   <= at_monotonic <= window["endedAtMonotonicMs"]
            or not window["startedAtUnixMs"]
                   <= at_unix <= window["endedAtUnixMs"]
            or abs(
                (at_monotonic - window["startedAtMonotonicMs"])
                - (at_unix - window["startedAtUnixMs"])
            ) > 1):
        reject(code)
    return at_monotonic, at_unix


def _phase5_client_signed_transport_projection(
        value: object,
        expected_binding: dict,
        window: dict,
        code: str) -> dict:
    """Own and validate the already-verified signed-transport projection.

    This projection is a caller-supplied trust input from the fixed Node
    verifier.  It is not capture-nonce proof-of-possession.
    """
    top_fields = {
        "schemaVersion", "kind", "runId", "challenge", "release",
        "geometry", "profile", "window", "runtimeOpens",
        "audioLifecycle", "slowClient", "discontinuities",
    }
    runtime_open_fields = {
        "client", "connectionGeneration", "atMonotonicMs", "atUnixMs",
        "mode", "clientIdentitySha256",
    }
    receipt_fields = {
        "connectionGeneration", "atMonotonicMs", "atUnixMs",
        "transportSequence", "transportEventSha256",
    }
    discontinuity_fields = {
        "client", "connectionGeneration", "atMonotonicMs", "atUnixMs",
        "transportSequence", "transportEventSha256", "scope",
        "audioEpoch", "streamRevision", "blockSeq", "resumeStartFrame",
    }
    audio_lifecycle_fields = {
        "client", "connectionGeneration", "type",
        "atMonotonicMs", "atUnixMs", "payload",
    }
    try:
        raw = canonical(value)
        projection = strict_json_bytes(raw, code)
        if (raw != canonical(projection)
                or not _exact_object(projection, top_fields)
                or type(projection["schemaVersion"]) is not int
                or projection["schemaVersion"] != 1
                or projection["kind"]
                   != "phase5-client-observations-signed-transport-projection"):
            reject(code)
        projection_binding = _phase5_raw_binding_snapshot({
            name: projection[name]
            for name in (
                "runId", "challenge", "release", "geometry", "profile",
            )
        }, code)
        if canonical(projection_binding) != canonical(expected_binding):
            reject(code)
        _validate_phase5_raw_window(projection["window"], code)
        if canonical(projection["window"]) != canonical(window):
            reject(code)

        runtime_opens = projection["runtimeOpens"]
        if not isinstance(runtime_opens, list) or not runtime_opens:
            reject(code)
        previous_clock = None
        last_generation = [0, 0, 0, 0]
        identities: list[str | None] = [None, None, None, None]
        for item in runtime_opens:
            if (not _exact_object(item, runtime_open_fields)
                    or not _phase5_client_safe_integer(
                        item["client"], positive=True, maximum=4)
                    or not _phase5_client_safe_integer(
                        item["connectionGeneration"],
                        positive=True,
                        maximum=0xffff_ffff)
                    or item["mode"] not in {"bootstrap", "resume"}
                    or not isinstance(item["clientIdentitySha256"], str)
                    or HEX.fullmatch(item["clientIdentitySha256"]) is None):
                reject(code)
            current_clock = _phase5_client_clock(
                item["atMonotonicMs"], item["atUnixMs"], window, code)
            if (previous_clock is not None
                    and (current_clock[0] < previous_clock[0]
                         or current_clock[1] < previous_clock[1])):
                reject(code)
            previous_clock = current_clock
            client_index = item["client"] - 1
            expected_generation = last_generation[client_index] + 1
            expected_mode = (
                "bootstrap" if expected_generation == 1 else "resume")
            if (item["connectionGeneration"] != expected_generation
                    or item["mode"] != expected_mode
                    or (identities[client_index] is not None
                        and item["clientIdentitySha256"]
                            != identities[client_index])):
                reject(code)
            last_generation[client_index] = expected_generation
            identities[client_index] = item["clientIdentitySha256"]
        if any(identity is None for identity in identities):
            reject(code)

        audio_lifecycle = projection["audioLifecycle"]
        if not isinstance(audio_lifecycle, list) or not audio_lifecycle:
            reject(code)
        audio_generation = [0, 0, 0, 0]
        audio_open = [False, False, False, False]
        previous_clock = None
        for item in audio_lifecycle:
            if (not _exact_object(item, audio_lifecycle_fields)
                    or not _phase5_client_safe_integer(
                        item["client"], positive=True, maximum=4)
                    or not _phase5_client_safe_integer(
                        item["connectionGeneration"],
                        positive=True,
                        maximum=0xffff_ffff)
                    or item["type"] not in {"audio.open", "audio.close"}):
                reject(code)
            current_clock = _phase5_client_clock(
                item["atMonotonicMs"], item["atUnixMs"], window, code)
            if (previous_clock is not None
                    and (current_clock[0] < previous_clock[0]
                         or current_clock[1] < previous_clock[1])):
                reject(code)
            previous_clock = current_clock
            client_index = item["client"] - 1
            generation = item["connectionGeneration"]
            if item["type"] == "audio.open":
                if (not _exact_object(item["payload"], set())
                        or audio_open[client_index]
                        or generation != audio_generation[client_index] + 1):
                    reject(code)
                audio_generation[client_index] = generation
                audio_open[client_index] = True
            else:
                payload = item["payload"]
                if (not _exact_object(payload, {"code", "reason"})
                        or not audio_open[client_index]
                        or generation != audio_generation[client_index]
                        or not _phase5_client_safe_integer(
                            payload["code"],
                            positive=True,
                            maximum=65_535)
                        or not _phase5_client_nonempty_string(
                            payload["reason"])):
                    reject(code)
                audio_open[client_index] = False
        if any(generation < 1 for generation in audio_generation) or not all(
                audio_open):
            reject(code)

        slow_client = projection["slowClient"]
        if (not _exact_object(slow_client, {"client", "pause", "resume"})
                or type(slow_client["client"]) is not int
                or slow_client["client"] != 4):
            reject(code)
        receipts = []
        for name in ("pause", "resume"):
            receipt = slow_client[name]
            if (not _exact_object(receipt, receipt_fields)
                    or not _phase5_client_safe_integer(
                        receipt["connectionGeneration"],
                        positive=True,
                        maximum=0xffff_ffff)
                    or not _phase5_client_safe_integer(
                        receipt["transportSequence"], positive=True)
                    or not isinstance(receipt["transportEventSha256"], str)
                    or HEX.fullmatch(
                        receipt["transportEventSha256"]) is None):
                reject(code)
            _phase5_client_clock(
                receipt["atMonotonicMs"],
                receipt["atUnixMs"],
                window,
                code,
            )
            receipts.append(receipt)
        pause, resume = receipts
        if (resume["connectionGeneration"]
                != pause["connectionGeneration"]
                or resume["transportSequence"]
                <= pause["transportSequence"]
                or resume["atMonotonicMs"] <= pause["atMonotonicMs"]
                or resume["atUnixMs"] <= pause["atUnixMs"]):
            reject(code)

        discontinuities = projection["discontinuities"]
        if not isinstance(discontinuities, list):
            reject(code)
        transport_sequences = {
            pause["transportSequence"], resume["transportSequence"],
        }
        transport_digests = {
            pause["transportEventSha256"], resume["transportEventSha256"],
        }
        if len(transport_sequences) != 2 or len(transport_digests) != 2:
            reject(code)
        transport_receipts = [pause, resume]
        previous_clock = None
        for item in discontinuities:
            if (not _exact_object(item, discontinuity_fields)
                    or not _phase5_client_safe_integer(
                        item["client"], positive=True, maximum=4)
                    or not _phase5_client_safe_integer(
                        item["connectionGeneration"],
                        positive=True,
                        maximum=0xffff_ffff)
                    or not _phase5_client_safe_integer(
                        item["transportSequence"], positive=True)
                    or not isinstance(item["transportEventSha256"], str)
                    or HEX.fullmatch(
                        item["transportEventSha256"]) is None
                    or item["scope"] not in {"client", "stream"}
                    or not _phase5_client_nonempty_string(
                        item["audioEpoch"], maximum=128)
                    or not _phase5_client_safe_integer(
                        item["streamRevision"],
                        positive=True,
                        maximum=0xffff_ffff)
                    or not _phase5_client_safe_integer(
                        item["blockSeq"], maximum=0xffff_ffff)):
                reject(code)
            _phase5_client_decimal_frame(item["resumeStartFrame"], code)
            current_clock = _phase5_client_clock(
                item["atMonotonicMs"], item["atUnixMs"], window, code)
            if (previous_clock is not None
                    and (current_clock[0] < previous_clock[0]
                         or current_clock[1] < previous_clock[1])):
                reject(code)
            previous_clock = current_clock
            if (item["transportSequence"] in transport_sequences
                    or item["transportEventSha256"] in transport_digests):
                reject(code)
            transport_sequences.add(item["transportSequence"])
            transport_digests.add(item["transportEventSha256"])
            transport_receipts.append(item)
        transport_receipts.sort(key=lambda item: item["transportSequence"])
        if any(
            right["atMonotonicMs"] < left["atMonotonicMs"]
            or right["atUnixMs"] < left["atUnixMs"]
            for left, right in zip(
                transport_receipts, transport_receipts[1:])
        ):
            reject(code)
        return projection
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_client_observations_bytes(
        raw: bytes,
        expected_binding: object,
        signed_transport_projection: object) -> dict:
    """Validate canonical client observations and recompute raw facts.

    ``signed_transport_projection`` must come from the fixed signed fault
    verifier.  This function binds observations to that projection but does
    not implement the still-pending capture-nonce PoP boundary.
    """
    code = "PHASE5_CLIENT_OBSERVATIONS_INVALID"
    top_fields = {
        "schemaVersion", "kind", "runId", "challenge", "release",
        "geometry", "profile", "window", "clients", "events",
    }
    event_fields = {
        "sequence", "client", "type", "connectionGeneration",
        "atMonotonicMs", "atUnixMs", "payload",
    }
    payload_fields = {
        "runtime.open": {"mode"},
        "runtime.ready": {
            "frameSha256", "worldGeneration", "revision", "eventSeq",
        },
        "runtime.snapshot": {
            "frameSha256", "worldGeneration", "revision", "eventSeq",
            "probeSeq",
        },
        "runtime.close": {"code", "reason"},
        "runtime.error": set(),
        "runtime.invalid-frame": {
            "frameSha256", "byteLength", "validationCode",
        },
        "audio.open": set(),
        "audio.ready": {
            "frameSha256", "audioEpoch", "streamRevision", "blockSeq",
            "resumeStartFrame",
        },
        "audio.pcm": {
            "frameSha256", "byteLength", "wireVersion", "flags",
            "headerBytes", "audioEpoch", "streamRevision", "blockSeq",
            "startFrame", "frameCount", "channels", "format",
            "headerValid", "lengthValid", "finiteSamples", "cursorValid",
        },
        "audio.discontinuity": {
            "frameSha256", "scope", "audioEpoch", "streamRevision",
            "blockSeq", "resumeStartFrame",
        },
        "audio.pause": {
            "transportSequence", "transportEventSha256",
        },
        "audio.resume": {
            "transportSequence", "transportEventSha256",
        },
        "audio.close": {"code", "reason"},
        "audio.error": set(),
        "audio.invalid-frame": {
            "frameSha256", "byteLength", "validationCode",
        },
    }
    forbidden_types = {
        "runtime.error", "runtime.invalid-frame",
        "audio.error", "audio.invalid-frame",
    }
    binding_fields = (
        "runId", "challenge", "release", "geometry", "profile",
    )
    try:
        if (not isinstance(raw, bytes)
                or not 1 <= len(raw)
                       <= MAX_PHASE5_CLIENT_OBSERVATIONS_BYTES):
            reject(code)
        value = strict_json_bytes(raw, code)
        if (raw != phase5_canonical(value)
                or not _exact_object(value, top_fields)
                or type(value["schemaVersion"]) is not int
                or value["schemaVersion"] != 2
                or value["kind"]
                   != "isolated-equivalent-spark-phase5-client-observations"):
            reject(code)

        binding = _phase5_raw_binding_snapshot({
            name: value[name] for name in binding_fields
        }, code)
        expected = _phase5_raw_binding_snapshot(expected_binding, code)
        if canonical(binding) != canonical(expected):
            reject(code)
        window = value["window"]
        _validate_phase5_raw_window(window, code)

        clients = value["clients"]
        client_fields = {"client", "clientIdentitySha256"}
        if not isinstance(clients, list) or len(clients) != 4:
            reject(code)
        identities = []
        for expected_client, client in enumerate(clients, start=1):
            if (not _exact_object(client, client_fields)
                    or type(client["client"]) is not int
                    or client["client"] != expected_client
                    or not isinstance(client["clientIdentitySha256"], str)
                    or HEX.fullmatch(
                        client["clientIdentitySha256"]) is None):
                reject(code)
            identities.append(client["clientIdentitySha256"])
        if len(set(identities)) != 4:
            reject(code)

        signed = _phase5_client_signed_transport_projection(
            signed_transport_projection,
            binding,
            window,
            code,
        )
        for item in signed["runtimeOpens"]:
            if (item["clientIdentitySha256"]
                    != identities[item["client"] - 1]):
                reject(code)

        events = value["events"]
        if (not isinstance(events, list)
                or not events
                or len(events) > MAX_PHASE5_CLIENT_EVENTS):
            reject(code)
        runtime_states = [{
            "generation": 0,
            "open": False,
            "ready": False,
            "worldGeneration": None,
            "revision": None,
            "eventSeq": None,
            "probeSeq": 0,
        } for _ in range(4)]
        audio_states = [{
            "generation": 0,
            "open": False,
            "ready": False,
            "paused": False,
            "audioEpoch": None,
            "streamRevision": None,
            "blockSeq": None,
            "cursor": None,
            "seenEpochs": set(),
        } for _ in range(4)]
        counters = [{
            "runtimeOpenCount": 0,
            "runtimeSnapshotCount": 0,
            "audioPcmFrameCount": 0,
            "audioPcmByteLength": 0,
            "audioDiscontinuityCount": 0,
        } for _ in range(4)]
        pcm_events: list[list[dict]] = [[], [], [], []]
        raw_runtime_opens = []
        raw_audio_lifecycle = []
        raw_pause_events = []
        raw_resume_events = []
        raw_discontinuities = []
        previous_clock = None

        for sequence, event in enumerate(events, start=1):
            if (not _exact_object(event, event_fields)
                    or type(event["sequence"]) is not int
                    or event["sequence"] != sequence
                    or not _phase5_client_safe_integer(
                        event["client"], positive=True, maximum=4)
                    or not isinstance(event["type"], str)
                    or event["type"] not in payload_fields
                    or not _phase5_client_safe_integer(
                        event["connectionGeneration"],
                        positive=True,
                        maximum=0xffff_ffff)
                    or not _exact_object(
                        event["payload"], payload_fields[event["type"]])):
                reject(code)
            current_clock = _phase5_client_clock(
                event["atMonotonicMs"],
                event["atUnixMs"],
                window,
                code,
            )
            if (previous_clock is not None
                    and (current_clock[0] < previous_clock[0]
                         or current_clock[1] < previous_clock[1])):
                reject(code)
            previous_clock = current_clock
            if event["type"] in forbidden_types:
                reject(code)

            client_index = event["client"] - 1
            payload = event["payload"]
            event_type = event["type"]
            generation = event["connectionGeneration"]
            runtime_state = runtime_states[client_index]
            audio_state = audio_states[client_index]

            if event_type == "runtime.open":
                expected_generation = runtime_state["generation"] + 1
                expected_mode = (
                    "bootstrap" if expected_generation == 1 else "resume")
                if (runtime_state["open"]
                        or generation != expected_generation
                        or payload["mode"] != expected_mode):
                    reject(code)
                runtime_state.update({
                    "generation": generation,
                    "open": True,
                    "ready": False,
                    "probeSeq": 0,
                })
                counters[client_index]["runtimeOpenCount"] += 1
                raw_runtime_opens.append({
                    "client": event["client"],
                    "connectionGeneration": generation,
                    "atMonotonicMs": event["atMonotonicMs"],
                    "atUnixMs": event["atUnixMs"],
                    "mode": payload["mode"],
                    "clientIdentitySha256": identities[client_index],
                })
                continue

            if event_type in {
                "runtime.ready", "runtime.snapshot", "runtime.close",
            }:
                if (not runtime_state["open"]
                        or generation != runtime_state["generation"]):
                    reject(code)

            if event_type in {"runtime.ready", "runtime.snapshot"}:
                if (not isinstance(payload["frameSha256"], str)
                        or HEX.fullmatch(payload["frameSha256"]) is None
                        or not _phase5_client_nonempty_string(
                            payload["worldGeneration"], maximum=128)
                        or not _phase5_client_safe_integer(
                            payload["revision"])
                        or not _phase5_client_safe_integer(
                            payload["eventSeq"])):
                    reject(code)
                if (runtime_state["worldGeneration"] is not None
                        and (
                            payload["worldGeneration"]
                                != runtime_state["worldGeneration"]
                            or payload["revision"]
                                < runtime_state["revision"]
                            or payload["eventSeq"]
                                < runtime_state["eventSeq"]
                        )):
                    reject(code)

            if event_type == "runtime.ready":
                if runtime_state["ready"]:
                    reject(code)
                runtime_state.update({
                    "ready": True,
                    "worldGeneration": payload["worldGeneration"],
                    "revision": payload["revision"],
                    "eventSeq": payload["eventSeq"],
                })
                continue

            if event_type == "runtime.snapshot":
                if (not runtime_state["ready"]
                        or not _phase5_client_safe_integer(
                            payload["probeSeq"], positive=True)
                        or payload["probeSeq"]
                            != runtime_state["probeSeq"] + 1):
                    reject(code)
                runtime_state.update({
                    "worldGeneration": payload["worldGeneration"],
                    "revision": payload["revision"],
                    "eventSeq": payload["eventSeq"],
                    "probeSeq": payload["probeSeq"],
                })
                counters[client_index]["runtimeSnapshotCount"] += 1
                continue

            if event_type == "runtime.close":
                if (not _phase5_client_safe_integer(
                        payload["code"], positive=True, maximum=65_535)
                        or not _phase5_client_nonempty_string(
                            payload["reason"])):
                    reject(code)
                runtime_state["open"] = False
                runtime_state["ready"] = False
                continue

            if event_type == "audio.open":
                expected_generation = audio_state["generation"] + 1
                if (audio_state["open"]
                        or generation != expected_generation):
                    reject(code)
                audio_state.update({
                    "generation": generation,
                    "open": True,
                    "ready": False,
                    "paused": False,
                })
                raw_audio_lifecycle.append({
                    "client": event["client"],
                    "connectionGeneration": generation,
                    "type": event_type,
                    "atMonotonicMs": event["atMonotonicMs"],
                    "atUnixMs": event["atUnixMs"],
                    "payload": {},
                })
                continue

            if event_type in {
                "audio.ready", "audio.pcm", "audio.discontinuity",
                "audio.pause", "audio.resume", "audio.close",
            }:
                if (not audio_state["open"]
                        or generation != audio_state["generation"]):
                    reject(code)

            if event_type == "audio.ready":
                if (audio_state["ready"]
                        or not isinstance(payload["frameSha256"], str)
                        or HEX.fullmatch(payload["frameSha256"]) is None
                        or not _phase5_client_nonempty_string(
                            payload["audioEpoch"], maximum=128)
                        or not _phase5_client_safe_integer(
                            payload["streamRevision"],
                            positive=True,
                            maximum=0xffff_ffff)
                        or not _phase5_client_safe_integer(
                            payload["blockSeq"], maximum=0xffff_ffff)):
                    reject(code)
                resume_start = _phase5_client_decimal_frame(
                    payload["resumeStartFrame"], code)
                if (audio_state["cursor"] is None
                        and (payload["blockSeq"] != 0
                             or resume_start != 0)):
                    reject(code)
                if (audio_state["cursor"] is not None
                        and (
                            payload["audioEpoch"]
                                != audio_state["audioEpoch"]
                            or payload["streamRevision"]
                                != audio_state["streamRevision"]
                            or payload["blockSeq"]
                                != audio_state["blockSeq"]
                            or resume_start != audio_state["cursor"]
                        )):
                    reject(code)
                if audio_state["cursor"] is None:
                    audio_state["seenEpochs"].add(payload["audioEpoch"])
                audio_state.update({
                    "ready": True,
                    "audioEpoch": payload["audioEpoch"],
                    "streamRevision": payload["streamRevision"],
                    "blockSeq": payload["blockSeq"],
                    "cursor": resume_start,
                })
                continue

            if event_type == "audio.pcm":
                if (not audio_state["ready"]
                        or audio_state["paused"]
                        or not isinstance(payload["frameSha256"], str)
                        or HEX.fullmatch(payload["frameSha256"]) is None
                        or type(payload["byteLength"]) is not int
                        or payload["byteLength"]
                            != PHASE5_CLIENT_PCM_BYTE_LENGTH
                        or type(payload["wireVersion"]) is not int
                        or payload["wireVersion"] != 1
                        or type(payload["flags"]) is not int
                        or payload["flags"] != 0
                        or type(payload["headerBytes"]) is not int
                        or payload["headerBytes"] != 32
                        or not _phase5_client_nonempty_string(
                            payload["audioEpoch"], maximum=128)
                        or payload["audioEpoch"]
                            != audio_state["audioEpoch"]
                        or not _phase5_client_safe_integer(
                            payload["streamRevision"],
                            positive=True,
                            maximum=0xffff_ffff)
                        or payload["streamRevision"]
                            != audio_state["streamRevision"]
                        or not _phase5_client_safe_integer(
                            payload["blockSeq"], maximum=0xffff_ffff)
                        or payload["blockSeq"] != audio_state["blockSeq"]
                        or type(payload["frameCount"]) is not int
                        or payload["frameCount"]
                            != PHASE5_CLIENT_PCM_FRAME_COUNT
                        or type(payload["channels"]) is not int
                        or payload["channels"] != 2
                        or type(payload["format"]) is not int
                        or payload["format"] != 1
                        or any(
                            payload[name] is not True
                            for name in (
                                "headerValid", "lengthValid",
                                "finiteSamples", "cursorValid",
                            )
                        )):
                    reject(code)
                start_frame = _phase5_client_decimal_frame(
                    payload["startFrame"], code)
                if (start_frame != audio_state["cursor"]
                        or start_frame + PHASE5_CLIENT_PCM_FRAME_COUNT
                            > JS_MAX_SAFE_INTEGER
                        or audio_state["blockSeq"] == 0xffff_ffff):
                    reject(code)
                audio_state["blockSeq"] += 1
                audio_state["cursor"] += PHASE5_CLIENT_PCM_FRAME_COUNT
                counters[client_index]["audioPcmFrameCount"] += 1
                counters[client_index]["audioPcmByteLength"] += (
                    payload["byteLength"])
                pcm_events[client_index].append(event)
                continue

            if event_type == "audio.discontinuity":
                if (not audio_state["ready"]
                        or audio_state["paused"]
                        or not isinstance(payload["frameSha256"], str)
                        or HEX.fullmatch(payload["frameSha256"]) is None
                        or payload["scope"] not in {"client", "stream"}
                        or not _phase5_client_nonempty_string(
                            payload["audioEpoch"], maximum=128)
                        or not _phase5_client_safe_integer(
                            payload["streamRevision"],
                            positive=True,
                            maximum=0xffff_ffff)
                        or not _phase5_client_safe_integer(
                            payload["blockSeq"], maximum=0xffff_ffff)):
                    reject(code)
                resume_start = _phase5_client_decimal_frame(
                    payload["resumeStartFrame"], code)
                if payload["scope"] == "client":
                    if (payload["audioEpoch"] != audio_state["audioEpoch"]
                            or payload["streamRevision"]
                                != audio_state["streamRevision"]
                            or payload["blockSeq"]
                                < audio_state["blockSeq"]
                            or resume_start < audio_state["cursor"]):
                        reject(code)
                else:
                    if (payload["streamRevision"]
                            != audio_state["streamRevision"] + 1):
                        reject(code)
                    if payload["audioEpoch"] == audio_state["audioEpoch"]:
                        if (payload["blockSeq"] < audio_state["blockSeq"]
                                or resume_start < audio_state["cursor"]):
                            reject(code)
                    elif (payload["blockSeq"] != 0
                          or resume_start != 0
                          or payload["audioEpoch"]
                             in audio_state["seenEpochs"]):
                        reject(code)
                    else:
                        audio_state["seenEpochs"].add(
                            payload["audioEpoch"])
                audio_state.update({
                    "audioEpoch": payload["audioEpoch"],
                    "streamRevision": payload["streamRevision"],
                    "blockSeq": payload["blockSeq"],
                    "cursor": resume_start,
                })
                counters[client_index]["audioDiscontinuityCount"] += 1
                raw_discontinuities.append({
                    "client": event["client"],
                    "connectionGeneration": generation,
                    "atMonotonicMs": event["atMonotonicMs"],
                    "atUnixMs": event["atUnixMs"],
                    **{
                        name: payload[name]
                        for name in (
                            "scope", "audioEpoch", "streamRevision",
                            "blockSeq", "resumeStartFrame",
                        )
                    },
                })
                continue

            if event_type in {"audio.pause", "audio.resume"}:
                if (event["client"] != 4
                        or not audio_state["ready"]
                        or not _phase5_client_safe_integer(
                            payload["transportSequence"], positive=True)
                        or not isinstance(
                            payload["transportEventSha256"], str)
                        or HEX.fullmatch(
                            payload["transportEventSha256"]) is None):
                    reject(code)
                receipt = {
                    "connectionGeneration": generation,
                    "atMonotonicMs": event["atMonotonicMs"],
                    "atUnixMs": event["atUnixMs"],
                    "transportSequence": payload["transportSequence"],
                    "transportEventSha256":
                        payload["transportEventSha256"],
                }
                if event_type == "audio.pause":
                    if audio_state["paused"]:
                        reject(code)
                    audio_state["paused"] = True
                    raw_pause_events.append((event, receipt))
                else:
                    if not audio_state["paused"]:
                        reject(code)
                    audio_state["paused"] = False
                    raw_resume_events.append((event, receipt))
                continue

            if event_type == "audio.close":
                if (not _phase5_client_safe_integer(
                        payload["code"], positive=True, maximum=65_535)
                        or not _phase5_client_nonempty_string(
                            payload["reason"])):
                    reject(code)
                audio_state["open"] = False
                audio_state["ready"] = False
                audio_state["paused"] = False
                raw_audio_lifecycle.append({
                    "client": event["client"],
                    "connectionGeneration": generation,
                    "type": event_type,
                    "atMonotonicMs": event["atMonotonicMs"],
                    "atUnixMs": event["atUnixMs"],
                    "payload": {
                        "code": payload["code"],
                        "reason": payload["reason"],
                    },
                })
                continue

            reject(code)

        if (any(
                not state["open"] or not state["ready"]
                for state in runtime_states)
                or any(
                    not state["open"]
                    or not state["ready"]
                    or state["paused"]
                    for state in audio_states)
                or canonical(raw_runtime_opens)
                   != canonical(signed["runtimeOpens"])
                or canonical(raw_audio_lifecycle)
                   != canonical(signed["audioLifecycle"])
                or len(raw_pause_events) != 1
                or len(raw_resume_events) != 1):
            reject(code)

        pause_event, pause_receipt = raw_pause_events[0]
        resume_event, resume_receipt = raw_resume_events[0]
        if (canonical(pause_receipt)
                != canonical(signed["slowClient"]["pause"])
                or canonical(resume_receipt)
                   != canonical(signed["slowClient"]["resume"])
                or pause_event["sequence"] >= resume_event["sequence"]):
            reject(code)

        signed_discontinuities = []
        for item in signed["discontinuities"]:
            signed_discontinuities.append({
                name: item[name]
                for name in (
                    "client", "connectionGeneration",
                    "atMonotonicMs", "atUnixMs", "scope", "audioEpoch",
                    "streamRevision", "blockSeq", "resumeStartFrame",
                )
            })
        if canonical(raw_discontinuities) != canonical(signed_discontinuities):
            reject(code)

        for client_index, observations in enumerate(pcm_events):
            if not observations:
                reject(code)
            first = observations[0]
            last = observations[-1]
            if (first["atMonotonicMs"]
                    - window["startedAtMonotonicMs"]
                    > PHASE5_CLIENT_MAX_PCM_GAP_MS
                    or first["atUnixMs"]
                       - window["startedAtUnixMs"]
                       > PHASE5_CLIENT_MAX_PCM_GAP_MS
                    or window["endedAtMonotonicMs"]
                       - last["atMonotonicMs"]
                       > PHASE5_CLIENT_MAX_PCM_GAP_MS
                    or window["endedAtUnixMs"]
                       - last["atUnixMs"]
                       > PHASE5_CLIENT_MAX_PCM_GAP_MS):
                reject(code)
            for left, right in zip(observations, observations[1:]):
                monotonic_gap = (
                    right["atMonotonicMs"] - left["atMonotonicMs"])
                unix_gap = right["atUnixMs"] - left["atUnixMs"]
                crosses_pause = (
                    client_index == 3
                    and left["sequence"] < pause_event["sequence"]
                    and right["sequence"] > resume_event["sequence"]
                )
                if crosses_pause:
                    monotonic_gap -= (
                        resume_receipt["atMonotonicMs"]
                        - pause_receipt["atMonotonicMs"])
                    unix_gap -= (
                        resume_receipt["atUnixMs"]
                        - pause_receipt["atUnixMs"])
                if (not 0 <= monotonic_gap
                        <= PHASE5_CLIENT_MAX_PCM_GAP_MS
                        or not 0 <= unix_gap
                        <= PHASE5_CLIENT_MAX_PCM_GAP_MS):
                    reject(code)

        slow_pcm = pcm_events[3]
        if (not any(
                event["sequence"] < pause_event["sequence"]
                for event in slow_pcm)
                or not any(
                    event["sequence"] > resume_event["sequence"]
                    for event in slow_pcm)):
            reject(code)

        projection_clients = []
        for client_index, client in enumerate(clients):
            projection_clients.append({
                "client": client["client"],
                "clientIdentitySha256":
                    client["clientIdentitySha256"],
                **counters[client_index],
            })
        return {
            "value": value,
            "projection": {
                "schemaVersion": 1,
                "kind": "phase5-client-observations-projection",
                "eventCount": len(events),
                "clients": projection_clients,
                "slowClient": {
                    "client": 4,
                    "pause": pause_receipt,
                    "resume": resume_receipt,
                    "pausedMonotonicMs": (
                        resume_receipt["atMonotonicMs"]
                        - pause_receipt["atMonotonicMs"]
                    ),
                    "pausedUnixMs": (
                        resume_receipt["atUnixMs"]
                        - pause_receipt["atUnixMs"]
                    ),
                },
                "pcmCorruptions": 0,
                "cursorDiscontinuitiesUnexpected": 0,
            },
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_latency_client_cross_binding(
        runtime_ready_result: object,
        ui_state_lag_result: object,
        client_observations_result: object) -> dict:
    """Exact-bind latency observations to their client receive events."""
    code = "PHASE5_LATENCY_CLIENT_BINDING_INVALID"
    try:
        owned = []
        for result in (
                runtime_ready_result,
                ui_state_lag_result,
                client_observations_result):
            if not isinstance(result, dict) or "value" not in result:
                reject(code)
            raw = canonical(result["value"])
            value = strict_json_bytes(raw, code)
            if raw != canonical(value):
                reject(code)
            owned.append(value)
        runtime_ready, ui_state_lag, client_observations = owned
        if (runtime_ready.get("kind")
                != "isolated-equivalent-spark-phase5-runtime-ready-samples"
                or ui_state_lag.get("kind")
                != "isolated-equivalent-spark-phase5-ui-state-lag-samples"
                or client_observations.get("kind")
                != "isolated-equivalent-spark-phase5-client-observations"):
            reject(code)

        runtime_opens = {}
        runtime_readies = {}
        runtime_snapshots = {}
        for event in client_observations["events"]:
            event_type = event["type"]
            if event_type not in {
                    "runtime.open", "runtime.ready", "runtime.snapshot"}:
                continue
            generation_key = (
                event["client"],
                event["connectionGeneration"],
            )
            if event_type == "runtime.open":
                if generation_key in runtime_opens:
                    reject(code)
                runtime_opens[generation_key] = event
            elif event_type == "runtime.ready":
                if generation_key in runtime_readies:
                    reject(code)
                runtime_readies[generation_key] = event
            else:
                snapshot_key = (
                    *generation_key,
                    event["payload"]["probeSeq"],
                )
                if snapshot_key in runtime_snapshots:
                    reject(code)
                runtime_snapshots[snapshot_key] = event

        ready_keys = set()
        for sample in runtime_ready["samples"]:
            key = (
                sample["client"],
                sample["connectionGeneration"],
            )
            if (key in ready_keys
                    or key not in runtime_opens
                    or key not in runtime_readies):
                reject(code)
            ready_keys.add(key)
            opened = runtime_opens[key]
            ready = runtime_readies[key]
            expected = {
                "openedAtMonotonicMs": opened["atMonotonicMs"],
                "openedAtUnixMs": opened["atUnixMs"],
                "readyAtMonotonicMs": ready["atMonotonicMs"],
                "readyAtUnixMs": ready["atUnixMs"],
                "readyFrameSha256": ready["payload"]["frameSha256"],
            }
            claimed = {
                name: sample[name] for name in expected
            }
            if canonical(claimed) != canonical(expected):
                reject(code)
        if ready_keys != {
                (client, 1) for client in range(1, 5)}:
            reject(code)

        consumed_snapshots = set()
        for sample in ui_state_lag["samples"]:
            key = (
                sample["client"],
                sample["connectionGeneration"],
                sample["probeSeq"],
            )
            if key in consumed_snapshots or key not in runtime_snapshots:
                reject(code)
            consumed_snapshots.add(key)
            snapshot = runtime_snapshots[key]
            expected = {
                "observedAtMonotonicMs": snapshot["atMonotonicMs"],
                "observedAtUnixMs": snapshot["atUnixMs"],
                "snapshotFrameSha256":
                    snapshot["payload"]["frameSha256"],
            }
            claimed = {
                name: sample[name] for name in expected
            }
            if canonical(claimed) != canonical(expected):
                reject(code)
        if consumed_snapshots != set(runtime_snapshots):
            reject(code)
        return {
            "runtimeReadySampleCount": len(ready_keys),
            "uiStateLagSampleCount": len(consumed_snapshots),
            "runtimeSnapshotEventCount": len(runtime_snapshots),
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_species_load_samples_bytes(
        raw: bytes,
        expected_binding: object,
        expected_mode: str) -> dict:
    """Validate real provider response bytes and recompute request evidence."""
    code = "PHASE5_SPECIES_LOAD_SAMPLES_INVALID"
    top_fields = {
        "schemaVersion", "kind", "runId", "challenge", "release",
        "geometry", "profile", "window", "mode", "samples",
    }
    sample_fields = {
        "sequence", "batchSequence", "slot",
        "startedAtMonotonicMs", "startedAtUnixMs",
        "settledAtMonotonicMs", "settledAtUnixMs",
        "httpStatus", "responseBodyBase64",
    }
    try:
        if (expected_mode not in {"normal", "burst"}
                or not isinstance(raw, bytes)
                or not 1 <= len(raw) <= MAX_PHASE5_SPECIES_SAMPLES_BYTES):
            reject(code)
        value = strict_json_bytes(raw, code)
        if (raw != phase5_canonical(value)
                or not _exact_object(value, top_fields)
                or type(value["schemaVersion"]) is not int
                or value["schemaVersion"] != 2
                or value["kind"]
                   != "isolated-equivalent-spark-phase5-species-load-samples"
                or value["mode"] != expected_mode):
            reject(code)
        binding_fields = (
            "runId", "challenge", "release", "geometry", "profile",
        )
        binding = _phase5_raw_binding_snapshot({
            name: value[name] for name in binding_fields
        }, code)
        expected = _phase5_raw_binding_snapshot(expected_binding, code)
        if canonical(binding) != canonical(expected):
            reject(code)
        window = value["window"]
        _validate_phase5_raw_window(window, code)
        samples = value["samples"]
        normal_minimum = math.floor(
            PHASE5_WINDOW_DURATION_MS / 2000 * 0.95)
        normal_maximum = PHASE5_WINDOW_DURATION_MS // 2000 + 1
        burst_minimum_batches = math.floor(
            PHASE5_WINDOW_DURATION_MS / 10_000 * 0.95)
        burst_maximum_batches = PHASE5_WINDOW_DURATION_MS // 10_000 + 1
        if not isinstance(samples, list):
            reject(code)
        if expected_mode == "normal":
            if not normal_minimum <= len(samples) <= normal_maximum:
                reject(code)
            slots_per_batch = 1
        else:
            if (len(samples) % 4 != 0
                    or not burst_minimum_batches
                           <= len(samples) // 4
                           <= burst_maximum_batches):
                reject(code)
            slots_per_batch = 4

        latencies = []
        started_monotonic = []
        started_unix = []
        settled_monotonic = []
        settled_unix = []
        for index, sample in enumerate(samples, start=1):
            expected_batch = (index - 1) // slots_per_batch + 1
            expected_slot = (index - 1) % slots_per_batch + 1
            if (not _exact_object(sample, sample_fields)
                    or type(sample["sequence"]) is not int
                    or sample["sequence"] != index
                    or type(sample["batchSequence"]) is not int
                    or sample["batchSequence"] != expected_batch
                    or type(sample["slot"]) is not int
                    or sample["slot"] != expected_slot
                    or type(sample["httpStatus"]) is not int
                    or sample["httpStatus"] != 200):
                reject(code)
            latency = _phase5_dual_clock_interval(
                sample["startedAtMonotonicMs"],
                sample["startedAtUnixMs"],
                sample["settledAtMonotonicMs"],
                sample["settledAtUnixMs"],
                window,
                code,
            )
            if latency > 15_000:
                reject(code)
            response_body_base64 = sample["responseBodyBase64"]
            maximum_encoded_response_bytes = 4 * (
                (MAX_PHASE5_SPECIES_RESPONSE_BYTES + 2) // 3
            )
            if (not isinstance(response_body_base64, str)
                    or len(response_body_base64)
                       > maximum_encoded_response_bytes):
                reject(code)
            response_body = decode_canonical_base64(
                response_body_base64, code)
            if not 1 <= len(response_body) <= MAX_PHASE5_SPECIES_RESPONSE_BYTES:
                reject(code)
            response = strict_json_bytes(response_body, code)
            if (not isinstance(response, dict)
                    or not isinstance(response.get("choices"), list)
                    or not response["choices"]
                    or not isinstance(response["choices"][0], dict)
                    or not isinstance(
                        response["choices"][0].get("message"), dict)
                    or not isinstance(
                        response["choices"][0]["message"].get("content"),
                        str)):
                reject(code)
            content = response["choices"][0]["message"]["content"]
            token = strict_json_bytes(content.encode("utf-8"), code)
            if (not _exact_object(token, {"ok"})
                    or token["ok"] is not True):
                reject(code)
            latencies.append(latency)
            started_monotonic.append(sample["startedAtMonotonicMs"])
            started_unix.append(sample["startedAtUnixMs"])
            settled_monotonic.append(sample["settledAtMonotonicMs"])
            settled_unix.append(sample["settledAtUnixMs"])

        batch_monotonic = started_monotonic[::slots_per_batch]
        batch_unix = started_unix[::slots_per_batch]
        if any(
                right <= left
                for stream in (batch_monotonic, batch_unix)
                for left, right in zip(stream, stream[1:])):
            reject(code)
        if expected_mode == "normal":
            if (started_monotonic[0]
                    - window["startedAtMonotonicMs"] > 4000
                    or started_unix[0]
                    - window["startedAtUnixMs"] > 4000
                    or window["endedAtMonotonicMs"]
                    - max(settled_monotonic) > 10_000
                    or window["endedAtUnixMs"]
                    - max(settled_unix) > 10_000
                    or any(
                        right - left > 10_000
                        for stream in (batch_monotonic, batch_unix)
                        for left, right in zip(stream, stream[1:]))):
                reject(code)
        else:
            final_settled_monotonic = max(settled_monotonic)
            final_settled_unix = max(settled_unix)
            if (batch_monotonic[0]
                    - window["startedAtMonotonicMs"] > 20_000
                    or batch_unix[0]
                    - window["startedAtUnixMs"] > 20_000
                    or window["endedAtMonotonicMs"]
                    - final_settled_monotonic > 50_000
                    or window["endedAtUnixMs"]
                    - final_settled_unix > 50_000
                    or any(
                        right - left > 50_000
                        for stream in (batch_monotonic, batch_unix)
                        for left, right in zip(stream, stream[1:]))):
                reject(code)
            for offset in range(0, len(samples), slots_per_batch):
                mono_group = started_monotonic[
                    offset:offset + slots_per_batch]
                unix_group = started_unix[
                    offset:offset + slots_per_batch]
                if (max(mono_group) - min(mono_group) > 100
                        or max(unix_group) - min(unix_group) > 100
                        or any(
                            right < left
                            for stream in (mono_group, unix_group)
                            for left, right in zip(stream, stream[1:]))):
                    reject(code)
        return {
            "value": value,
            "requestCount": len(samples),
            "errors": 0,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "latenciesMs": latencies,
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_raw_manifest_structure(
        value: object,
        expected_binding: object | None = None) -> dict:
    code = "PHASE5_RAW_MANIFEST_INVALID"
    top_fields = {
        "schemaVersion", "kind", "runId", "challenge", "release",
        "geometry", "profile", "window", "artifacts",
    }
    item_fields = {"artifact", "path", "byteLength", "sha256"}
    try:
        raw = canonical(value)
        manifest = strict_json_bytes(raw, code)
        if (raw != canonical(manifest)
                or not _exact_object(manifest, top_fields)
                or type(manifest["schemaVersion"]) is not int
                or manifest["schemaVersion"] != 2
                or manifest["kind"]
                   != "isolated-equivalent-spark-phase5-raw-manifest"):
            reject(code)
        binding = _phase5_raw_binding_snapshot({
            name: manifest[name]
            for name in ("runId", "challenge", "release", "geometry", "profile")
        }, code)
        _validate_phase5_raw_window(manifest["window"], code)
        artifacts = manifest["artifacts"]
        if (not isinstance(artifacts, list)
                or len(artifacts) != len(PHASE5_RAW_ARTIFACTS)):
            reject(code)
        for item, (artifact, path) in zip(
                artifacts, PHASE5_RAW_ARTIFACTS, strict=True):
            if (not _exact_object(item, item_fields)
                    or item["artifact"] != artifact
                    or item["path"] != path
                    or type(item["byteLength"]) is not int
                    or not 1
                           <= item["byteLength"]
                           <= PHASE5_RAW_ARTIFACT_MAX_BYTES[artifact]
                    or not isinstance(item["sha256"], str)
                    or HEX.fullmatch(item["sha256"]) is None):
                reject(code)
        if expected_binding is not None:
            expected = _phase5_raw_binding_snapshot(expected_binding, code)
            if canonical(binding) != canonical(expected):
                reject(code)
        return manifest
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_raw_manifest_bytes(
        raw: bytes,
        expected_binding: object | None = None) -> dict:
    code = "PHASE5_RAW_MANIFEST_INVALID"
    try:
        if (not isinstance(raw, bytes)
                or len(raw) > MAX_PHASE5_RAW_MANIFEST_BYTES):
            reject(code)
        value = strict_json_bytes(raw, code)
        if raw != phase5_canonical(value):
            reject(code)
        return validate_phase5_raw_manifest_structure(
            value, expected_binding)
    except AcceptanceError:
        raise
    except (OverflowError, RecursionError, TypeError,
            UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def phase5_raw_manifest_from_blobs(
        binding: object,
        window: object,
        blobs: object) -> dict:
    code = "PHASE5_RAW_MANIFEST_INVALID"
    try:
        trusted_binding = _phase5_raw_binding_snapshot(binding, code)
        window_raw = canonical(window)
        trusted_window = strict_json_bytes(window_raw, code)
        if window_raw != canonical(trusted_window):
            reject(code)
        _validate_phase5_raw_window(trusted_window, code)
        names = {name for name, _path in PHASE5_RAW_ARTIFACTS}
        if type(blobs) is not dict or set(blobs) != names:
            reject(code)
        artifacts = []
        for artifact, path in PHASE5_RAW_ARTIFACTS:
            body = blobs[artifact]
            if (not isinstance(body, bytes)
                    or not 1
                           <= len(body)
                           <= PHASE5_RAW_ARTIFACT_MAX_BYTES[artifact]):
                reject(code)
            artifacts.append({
                "artifact": artifact,
                "path": path,
                "byteLength": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            })
        value = {
            "schemaVersion": 2,
            "kind": "isolated-equivalent-spark-phase5-raw-manifest",
            **trusted_binding,
            "window": trusted_window,
            "artifacts": artifacts,
        }
        return validate_phase5_raw_manifest_structure(
            value, trusted_binding)
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def phase5_raw_artifact_digests(value: object) -> dict[str, str]:
    manifest = validate_phase5_raw_manifest_structure(value)
    return {
        item["artifact"]: item["sha256"]
        for item in manifest["artifacts"]
    }


def load_phase5_raw_manifest_bundle(
        root: Path,
        expected_binding: object) -> dict:
    """Single-read the fixed raw manifest and every one of its fourteen leaves."""
    code = "PHASE5_RAW_MANIFEST_INVALID"
    try:
        bundle_root = Path(root)
        if not bundle_root.is_absolute():
            reject(code)
        manifest_path = _phase5_exact_bundle_path(
            bundle_root,
            "acceptance-evidence/phase5-raw-manifest.json",
            code,
        )
        manifest_raw = read_regular_file_no_follow(
            manifest_path,
            code,
            max_bytes=MAX_PHASE5_RAW_MANIFEST_BYTES,
        )
        manifest = validate_phase5_raw_manifest_bytes(
            manifest_raw, expected_binding)
        blobs = {}
        for item, (artifact, path) in zip(
                manifest["artifacts"],
                PHASE5_RAW_ARTIFACTS,
                strict=True):
            if item["artifact"] != artifact or item["path"] != path:
                reject(code)
            leaf = _phase5_exact_bundle_path(bundle_root, path, code)
            raw = read_regular_file_no_follow(
                leaf,
                code,
                max_bytes=PHASE5_RAW_ARTIFACT_MAX_BYTES[artifact],
            )
            _phase5_exact_bundle_path(bundle_root, path, code)
            if (len(raw) != item["byteLength"]
                    or hashlib.sha256(raw).hexdigest() != item["sha256"]):
                reject(code)
            blobs[artifact] = raw
        return {
            "manifest": manifest,
            "manifestRaw": manifest_raw,
            "manifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
            "blobs": blobs,
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OSError, OverflowError,
            TypeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_summary_raw_manifest_boundary(
        value: object,
        root: Path,
        expected_binding: object) -> dict:
    code = "PHASE5_RAW_MANIFEST_INVALID"
    try:
        summary_raw = canonical(value)
        summary = strict_json_bytes(summary_raw, code)
        if summary_raw != canonical(summary):
            reject(code)
        try:
            validate_phase5_summary_structure(summary)
        except AcceptanceError as exc:
            raise AcceptanceError(code) from exc
        binding = _phase5_raw_binding_snapshot(expected_binding, code)
        summary_binding = {
            name: summary[name]
            for name in ("runId", "challenge", "release", "geometry", "profile")
        }
        if canonical(summary_binding) != canonical(binding):
            reject(code)
        loaded = load_phase5_raw_manifest_bundle(root, binding)
        manifest = loaded["manifest"]
        if canonical(summary["window"]) != canonical(manifest["window"]):
            reject(code)
        digests = phase5_raw_artifact_digests(manifest)
        if (any(summary["rawArtifacts"][name] != digest
                for name, digest in digests.items())
                or summary["rawArtifacts"]["rawManifestSha256"]
                   != loaded["manifestSha256"]):
            reject(code)
        loaded["summary"] = summary
        loaded["binding"] = binding
        return loaded
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_summary_render_boundary(
        value: object,
        root: Path,
        expected_binding: object) -> dict:
    """Bind the summary render projection to manifest-owned raw observations."""
    code = "PHASE5_SUMMARY_RENDER_INVALID"
    try:
        loaded = validate_phase5_summary_raw_manifest_boundary(
            value, root, expected_binding)
        render = validate_phase5_render_samples_bytes(
            loaded["blobs"]["rawRenderSamplesSha256"],
            loaded["binding"],
        )
        latency = loaded["summary"]["acceptanceProjection"]["latency"]
        claimed = {
            name: latency[name]
            for name in (
                "renderP95BlockFraction",
                "renderP99BlockFraction",
            )
        }
        if phase5_canonical(claimed) != phase5_canonical(
                render["projection"]):
            reject(code)
        return {
            "loaded": loaded,
            "render": render,
        }
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_summary_latency_boundary(
        value: object,
        root: Path,
        expected_binding: object) -> dict:
    """Recompute every summary latency field from one manifest-owned bundle."""
    code = "PHASE5_SUMMARY_LATENCY_INVALID"
    try:
        loaded = validate_phase5_summary_raw_manifest_boundary(
            value, root, expected_binding)
        runtime_ready = validate_phase5_runtime_ready_samples_bytes(
            loaded["blobs"]["rawRuntimeReadySamplesSha256"],
            loaded["binding"],
        )
        ui_state_lag = validate_phase5_ui_state_lag_samples_bytes(
            loaded["blobs"]["rawUiStateLagSamplesSha256"],
            loaded["binding"],
        )
        render = validate_phase5_render_samples_bytes(
            loaded["blobs"]["rawRenderSamplesSha256"],
            loaded["binding"],
        )
        projection = {
            **runtime_ready["projection"],
            **ui_state_lag["projection"],
            **render["projection"],
        }
        if phase5_canonical(
                loaded["summary"]["acceptanceProjection"]["latency"]
                ) != phase5_canonical(projection):
            reject(code)
        return {
            "loaded": loaded,
            "runtimeReady": runtime_ready,
            "uiStateLag": ui_state_lag,
            "render": render,
            "projection": projection,
        }
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_summary_species_boundary(
        value: object,
        root: Path,
        expected_binding: object) -> dict:
    """Recompute provider counts and digests from manifest-owned responses."""
    code = "PHASE5_SUMMARY_SPECIES_INVALID"
    try:
        loaded = validate_phase5_summary_raw_manifest_boundary(
            value, root, expected_binding)
        binding = loaded["binding"]
        normal = validate_phase5_species_load_samples_bytes(
            loaded["blobs"]["speciesNormalSamplesSha256"],
            binding,
            "normal",
        )
        burst = validate_phase5_species_load_samples_bytes(
            loaded["blobs"]["speciesBurstSamplesSha256"],
            binding,
            "burst",
        )
        projection = {
            "endpoint": binding["profile"]["speciesEndpoint"],
            "model": binding["profile"]["speciesModel"],
            "normalRequests": normal["requestCount"],
            "burstRequests": burst["requestCount"],
            "errors": 0,
            "normalLatencySamplesSha256": normal["sha256"],
            "burstLatencySamplesSha256": burst["sha256"],
        }
        claimed = loaded["summary"]["acceptanceProjection"]["speciesLoad"]
        if canonical(claimed) != canonical(projection):
            reject(code)
        return {
            "loaded": loaded,
            "normal": normal,
            "burst": burst,
            "projection": projection,
        }
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _validate_phase5_summary_nonfault_loaded(
        loaded: object,
        signed_transport_projection: object,
        code: str) -> dict:
    """Recompute non-fault facts from an already-owned manifest bundle."""
    try:
        if (not isinstance(loaded, dict)
                or not isinstance(loaded.get("blobs"), dict)
                or not isinstance(loaded.get("summary"), dict)
                or not isinstance(loaded.get("binding"), dict)):
            reject(code)
        binding = loaded["binding"]
        runtime_ready = validate_phase5_runtime_ready_samples_bytes(
            loaded["blobs"]["rawRuntimeReadySamplesSha256"],
            binding,
        )
        ui_state_lag = validate_phase5_ui_state_lag_samples_bytes(
            loaded["blobs"]["rawUiStateLagSamplesSha256"],
            binding,
        )
        render = validate_phase5_render_samples_bytes(
            loaded["blobs"]["rawRenderSamplesSha256"],
            binding,
        )
        latency_projection = {
            **runtime_ready["projection"],
            **ui_state_lag["projection"],
            **render["projection"],
        }
        summary = loaded["summary"]
        if phase5_canonical(
                summary["acceptanceProjection"]["latency"]
                ) != phase5_canonical(latency_projection):
            reject(code)

        normal = validate_phase5_species_load_samples_bytes(
            loaded["blobs"]["speciesNormalSamplesSha256"],
            binding,
            "normal",
        )
        burst = validate_phase5_species_load_samples_bytes(
            loaded["blobs"]["speciesBurstSamplesSha256"],
            binding,
            "burst",
        )
        species_projection = {
            "endpoint": binding["profile"]["speciesEndpoint"],
            "model": binding["profile"]["speciesModel"],
            "normalRequests": normal["requestCount"],
            "burstRequests": burst["requestCount"],
            "errors": 0,
            "normalLatencySamplesSha256": normal["sha256"],
            "burstLatencySamplesSha256": burst["sha256"],
        }
        if canonical(
                summary["acceptanceProjection"]["speciesLoad"]
                ) != canonical(species_projection):
            reject(code)

        client_observations = validate_phase5_client_observations_bytes(
            loaded["blobs"]["clientObservationsSha256"],
            binding,
            signed_transport_projection,
        )
        latency_client_binding = (
            validate_phase5_latency_client_cross_binding(
                runtime_ready,
                ui_state_lag,
                client_observations,
            )
        )
        zero_stability = {
            "hotClientAbnormalCloses": 0,
            "hotClientReconnectStorms": 0,
            "hotClientUnderruns": 0,
            "pcmCorruptions": 0,
            "cursorDiscontinuitiesUnexpected": 0,
        }
        client_projection = client_observations["projection"]
        if (canonical(
                summary["acceptanceProjection"]["stability"]
                ) != canonical(zero_stability)
                or client_projection["pcmCorruptions"] != 0
                or client_projection[
                    "cursorDiscontinuitiesUnexpected"] != 0):
            reject(code)
        return {
            "loaded": loaded,
            "runtimeReady": runtime_ready,
            "uiStateLag": ui_state_lag,
            "render": render,
            "latencyProjection": latency_projection,
            "normalSpecies": normal,
            "burstSpecies": burst,
            "species": {
                "projection": species_projection,
            },
            "clientObservations": client_observations,
            "latencyClientBinding": latency_client_binding,
        }
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_summary_nonfault_boundary(
        value: object,
        root: Path,
        expected_binding: object,
        signed_transport_projection: object) -> dict:
    """Validate non-fault raw with an explicit, already-trusted projection.

    This compatibility boundary does not establish projection provenance.
    New trusted callers must use
    ``validate_phase5_summary_composite_raw_boundary`` instead.
    """
    code = "PHASE5_SUMMARY_NONFAULT_INVALID"
    try:
        loaded = validate_phase5_summary_raw_manifest_boundary(
            value, root, expected_binding)
        return _validate_phase5_summary_nonfault_loaded(
            loaded,
            signed_transport_projection,
            code,
        )
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _validate_phase5_summary_composite_raw_boundary(
        value: object,
        root: Path,
        run_binding: object,
        *,
        verifier_path: Path | None = None,
        verifier_runner=None,
        verifier_identity: object | None = None,
        node_executable: Path | None = None) -> dict:
    """Bind non-fault raw only to the same fixed signed fault composite.

    This closes signed-transport projection provenance, but deliberately does
    not claim the pending capture-nonce/process-possession proof.
    """
    code = "PHASE5_SUMMARY_COMPOSITE_RAW_INVALID"
    try:
        binding_raw = canonical(run_binding)
        trusted_run_binding = strict_json_bytes(binding_raw, code)
        if (not isinstance(trusted_run_binding, dict)
                or binding_raw != canonical(trusted_run_binding)):
            reject(code)
        try:
            validate_fault_session_binding(trusted_run_binding)
        except AcceptanceError as exc:
            raise AcceptanceError(code) from exc
        shared_fields = (
            "runId", "challenge", "release", "geometry", "profile",
        )
        expected_binding = {
            name: trusted_run_binding[name]
            for name in shared_fields
        }
        loaded = validate_phase5_summary_raw_manifest_boundary(
            value,
            root,
            expected_binding,
        )
        fault_composite = (
            _validate_phase5_summary_fault_boundary(
                loaded["summary"],
                loaded["blobs"]["faultEventsSha256"],
                trusted_run_binding,
                include_client_projection=True,
                verifier_path=verifier_path,
                verifier_runner=verifier_runner,
                verifier_identity=verifier_identity,
                node_executable=node_executable,
            )
        )
        result = _validate_phase5_summary_nonfault_loaded(
            loaded,
            fault_composite["signedTransportProjection"],
            code,
        )
        result["faultComposite"] = fault_composite
        return result
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def validate_phase5_summary_composite_raw_boundary(
        value: object,
        root: Path,
        run_binding: object) -> dict:
    """Validate the full raw boundary through the fixed signed verifier.

    Verifier path and runner injection are deliberately private test seams:
    callers of this trust boundary can only execute the release-owned closure.
    """
    return _validate_phase5_summary_composite_raw_boundary(
        value,
        root,
        run_binding,
        verifier_identity=_PHASE5_SUMMARY_OWNED_VERIFIER_IDENTITY,
    )


def phase5_fault_verifier_path() -> Path:
    """Resolve only the release-owned verifier closure or its source-tree twin."""
    deployed = (
        Path(__file__).resolve().parent
        / "phase5-fault-verifier"
        / "verify-phase5-fault-evidence.mjs"
    )
    source = (
        Path(__file__).resolve().parents[1]
        / "runtime"
        / "tools"
        / "verify-phase5-fault-evidence.mjs"
    )
    for candidate in (deployed, source):
        if candidate.is_file():
            return candidate
    reject("PHASE5_FAULT_VALIDATION_REQUIRED")


def _phase5_fault_verifier_identity_from_summary(summary: dict) -> dict:
    """Bind summary declarations to this validator's pinned verifier closure."""
    code = "PHASE5_FAULT_VALIDATION_REQUIRED"
    try:
        acceptance_tool = summary["acceptanceTool"]
        declared = {
            deploy_name: acceptance_tool[summary_name]
            for deploy_name, summary_name
            in PHASE5_FAULT_VERIFIER_SUMMARY_FIELDS
        }
        pinned = dict(PHASE5_FAULT_VERIFIER_PINNED_SHA256)
        if (set(declared) != set(PHASE5_FAULT_VERIFIER_DEPLOY_NAMES)
                or set(pinned) != set(PHASE5_FAULT_VERIFIER_DEPLOY_NAMES)
                or declared != pinned
                or any(not isinstance(digest, str)
                       or HEX.fullmatch(digest) is None
                       for digest in pinned.values())):
            reject(code)
        return pinned
    except AcceptanceError:
        raise
    except (KeyError, TypeError) as exc:
        raise AcceptanceError(code) from exc


def _phase5_fault_verifier_snapshots(
        verifier_path: Path,
        expected_identity: object) -> dict[str, bytes]:
    code = "PHASE5_FAULT_VALIDATION_REQUIRED"
    try:
        identity_raw = canonical(expected_identity)
        identity = strict_json_bytes(identity_raw, code)
        if (not isinstance(identity, dict)
                or identity_raw != canonical(identity)
                or any(HEX.fullmatch(identity.get(name, "")) is None
                       for name in PHASE5_FAULT_VERIFIER_DEPLOY_NAMES)):
            reject(code)
        entry = Path(verifier_path)
        if (not entry.is_absolute()
                or entry.name != "verify-phase5-fault-evidence.mjs"):
            reject(code)
        paths = {
            PHASE5_FAULT_VERIFIER_DEPLOY_NAMES[0]: entry,
            **{
                name: entry.parent / "lib" / Path(name).name
                for name in PHASE5_FAULT_VERIFIER_DEPLOY_NAMES[1:]
            },
        }
        snapshots = {}
        total_bytes = 0
        for name in PHASE5_FAULT_VERIFIER_DEPLOY_NAMES:
            raw = read_regular_file_no_follow(paths[name], code)
            total_bytes += len(raw)
            if (len(raw) > MAX_PHASE5_FAULT_MODULE_BYTES
                    or total_bytes > MAX_PHASE5_FAULT_MODULE_BYTES
                    or hashlib.sha256(raw).hexdigest() != identity[name]):
                reject(code)
            snapshots[name] = raw
        return snapshots
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def phase5_capture_proof_verifier_path() -> Path:
    """Resolve only the release-owned capture verifier or source-tree twin."""
    deployed = (
        Path(__file__).resolve().parent
        / "phase5-fault-verifier"
        / "verify-phase5-capture-proof.mjs"
    )
    source = (
        Path(__file__).resolve().parents[1]
        / "runtime"
        / "tools"
        / "verify-phase5-capture-proof.mjs"
    )
    for candidate in (deployed, source):
        if candidate.is_file():
            return candidate
    reject("PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED")


def _phase5_capture_verifier_snapshots(
        verifier_path: Path,
        expected_identity: object) -> dict[str, bytes]:
    code = "PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED"
    try:
        identity_raw = phase5_canonical(expected_identity)
        identity = strict_json_bytes(identity_raw, code)
        if (type(identity) is not dict
                or identity_raw != phase5_canonical(identity)
                or set(identity) != set(PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES)
                or any(HEX.fullmatch(identity.get(name, "")) is None
                       for name in PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES)):
            reject(code)
        entry = Path(verifier_path)
        if (not entry.is_absolute()
                or entry.name != "verify-phase5-capture-proof.mjs"):
            reject(code)
        if entry.parent.name == "phase5-fault-verifier":
            deploy_root = entry.parent.parent
            paths = {
                name: (
                    entry
                    if name == PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES[0]
                    else deploy_root.joinpath(*name.split("/"))
                )
                for name in PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES
            }
        elif (entry.parent.name == "tools"
              and entry.parent.parent.name == "runtime"):
            runtime_root = entry.parent.parent
            paths = {
                PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES[0]: entry,
                "phase5-fault-verifier/lib/phase5-fault-evidence.mjs":
                    entry.parent / "lib" / "phase5-fault-evidence.mjs",
                "src/capture/phase5-capture-proof.js":
                    runtime_root / "src" / "capture"
                    / "phase5-capture-proof.js",
                "src/capture/capture-wire.js":
                    runtime_root / "src" / "capture" / "capture-wire.js",
            }
        else:
            reject(code)
        snapshots = {}
        total_bytes = 0
        for name in PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES:
            raw = read_regular_file_no_follow(paths[name], code)
            total_bytes += len(raw)
            if (len(raw) > MAX_PHASE5_FAULT_MODULE_BYTES
                    or total_bytes > MAX_PHASE5_FAULT_MODULE_BYTES
                    or hashlib.sha256(raw).hexdigest() != identity[name]):
                reject(code)
            snapshots[name] = raw
        return snapshots
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, RuntimeError, TypeError, UnicodeError,
            ValueError) as exc:
        raise AcceptanceError(code) from exc


def _phase5_node_executable(explicit: Path | None = None) -> Path:
    code = "PHASE5_FAULT_VALIDATION_REQUIRED"
    configured = (
        explicit
        or os.environ.get("PHASE5_APPROVED_NODE_EXE")
        or os.environ.get("PHASE6_APPROVED_NODE_EXE")
    )
    try:
        path = Path(configured) if configured is not None else None
        if path is None or not path.is_absolute():
            reject(code)
        return path
    except AcceptanceError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _open_phase5_node_executable(path: Path) -> int:
    code = "PHASE5_FAULT_VALIDATION_REQUIRED"
    descriptor = None
    directory_descriptor = None
    try:
        candidate = Path(path)
        if not candidate.is_absolute():
            reject(code)
        file_flags = (
            os.O_RDONLY
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        if os.name == "posix":
            parts = candidate.parts
            relative_parts = parts[1:]
            if (not relative_parts
                    or parts[0] != candidate.anchor
                    or any(part in {"", ".", ".."} for part in relative_parts)):
                reject(code)
            directory_flags = (
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            directory_descriptor = os.open(candidate.anchor, directory_flags)
            for part in relative_parts[:-1]:
                next_descriptor = os.open(
                    part,
                    directory_flags,
                    dir_fd=directory_descriptor,
                )
                os.close(directory_descriptor)
                directory_descriptor = next_descriptor
            descriptor = os.open(
                relative_parts[-1],
                file_flags,
                dir_fd=directory_descriptor,
            )
            os.close(directory_descriptor)
            directory_descriptor = None
        elif os.name == "nt":
            _assert_absolute_no_reparse_chain(candidate, code)
            descriptor = os.open(candidate, file_flags)
            _assert_absolute_no_reparse_chain(candidate, code)
        else:
            reject(code)
        before = os.fstat(descriptor)
        after = os.fstat(descriptor)
        stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
        if (not stat.S_ISREG(before.st_mode)
                or before.st_size < 1
                or not stat.S_ISREG(after.st_mode)
                or any(getattr(before, name) != getattr(after, name)
                       for name in stable_fields)):
            reject(code)
        return descriptor
    except AcceptanceError:
        if directory_descriptor is not None:
            os.close(directory_descriptor)
        if descriptor is not None:
            os.close(descriptor)
        raise
    except (OSError, TypeError, ValueError) as exc:
        if directory_descriptor is not None:
            os.close(directory_descriptor)
        if descriptor is not None:
            os.close(descriptor)
        raise AcceptanceError(code) from exc


def _execute_phase5_memory_verifier(
        operation: str,
        snapshots: object,
        envelope: bytes,
        node_executable: Path | None,
        *,
        code: str,
        max_envelope_bytes: int,
        max_result_bytes: int) -> bytes:
    operation_modules = {
        "fault-validation": PHASE5_FAULT_VERIFIER_DEPLOY_NAMES,
        "fault-validation-with-client-projection":
            PHASE5_FAULT_VERIFIER_DEPLOY_NAMES,
        "capture-proof-validation":
            PHASE5_CAPTURE_VERIFIER_DEPLOY_NAMES,
    }
    try:
        expected_names = operation_modules.get(operation)
        if (not isinstance(envelope, bytes)
                or len(envelope) > max_envelope_bytes
                or expected_names is None
                or type(snapshots) is not dict
                or set(snapshots) != set(expected_names)
                or any(not isinstance(snapshots[name], bytes)
                       for name in expected_names)):
            reject(code)
        package = canonical({
            "schemaVersion": 2,
            "kind": "phase5-fault-verifier-memory-package",
            "operation": operation,
            "modules": {
                name: base64.b64encode(snapshots[name]).decode("ascii")
                for name in expected_names
            },
            "envelope": base64.b64encode(envelope).decode("ascii"),
        })
        node_path = _phase5_node_executable(node_executable)
        environment = {}
        if os.name == "nt" and os.environ.get("SystemRoot"):
            # Windows Node needs the OS directory for CSPRNG initialization.
            # Production runs on Linux; do not broaden this into inheritance.
            environment["SystemRoot"] = os.environ["SystemRoot"]
        node_descriptor = _open_phase5_node_executable(node_path)
        run_options = {}
        try:
            if sys.platform.startswith("linux"):
                node_command = f"/proc/self/fd/{node_descriptor}"
                run_options["pass_fds"] = (node_descriptor,)
            elif os.name == "nt":
                # Local Windows verification keeps the no-reparse handle open.
                # The production DGX path is the Linux descriptor execution above.
                node_command = os.fspath(node_path)
            else:
                reject(code)
            completed = subprocess.run(
                [
                    node_command,
                    "--no-warnings",
                    "--experimental-vm-modules",
                    "--input-type=module",
                    "--eval",
                    PHASE5_FAULT_MEMORY_RUNNER,
                ],
                input=package,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=30,
                env=environment,
                **run_options,
            )
        finally:
            os.close(node_descriptor)
    except (AcceptanceError, OSError, subprocess.SubprocessError,
            TypeError, ValueError) as exc:
        raise AcceptanceError(code) from exc
    if (getattr(completed, "returncode", None) != 0
            or getattr(completed, "stderr", None) != b""
            or not isinstance(getattr(completed, "stdout", None), bytes)
            or len(completed.stdout) > max_result_bytes):
        reject(code)
    return completed.stdout


def _run_phase5_fault_verifier(
        verifier_path: Path,
        envelope: bytes,
        expected_identity: object,
        node_executable: Path | None = None,
        *,
        include_client_projection: bool = False) -> bytes:
    code = "PHASE5_FAULT_VALIDATION_REQUIRED"
    try:
        if type(include_client_projection) is not bool:
            reject(code)
        snapshots = _phase5_fault_verifier_snapshots(
            verifier_path,
            expected_identity,
        )
        operation = (
            "fault-validation-with-client-projection"
            if include_client_projection
            else "fault-validation"
        )
        return _execute_phase5_memory_verifier(
            operation,
            snapshots,
            envelope,
            node_executable,
            code=code,
            max_envelope_bytes=MAX_PHASE5_FAULT_ENVELOPE_BYTES,
            max_result_bytes=MAX_PHASE5_FAULT_RESULT_BYTES,
        )
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, RuntimeError, subprocess.SubprocessError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _run_phase5_capture_proof_verifier(
        verifier_path: Path,
        envelope: bytes,
        expected_identity: object,
        node_executable: Path | None = None) -> bytes:
    code = "PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED"
    try:
        snapshots = _phase5_capture_verifier_snapshots(
            verifier_path,
            expected_identity,
        )
        return _execute_phase5_memory_verifier(
            "capture-proof-validation",
            snapshots,
            envelope,
            node_executable,
            code=code,
            max_envelope_bytes=MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES,
            max_result_bytes=MAX_PHASE5_CAPTURE_PROOF_RESULT_BYTES,
        )
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, RuntimeError, subprocess.SubprocessError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _validate_phase5_summary_fault_boundary(
        value: object,
        fault_events_raw: bytes,
        run_binding: object,
        *,
        include_client_projection: bool,
        verifier_path: Path | None = None,
        verifier_runner=None,
        verifier_identity: object | None = None,
        node_executable: Path | None = None) -> dict:
    """Recompute fault validation through the fixed Node composite.

    This boundary intentionally does not trust the producer's summary result.
    It snapshots all Python inputs into canonical plain JSON, invokes the fixed
    verifier with one exact stdin envelope, and then exact-binds the verifier
    result back to the summary and staging run binding.
    """
    code = "PHASE5_FAULT_VALIDATION_REQUIRED"
    try:
        if type(include_client_projection) is not bool:
            reject(code)
        summary_raw = canonical(value)
        summary = strict_json_bytes(summary_raw, "PHASE5_SUMMARY_INVALID")
        if summary_raw != canonical(summary):
            reject("PHASE5_SUMMARY_INVALID")
        validate_phase5_summary_structure(summary)
        if verifier_identity is _PHASE5_SUMMARY_OWNED_VERIFIER_IDENTITY:
            trusted_verifier_identity = (
                _phase5_fault_verifier_identity_from_summary(summary)
            )
        else:
            trusted_verifier_identity = verifier_identity

        binding_raw = canonical(run_binding)
        trusted_binding = strict_json_bytes(binding_raw, code)
        if binding_raw != canonical(trusted_binding):
            reject(code)
        try:
            validate_fault_session_binding(trusted_binding)
        except AcceptanceError as exc:
            raise AcceptanceError(code) from exc
        expected_session = {
            "signerSpkiSha256": trusted_binding["signerSpkiSha256"],
            "faultSessionEvidenceSha256":
                trusted_binding["faultSessionEvidenceSha256"],
        }
        shared_fields = (
            "runId", "challenge", "release", "geometry", "profile",
        )
        if (any(summary[name] != trusted_binding[name]
                for name in shared_fields)
                or summary["session"] != expected_session):
            reject(code)

        if (not isinstance(fault_events_raw, bytes)
                or len(fault_events_raw) > MAX_PHASE5_FAULT_ENVELOPE_BYTES):
            reject(code)
        evidence = strict_json_bytes(fault_events_raw, code)
        if not isinstance(evidence, dict) or fault_events_raw != canonical(evidence):
            reject(code)

        envelope = canonical({
            "evidence": evidence,
            "runBinding": trusted_binding,
        }) + b"\n"
        if len(envelope) > MAX_PHASE5_FAULT_ENVELOPE_BYTES:
            reject(code)
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc

    if verifier_runner is None:
        selected_verifier = phase5_fault_verifier_path()
        if (verifier_path is not None
                and Path(verifier_path) != selected_verifier):
            reject(code)
        runner = lambda path, body: _run_phase5_fault_verifier(
            path,
            body,
            trusted_verifier_identity,
            node_executable,
            include_client_projection=include_client_projection,
        )
    else:
        selected_verifier = verifier_path or phase5_fault_verifier_path()
        runner = verifier_runner
    try:
        result_raw = runner(selected_verifier, envelope)
        if (not isinstance(result_raw, bytes)
                or len(result_raw) > MAX_PHASE5_FAULT_RESULT_BYTES
                or not result_raw.endswith(b"\n")
                or result_raw.endswith(b"\n\n")):
            reject(code)
        result_body = result_raw[:-1]
        result = strict_json_bytes(result_body, code)
        if (not isinstance(result, dict)
                or result_raw != canonical(result) + b"\n"):
            reject(code)
        if include_client_projection:
            if (not _exact_object(result, {
                    "schemaVersion", "kind", "faultValidation",
                    "signedTransportProjection",
                    })
                    or type(result["schemaVersion"]) is not int
                    or result["schemaVersion"] != 1
                    or result["kind"]
                       != "phase5-fault-validation-with-client-projection-result"
                    or not isinstance(result["faultValidation"], dict)):
                reject(code)
            fault_result = result["faultValidation"]
        else:
            fault_result = result
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OSError, OverflowError, RecursionError,
            RuntimeError, subprocess.SubprocessError, TypeError,
            UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc

    fault_sha = hashlib.sha256(fault_events_raw).hexdigest()
    try:
        if (canonical(fault_result)
                != canonical(summary["faultValidation"])
                or any(summary[name] != trusted_binding[name]
                       or fault_result[name] != trusted_binding[name]
                       for name in shared_fields)
                or summary["window"] != fault_result["window"]
                or summary["session"] != expected_session
                or fault_result["signerSpkiSha256"]
                   != trusted_binding["signerSpkiSha256"]
                or fault_result["faultSessionEvidenceSha256"]
                   != trusted_binding["faultSessionEvidenceSha256"]
                or summary["rawArtifacts"]["faultEventsSha256"] != fault_sha
                or fault_result["evidence"]["faultEventsSha256"] != fault_sha):
            reject(code)
    except (KeyError, TypeError) as exc:
        raise AcceptanceError(code) from exc
    if include_client_projection:
        expected_binding = {
            name: trusted_binding[name]
            for name in shared_fields
        }
        owned_projection = _phase5_client_signed_transport_projection(
            result["signedTransportProjection"],
            expected_binding,
            fault_result["window"],
            code,
        )
        result["signedTransportProjection"] = owned_projection
        return result
    return fault_result


def validate_phase5_summary_fault_boundary(
        value: object,
        fault_events_raw: bytes,
        run_binding: object) -> dict:
    """Recompute the exact summary fault result through the fixed verifier.

    Verifier path and runner injection remain private to the implementation
    helper so callers cannot substitute their own trust authority.
    """
    return _validate_phase5_summary_fault_boundary(
        value,
        fault_events_raw,
        run_binding,
        include_client_projection=False,
        verifier_identity=_PHASE5_SUMMARY_OWNED_VERIFIER_IDENTITY,
    )


def validate_phase5_summary_fault_projection_boundary(
        value: object,
        fault_events_raw: bytes,
        run_binding: object) -> dict:
    """Return fault validation plus its fixed-verifier signed projection."""
    return _validate_phase5_summary_fault_boundary(
        value,
        fault_events_raw,
        run_binding,
        include_client_projection=True,
        verifier_identity=_PHASE5_SUMMARY_OWNED_VERIFIER_IDENTITY,
    )


def canonical_machine_addresses(addresses: object) -> list[str]:
    if not isinstance(addresses, list):
        reject("EQUIVALENT_STAGING_REQUIRED")
    parsed: dict[tuple[int, bytes], str] = {}
    for raw in addresses:
        if not isinstance(raw, str):
            reject("EQUIVALENT_STAGING_REQUIRED")
        candidate = raw.split("%", 1)[0]
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError as exc:
            raise AcceptanceError("EQUIVALENT_STAGING_REQUIRED") from exc
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        if address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast:
            continue
        parsed[(address.version, address.packed)] = address.compressed.lower()
    return [parsed[key] for key in sorted(parsed)]


def assert_machine_address_sets_are_distinct(production: object, staging: object) -> None:
    prod = set(canonical_machine_addresses(production))
    stage = set(canonical_machine_addresses(staging))
    if not prod or not stage or prod.intersection(stage):
        reject("EQUIVALENT_STAGING_REQUIRED")


def memory_class_bytes(total_memory_bytes: object) -> int:
    if (not isinstance(total_memory_bytes, int) or isinstance(total_memory_bytes, bool)
            or total_memory_bytes < MIN_EQUIVALENT_MEMORY_BYTES):
        reject("EQUIVALENT_STAGING_REQUIRED")
    total_gib = (total_memory_bytes + GIB - 1) // GIB
    class_gib = 1 << (total_gib - 1).bit_length()
    return class_gib * GIB


def parse_meminfo_bytes(raw: bytes) -> tuple[int, int]:
    try:
        text = raw.decode("ascii", errors="strict")
    except (AttributeError, UnicodeError) as exc:
        raise AcceptanceError("EQUIVALENT_STAGING_REQUIRED") from exc
    fields: dict[str, int] = {}
    for line in text.splitlines():
        if not (line.startswith("MemTotal:") or line.startswith("MemAvailable:")):
            continue
        match = MEMINFO_LINE.fullmatch(line)
        if match is None or match.group(1) in fields:
            reject("EQUIVALENT_STAGING_REQUIRED")
        fields[match.group(1)] = int(match.group(2)) * 1024
    if set(fields) != {"MemTotal", "MemAvailable"}:
        reject("EQUIVALENT_STAGING_REQUIRED")
    total = fields["MemTotal"]
    available = fields["MemAvailable"]
    if total < MIN_EQUIVALENT_MEMORY_BYTES or available <= 0 or available > total:
        reject("EQUIVALENT_STAGING_REQUIRED")
    return total, available


def validate_fault_session_release(value: object) -> None:
    if (not _exact_object(value, FAULT_SESSION_RELEASE_FIELDS)
            or not isinstance(value["releaseManifestSha256"], str)
            or HEX.fullmatch(value["releaseManifestSha256"]) is None
            or not isinstance(value["releaseRevision"], str)
            or REVISION.fullmatch(value["releaseRevision"]) is None
            or not isinstance(value["sourceManifestSha256"], str)
            or HEX.fullmatch(value["sourceManifestSha256"]) is None
            or not isinstance(value["audioArtifactSha256"], str)
            or HEX.fullmatch(value["audioArtifactSha256"]) is None):
        reject("EQUIVALENT_STAGING_REQUIRED")


def validate_fault_session_geometry(value: object) -> None:
    expected_voices = ["bass", "pad", "lead", "pluck", "pad"]
    if (not _exact_object(value, FAULT_SESSION_GEOMETRY_FIELDS)
            or type(value["sampleRate"]) is not int
            or value["sampleRate"] != 44100
            or type(value["blockFrames"]) is not int
            or value["blockFrames"] != 4096
            or type(value["poolSize"]) is not int
            or value["poolSize"] != 5
            or value["rowVoices"] != expected_voices
            or any(not isinstance(item, str) for item in value["rowVoices"])):
        reject("EQUIVALENT_STAGING_REQUIRED")


def validate_fault_session_profile(value: object) -> None:
    if (not _exact_object(value, FAULT_SESSION_PROFILE_FIELDS)
            or type(value["clients"]) is not int
            or value["clients"] != 4
            or type(value["slowClient"]) is not int
            or value["slowClient"] != 4
            or type(value["durationMinutes"]) is not int
            or value["durationMinutes"] != 30
            or value["speciesEndpoint"] != "http://127.0.0.1:8081/v1"
            or value["speciesModel"] != "bird_agent"):
        reject("EQUIVALENT_STAGING_REQUIRED")


def validate_fault_session_binding(value: object) -> None:
    if (not _exact_object(value, FAULT_SESSION_BINDING_FIELDS)
            or not isinstance(value["runId"], str)
            or UUID_V4.fullmatch(value["runId"]) is None
            or not isinstance(value["challenge"], str)
            or HEX.fullmatch(value["challenge"]) is None
            or not isinstance(value["signerSpkiSha256"], str)
            or HEX.fullmatch(value["signerSpkiSha256"]) is None
            or not isinstance(value["faultSessionEvidenceSha256"], str)
            or HEX.fullmatch(value["faultSessionEvidenceSha256"]) is None):
        reject("EQUIVALENT_STAGING_REQUIRED")
    validate_fault_session_release(value["release"])
    validate_fault_session_geometry(value["geometry"])
    validate_fault_session_profile(value["profile"])


def phase5_fault_run_binding_projection(full_binding: object) -> dict:
    """Project a canonical owned v2 capture binding to the legacy 7 fields.

    This validates capture binding shape only.  Signature/nonce lifecycle and
    process-possession proof remain separate capture-proof responsibilities.
    """
    code = "PHASE5_CAPTURE_PROOF_RUN_BINDING_INVALID"
    try:
        binding_raw = canonical(full_binding)
        binding = strict_json_bytes(binding_raw, code)
        if (binding_raw != canonical(binding)
                or not _exact_object(
                    binding,
                    PHASE5_FAULT_RUN_BINDING_V2_FIELDS,
                )
                or not isinstance(binding["captureNonce"], str)
                or HEX.fullmatch(binding["captureNonce"]) is None
                or not isinstance(binding["rawManifestSha256"], str)
                or HEX.fullmatch(binding["rawManifestSha256"]) is None):
            reject(code)

        legacy_binding = {
            name: binding[name]
            for name in PHASE5_FAULT_RUN_BINDING_PROJECTION_FIELDS
        }
        validate_fault_session_binding(legacy_binding)
        projection = {
            "runId": binding["runId"],
            "challenge": binding["challenge"],
            "release": {
                name: binding["release"][name]
                for name in (
                    "releaseManifestSha256",
                    "releaseRevision",
                    "sourceManifestSha256",
                    "audioArtifactSha256",
                )
            },
            "geometry": {
                "sampleRate": binding["geometry"]["sampleRate"],
                "blockFrames": binding["geometry"]["blockFrames"],
                "poolSize": binding["geometry"]["poolSize"],
                "rowVoices": list(binding["geometry"]["rowVoices"]),
            },
            "profile": {
                name: binding["profile"][name]
                for name in (
                    "clients",
                    "slowClient",
                    "durationMinutes",
                    "speciesEndpoint",
                    "speciesModel",
                )
            },
            "signerSpkiSha256": binding["signerSpkiSha256"],
            "faultSessionEvidenceSha256":
                binding["faultSessionEvidenceSha256"],
        }
        return projection
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OverflowError, RecursionError,
            RuntimeError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _validate_phase5_capture_proof_boundary(
        session_raw: bytes,
        full_run_binding: object,
        trusted_signer_spki_der_base64: str,
        *,
        verifier_path: Path | None = None,
        verifier_runner=None,
        verifier_identity: object | None = None,
        node_executable: Path | None = None) -> dict:
    """Validate a v2 capture signature through an owned verifier snapshot.

    The external SPKI is a control-plane trust input.  This boundary proves
    signature and exact run binding only; nonce uniqueness, once-only finalize,
    and process possession are deliberately outside this function.
    """
    code = "PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED"
    result_fields = {
        "schemaVersion", "kind", "passed", "runId", "challenge",
        "release", "geometry", "profile", "signerSpkiSha256",
        "faultSessionEvidenceSha256", "captureNonce",
        "rawManifestSha256",
    }
    binding_result_fields = (
        "runId", "challenge", "release", "geometry", "profile",
        "signerSpkiSha256", "faultSessionEvidenceSha256",
        "captureNonce", "rawManifestSha256",
    )
    try:
        if (not isinstance(session_raw, bytes)
                or len(session_raw)
                   > MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES
                or not isinstance(trusted_signer_spki_der_base64, str)
                or trusted_signer_spki_der_base64 == ""):
            reject(code)
        session = strict_json_bytes(session_raw, code)
        if (type(session) is not dict
                or session_raw != phase5_canonical(session)):
            reject(code)

        binding_raw = phase5_canonical(full_run_binding)
        trusted_binding = strict_json_bytes(binding_raw, code)
        if (type(trusted_binding) is not dict
                or binding_raw != phase5_canonical(trusted_binding)):
            reject(code)
        fault_projection = phase5_fault_run_binding_projection(
            trusted_binding,
        )
        if (trusted_binding["faultSessionEvidenceSha256"]
                != hashlib.sha256(session_raw).hexdigest()):
            reject(code)

        envelope = phase5_canonical({
            "session": session,
            "runBinding": trusted_binding,
            "trustedSignerSpkiDerBase64":
                trusted_signer_spki_der_base64,
        }) + b"\n"
        if len(envelope) > MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES:
            reject(code)
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OverflowError, RecursionError,
            RuntimeError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc

    if verifier_runner is None:
        selected_verifier = phase5_capture_proof_verifier_path()
        if (verifier_path is not None
                and Path(verifier_path) != selected_verifier):
            reject(code)
        trusted_identity = (
            PHASE5_CAPTURE_VERIFIER_PINNED_SHA256
            if verifier_identity is _PHASE5_CAPTURE_OWNED_VERIFIER_IDENTITY
            else verifier_identity
        )
        runner = lambda path, body: _run_phase5_capture_proof_verifier(
            path,
            body,
            trusted_identity,
            node_executable,
        )
    else:
        selected_verifier = (
            verifier_path or phase5_capture_proof_verifier_path()
        )
        runner = verifier_runner

    try:
        result_raw = runner(selected_verifier, envelope)
        if (not isinstance(result_raw, bytes)
                or len(result_raw) > MAX_PHASE5_CAPTURE_PROOF_RESULT_BYTES
                or not result_raw.endswith(b"\n")
                or result_raw.endswith(b"\n\n")):
            reject(code)
        result = strict_json_bytes(result_raw[:-1], code)
        if (type(result) is not dict
                or result_raw != phase5_canonical(result) + b"\n"
                or not _exact_object(result, result_fields)
                or type(result["schemaVersion"]) is not int
                or result["schemaVersion"] != 1
                or result["kind"]
                   != "phase5-capture-proof-validation-result"
                or result["passed"] is not True
                or any(result[name] != trusted_binding[name]
                       for name in binding_result_fields)):
            reject(code)
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OSError, OverflowError,
            RecursionError, RuntimeError, subprocess.SubprocessError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc

    return {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-boundary-result",
        "captureValidation": result,
        "faultRunBindingProjection": fault_projection,
    }


def validate_phase5_capture_proof_boundary(
        session_raw: bytes,
        full_run_binding: object,
        trusted_signer_spki_der_base64: str) -> dict:
    """Validate capture proof with only the release-owned verifier closure."""
    return _validate_phase5_capture_proof_boundary(
        session_raw,
        full_run_binding,
        trusted_signer_spki_der_base64,
        verifier_identity=_PHASE5_CAPTURE_OWNED_VERIFIER_IDENTITY,
    )


def validate_phase5_capture_session_boundary(
        session_raw: bytes,
        trusted_signer_spki_der_base64: str) -> dict:
    """Derive and verify the complete v2 binding from one signed session."""
    code = "PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED"
    try:
        if (not isinstance(session_raw, bytes)
                or len(session_raw)
                   > MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES):
            reject(code)
        session = strict_json_bytes(session_raw, code)
        if (type(session) is not dict
                or session_raw != phase5_canonical(session)):
            reject(code)
        signer = session["signer"]
        capture_proof = session["captureProof"]
        full_run_binding = {
            "runId": session["runId"],
            "challenge": session["challenge"],
            "release": session["release"],
            "geometry": session["geometry"],
            "profile": session["profile"],
            "signerSpkiSha256": signer["publicKeySpkiSha256"],
            "faultSessionEvidenceSha256":
                hashlib.sha256(session_raw).hexdigest(),
            "captureNonce": capture_proof["captureNonce"],
            "rawManifestSha256":
                capture_proof["rawManifestSha256"],
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            RuntimeError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc
    return validate_phase5_capture_proof_boundary(
        session_raw,
        full_run_binding,
        trusted_signer_spki_der_base64,
    )


def validate_phase5_capture_channel_response_boundary(
        response_raw: bytes,
        expected_admission: object,
        expected_raw_manifest_sha256: str,
        expected_run_identity_raw: bytes) -> dict:
    """Verify a process-channel response after peer credentials were checked.

    ``expected_admission`` is controller-owned state recorded before the
    measurement.  PID/UID and socket ownership are transport responsibilities,
    intentionally not claims accepted from this response.
    """
    code = "PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED"
    admission_fields = {
        "schemaVersion", "kind", "runId", "challenge",
        "captureNonce", "signerSpkiSha256",
        "trustedSignerSpkiDerBase64",
    }
    response_fields = {
        "schemaVersion", "kind", "session", "runBinding",
        "captureValidation",
    }
    identity_fields = {
        "runId", "challenge", "release", "geometry", "profile",
    }
    binding_fields = (
        "runId", "challenge", "release", "geometry", "profile",
        "signerSpkiSha256", "faultSessionEvidenceSha256",
        "captureNonce", "rawManifestSha256",
    )
    try:
        if (type(response_raw) is not bytes
                or len(response_raw)
                   > MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES
                or not response_raw.endswith(b"\n")
                or response_raw.endswith(b"\n\n")
                or type(expected_raw_manifest_sha256) is not str
                or len(expected_raw_manifest_sha256) != 64
                or HEX.fullmatch(expected_raw_manifest_sha256) is None
                or type(expected_run_identity_raw) is not bytes
                or len(expected_run_identity_raw)
                   > MAX_PHASE5_CAPTURE_RUN_IDENTITY_BYTES):
            reject(code)
        expected_identity = strict_json_bytes(
            expected_run_identity_raw,
            code,
        )
        if (not _exact_object(expected_identity, identity_fields)
                or expected_run_identity_raw
                   != phase5_canonical(expected_identity)
                or type(expected_identity["runId"]) is not str
                or len(expected_identity["runId"]) != 36
                or UUID_V4.fullmatch(expected_identity["runId"]) is None
                or type(expected_identity["challenge"]) is not str
                or len(expected_identity["challenge"]) != 64
                or HEX.fullmatch(expected_identity["challenge"]) is None
                or type(expected_identity["release"]) is not dict
                or type(expected_identity["geometry"]) is not dict
                or type(expected_identity["profile"]) is not dict):
            reject(code)
        if (not _exact_object(expected_admission, admission_fields)
                or type(expected_admission["schemaVersion"]) is not int
                or expected_admission["schemaVersion"] != 1
                or expected_admission["kind"]
                   != "phase5-candidate-capture-admission"
                or type(expected_admission["runId"]) is not str
                or len(expected_admission["runId"]) != 36
                or UUID_V4.fullmatch(expected_admission["runId"]) is None
                or type(expected_admission["challenge"]) is not str
                or len(expected_admission["challenge"]) != 64
                or HEX.fullmatch(expected_admission["challenge"]) is None
                or type(expected_admission["captureNonce"]) is not str
                or len(expected_admission["captureNonce"]) != 64
                or HEX.fullmatch(
                    expected_admission["captureNonce"]
                ) is None
                or type(expected_admission["signerSpkiSha256"])
                   is not str
                or len(expected_admission["signerSpkiSha256"]) != 64
                or HEX.fullmatch(
                    expected_admission["signerSpkiSha256"]
                ) is None
                or type(expected_admission[
                    "trustedSignerSpkiDerBase64"
                ]) is not str
                or len(expected_admission[
                    "trustedSignerSpkiDerBase64"
                ]) != 60):
            reject(code)
        response = strict_json_bytes(response_raw[:-1], code)
        if (type(response) is not dict
                or response_raw != phase5_canonical(response) + b"\n"
                or not _exact_object(response, response_fields)
                or type(response["schemaVersion"]) is not int
                or response["schemaVersion"] != 1
                or response["kind"]
                   != "phase5-candidate-capture-finalize-response"):
            reject(code)

        admission_raw = phase5_canonical(expected_admission)
        admission = strict_json_bytes(admission_raw, code)
        if (type(admission) is not dict
                or admission_raw != phase5_canonical(admission)
                or not _exact_object(admission, admission_fields)
                or type(admission["schemaVersion"]) is not int
                or admission["schemaVersion"] != 1
                or admission["kind"]
                   != "phase5-candidate-capture-admission"
                or not isinstance(admission["runId"], str)
                or UUID_V4.fullmatch(admission["runId"]) is None
                or not isinstance(admission["challenge"], str)
                or HEX.fullmatch(admission["challenge"]) is None
                or not isinstance(admission["captureNonce"], str)
                or HEX.fullmatch(admission["captureNonce"]) is None
                or not isinstance(admission["signerSpkiSha256"], str)
                or HEX.fullmatch(admission["signerSpkiSha256"]) is None):
            reject(code)
        trusted_spki = decode_canonical_base64(
            admission["trustedSignerSpkiDerBase64"],
            code,
        )
        if (len(trusted_spki) != 44
                or not trusted_spki.startswith(ED25519_SPKI_PREFIX)
                or hashlib.sha256(trusted_spki).hexdigest()
                   != admission["signerSpkiSha256"]):
            reject(code)

        session_raw = phase5_canonical(response["session"])
    except AcceptanceError as exc:
        if str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    except (AttributeError, KeyError, OverflowError, RecursionError,
            RuntimeError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc

    verified = validate_phase5_capture_session_boundary(
        session_raw,
        admission["trustedSignerSpkiDerBase64"],
    )
    validation = verified["captureValidation"]
    full_binding = {
        name: validation[name]
        for name in binding_fields
    }
    try:
        response_binding_raw = phase5_canonical(
            response["runBinding"]
        )
        expected_binding_raw = phase5_canonical(full_binding)
        verified_identity_raw = phase5_canonical({
            name: validation[name]
            for name in identity_fields
        })
        response_validation_raw = phase5_canonical(
            response["captureValidation"]
        )
        expected_validation_raw = phase5_canonical(validation)
        if (response_binding_raw != expected_binding_raw
                or response_validation_raw != expected_validation_raw
                or verified_identity_raw != expected_run_identity_raw
                or validation["runId"] != admission["runId"]
                or validation["challenge"] != admission["challenge"]
                or validation["captureNonce"]
                   != admission["captureNonce"]
                or validation["signerSpkiSha256"]
                   != admission["signerSpkiSha256"]
                or validation["rawManifestSha256"]
                   != expected_raw_manifest_sha256):
            reject(code)
    except (KeyError, OverflowError, RecursionError, RuntimeError,
            TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc
    return verified


def fault_session_binding_from_bytes(raw: bytes) -> dict:
    code = "EQUIVALENT_STAGING_REQUIRED"
    value = strict_json_bytes(raw, code)
    try:
        if raw != canonical(value):
            reject(code)
    except (UnicodeError, ValueError, OverflowError, RecursionError) as exc:
        if isinstance(exc, AcceptanceError):
            raise
        raise AcceptanceError(code) from exc
    if (not _exact_object(value, FAULT_SESSION_TOP_FIELDS)
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or value["kind"] != "phase5-fault-session-attestation"
            or not isinstance(value["runId"], str)
            or UUID_V4.fullmatch(value["runId"]) is None
            or not isinstance(value["challenge"], str)
            or HEX.fullmatch(value["challenge"]) is None):
        reject(code)
    validate_fault_session_release(value["release"])
    validate_fault_session_geometry(value["geometry"])
    validate_fault_session_profile(value["profile"])
    signer = value["signer"]
    signer_fields = {
        "algorithm", "publicKeySpkiDerBase64", "publicKeySpkiSha256",
    }
    if (not _exact_object(signer, signer_fields)
            or signer["algorithm"] != "Ed25519"
            or not isinstance(signer["publicKeySpkiSha256"], str)
            or HEX.fullmatch(signer["publicKeySpkiSha256"]) is None):
        reject(code)
    spki = decode_canonical_base64(signer["publicKeySpkiDerBase64"], code)
    if (len(spki) != 44 or not spki.startswith(ED25519_SPKI_PREFIX)
            or hashlib.sha256(spki).hexdigest() != signer["publicKeySpkiSha256"]):
        reject(code)
    binding = {
        "runId": value["runId"],
        "challenge": value["challenge"],
        "release": value["release"],
        "geometry": value["geometry"],
        "profile": value["profile"],
        "signerSpkiSha256": signer["publicKeySpkiSha256"],
        "faultSessionEvidenceSha256": hashlib.sha256(raw).hexdigest(),
    }
    validate_fault_session_binding(binding)
    return binding


def validate_attestation(value: object) -> None:
    if (not isinstance(value, dict)
            or type(value.get("schemaVersion")) is not int
            or value["schemaVersion"] != 2):
        reject("EQUIVALENT_STAGING_REQUIRED")
    role = value.get("attestationRole")
    binding = value.get("runBinding")
    if role not in ATTESTATION_ROLES:
        reject("EQUIVALENT_STAGING_REQUIRED")
    if role == "production-baseline":
        if binding is not None:
            reject("EQUIVALENT_STAGING_REQUIRED")
    else:
        validate_fault_session_binding(binding)
    machine_id = value.get("machineIdSha256")
    host_key = value.get("sshHostKeySha256")
    if not isinstance(machine_id, str) or HEX.fullmatch(machine_id) is None:
        reject("EQUIVALENT_STAGING_REQUIRED")
    if not isinstance(host_key, str) or SSH_FINGERPRINT.fullmatch(host_key) is None:
        reject("EQUIVALENT_STAGING_REQUIRED")
    addresses = canonical_machine_addresses(value.get("canonicalInterfaceAddresses"))
    if not addresses or value.get("canonicalInterfaceAddresses") != addresses:
        reject("EQUIVALENT_STAGING_REQUIRED")
    gpus = value.get("gpuUuids")
    if (not isinstance(gpus, list) or not gpus or gpus != sorted(set(gpus))
            or any(not isinstance(item, str) or not item.startswith("GPU-") for item in gpus)):
        reject("EQUIVALENT_STAGING_REQUIRED")
    raw = value.get("rawEvidence")
    environment = value.get("environmentEvidence")
    if (not isinstance(raw, dict) or set(raw) != {"machineId", "sshHostKey", "interfaces", "gpus"}
            or any(not isinstance(item, str) or HEX.fullmatch(item) is None
                   for item in raw.values())):
        reject("EQUIVALENT_STAGING_REQUIRED")
    required_environment = {"cudaDriver", "torch", "availableMemory",
                            "architecture", "vllmNormalProfile", "vllmBurstProfile"}
    if (not isinstance(environment, dict) or set(environment) != required_environment
            or any(not isinstance(item, str) or HEX.fullmatch(item) is None
                   for item in environment.values())):
        reject("EQUIVALENT_STAGING_REQUIRED")
    allowed = {"schemaVersion", "attestationRole", "runBinding",
               "hostname", "machineIdSha256", "sshHostKeySha256",
               "canonicalInterfaceAddresses", "gpuUuids", "platform", "rawEvidence",
               "environmentEvidence"}
    if set(value) - allowed:
        reject("EQUIVALENT_STAGING_REQUIRED")
    platform_value = value.get("platform")
    platform_keys = {"architecture", "gpuModel", "driverVersion", "torchVersion", "cudaVersion",
                     "cudaAvailable", "availableMemoryBytes", "totalMemoryBytes",
                     "memoryClassBytes"}
    if (not isinstance(platform_value, dict) or set(platform_value) != platform_keys
            or platform_value.get("architecture") != "aarch64"
            or not all(isinstance(platform_value.get(name), str) and platform_value[name]
                       for name in ("gpuModel", "driverVersion", "torchVersion", "cudaVersion"))
            or platform_value.get("cudaAvailable") is not True
            or not isinstance(platform_value.get("availableMemoryBytes"), int)
            or isinstance(platform_value.get("availableMemoryBytes"), bool)
            or platform_value["availableMemoryBytes"] <= 0
            or not isinstance(platform_value.get("totalMemoryBytes"), int)
            or isinstance(platform_value.get("totalMemoryBytes"), bool)
            or platform_value["totalMemoryBytes"] < MIN_EQUIVALENT_MEMORY_BYTES
            or platform_value["availableMemoryBytes"] > platform_value["totalMemoryBytes"]
            or platform_value.get("memoryClassBytes")
            != memory_class_bytes(platform_value["totalMemoryBytes"])):
        reject("EQUIVALENT_STAGING_REQUIRED")
    validate_declared_schema(value, "machine-attestation.schema.json", "EQUIVALENT_STAGING_REQUIRED")


def validate_attestation_evidence(path: Path, value: dict) -> None:
    code = "EQUIVALENT_STAGING_REQUIRED"
    validate_attestation(value)
    evidence_dir = path.with_suffix(".evidence")
    raw_attestation = read_regular_file_no_follow(path, code)
    on_disk_attestation = strict_json_bytes(raw_attestation, code)
    try:
        if (raw_attestation != canonical(on_disk_attestation)
                or on_disk_attestation != value):
            reject(code)
    except (UnicodeError, ValueError, OverflowError, RecursionError) as exc:
        if isinstance(exc, AcceptanceError):
            raise
        raise AcceptanceError(code) from exc
    fields = {
        ("rawEvidence", "machineId"): "machine-id",
        ("rawEvidence", "sshHostKey"): "ssh-host-ed25519.pub",
        ("rawEvidence", "interfaces"): "interfaces.json",
        ("rawEvidence", "gpus"): "gpus.txt",
        ("environmentEvidence", "cudaDriver"): "cuda-driver.txt",
        ("environmentEvidence", "torch"): "torch.json",
        ("environmentEvidence", "availableMemory"): "available-memory.txt",
        ("environmentEvidence", "architecture"): "architecture.txt",
        ("environmentEvidence", "vllmNormalProfile"): "vllm-normal-profile.json",
        ("environmentEvidence", "vllmBurstProfile"): "vllm-burst-profile.json",
    }
    expected_files = set(MACHINE_EVIDENCE_FILES)
    if value["attestationRole"] == "staging-phase5":
        expected_files.add(FAULT_SESSION_EVIDENCE_FILE)
    evidence_paths = _exact_regular_file_inventory(evidence_dir, expected_files, code)
    blobs = {
        name: read_regular_file_no_follow(evidence_paths[name], code)
        for name in expected_files
    }
    for (section, field), name in fields.items():
        if hashlib.sha256(blobs[name]).hexdigest() != value[section][field]:
            reject(code)
    try:
        raw_interfaces = strict_json_bytes(blobs["interfaces.json"], code)
        claimed = [item["local"] for interface in raw_interfaces
                   for item in interface.get("addr_info", []) if "local" in item]
        raw_gpus = sorted(set(line.strip() for line in
                              blobs["gpus.txt"].decode().splitlines() if line.strip()))
    except (AcceptanceError, UnicodeError, TypeError, KeyError) as exc:
        if isinstance(exc, AcceptanceError):
            raise
        raise AcceptanceError(code) from exc
    if canonical_machine_addresses(claimed) != value["canonicalInterfaceAddresses"]:
        reject(code)
    if raw_gpus != value["gpuUuids"]:
        reject(code)
    try:
        public_key = blobs["ssh-host-ed25519.pub"].strip().split()
        key_blob = base64.b64decode(public_key[1], validate=True)
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(key_blob).digest()).decode().rstrip("=")
    except (IndexError, ValueError) as exc:
        raise AcceptanceError(code) from exc
    if value["machineIdSha256"] != value["rawEvidence"]["machineId"]:
        reject(code)
    if public_key[0] != b"ssh-ed25519" or fingerprint != value["sshHostKeySha256"]:
        reject(code)
    try:
        driver, gpu_model, _memory = [item.strip() for item in
                                      blobs["cuda-driver.txt"].decode().splitlines()[0].split(",", 2)]
        torch_value = strict_json_bytes(blobs["torch.json"], code)
        total_bytes, available_bytes = parse_meminfo_bytes(blobs["available-memory.txt"])
        architecture = blobs["architecture.txt"].decode().strip().lower()
    except (UnicodeError, ValueError, IndexError, StopIteration,
            AcceptanceError) as exc:
        if isinstance(exc, AcceptanceError):
            raise
        raise AcceptanceError(code) from exc
    platform_value = value["platform"]
    if (driver != platform_value["driverVersion"] or gpu_model != platform_value["gpuModel"]
            or torch_value.get("version") != platform_value["torchVersion"]
            or torch_value.get("cuda") != platform_value["cudaVersion"]
            or torch_value.get("available") is not True
            or available_bytes != platform_value["availableMemoryBytes"]
            or total_bytes != platform_value["totalMemoryBytes"]
            or memory_class_bytes(total_bytes) != platform_value["memoryClassBytes"]
            or ("aarch64" if architecture == "arm64" else architecture)
               != platform_value["architecture"]):
        reject(code)
    for name in ("vllm-normal-profile.json", "vllm-burst-profile.json"):
        samples = load_raw_json_bytes(blobs[name], code)
        if not isinstance(samples, list) or not samples:
            reject(code)
        for sample in samples:
            if (not isinstance(sample, dict) or set(sample) != {"atMs", "ok", "latencyMs"}
                    or not isinstance(sample["ok"], bool)):
                reject(code)
            _number(sample["atMs"], code)
            _number(sample["latencyMs"], code)
    if value["attestationRole"] == "staging-phase5":
        raw_fault_session = blobs[FAULT_SESSION_EVIDENCE_FILE]
        recomputed_binding = fault_session_binding_from_bytes(raw_fault_session)
        if recomputed_binding != value["runBinding"]:
            reject(code)
    _exact_regular_file_inventory(evidence_dir, expected_files, code)


def validate_machine_separation(production: object, staging: object) -> None:
    validate_attestation(production)
    validate_attestation(staging)
    if (production["machineIdSha256"] == staging["machineIdSha256"]
            or production["sshHostKeySha256"] == staging["sshHostKeySha256"]
            or set(production["gpuUuids"]).intersection(staging["gpuUuids"])):
        reject("EQUIVALENT_STAGING_REQUIRED")
    assert_machine_address_sets_are_distinct(production["canonicalInterfaceAddresses"],
                                             staging["canonicalInterfaceAddresses"])


def validate_machine_equivalence(production: object, staging: object) -> None:
    validate_machine_separation(production, staging)
    if (production["attestationRole"] != "production-baseline"
            or staging["attestationRole"] != "staging-phase5"):
        reject("EQUIVALENT_STAGING_REQUIRED")
    required_equal = ("architecture", "gpuModel", "driverVersion", "cudaVersion",
                      "memoryClassBytes")
    if any(production["platform"][name] != staging["platform"][name]
           for name in required_equal):
        reject("EQUIVALENT_STAGING_REQUIRED")


def _number(value: object, code: str) -> float:
    if not finite_json_number(value):
        reject(code)
    try:
        return float(value)
    except (OverflowError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def nearest_rank(values: object, fraction: float, code: str) -> int | float:
    if (not isinstance(values, list) or not values
            or any(not finite_json_number(item) or item < 0 for item in values)):
        reject(code)
    try:
        ordered = sorted(values)
    except (OverflowError, ValueError) as exc:
        raise AcceptanceError(code) from exc
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def timed_values(samples: object, value_key: str, duration_ms: float, cadence_ms: float,
                 coverage: float, code: str) -> list[float]:
    minimum = math.floor(duration_ms / cadence_ms * coverage)
    if not isinstance(samples, list) or len(samples) < minimum:
        reject(code)
    times: list[float] = []; values: list[float] = []
    for sample in samples:
        if not isinstance(sample, dict) or set(sample) != {"atMs", value_key}:
            reject(code)
        times.append(_number(sample["atMs"], code)); values.append(_number(sample[value_key], code))
    if (any(at_ms < 0 or at_ms > duration_ms for at_ms in times)
            or any(right <= left for left, right in zip(times, times[1:]))
            or times[0] > cadence_ms * 2
            or times[-1] < duration_ms - cadence_ms * 3
            or any(right - left > cadence_ms * 4 for left, right in zip(times, times[1:]))):
        reject(code)
    return values


def load_raw_json(path: Path, code: str) -> object:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise AcceptanceError(code) from exc
    return load_raw_json_bytes(raw, code)


def load_raw_json_bytes(raw: bytes, code: str) -> object:
    value = strict_json_bytes(raw, code)
    try:
        canonical_value = canonical(value)
    except (UnicodeError, ValueError, OverflowError, RecursionError) as exc:
        raise AcceptanceError(code) from exc
    if raw != canonical_value:
        reject(code)
    return value


def _exact_object(value: object, fields: set[str]) -> bool:
    return type(value) is dict and set(value) == fields


def validate_lease_evidence(lease: object) -> dict:
    sequential_code = "SEQUENTIAL_LEASE_EVIDENCE_REQUIRED"
    audible_code = "AUDIBLE_SPECIES_EVIDENCE_REQUIRED"
    if (not _exact_object(lease, {
            "schemaVersion", "kind", "sequence", "surfaceLeases",
            "audibleSpecies", "surfaceTransports"})
            or not js_safe_integer(lease["schemaVersion"], minimum=1)
            or lease["schemaVersion"] != 1
            or lease["kind"] != "production-fixed-entry-chromium-lease-evidence"
            or lease["sequence"] != list(LEASE_SURFACES)):
        reject(sequential_code)

    surfaces = lease["surfaceLeases"]
    if not _exact_object(surfaces, set(LEASE_SURFACES)):
        reject(sequential_code)
    for surface in ("demo", "tracks"):
        value = surfaces[surface]
        if (not _exact_object(value, {"takeAccepted", "releaseAccepted"})
                or value["takeAccepted"] is not True
                or value["releaseAccepted"] is not True):
            reject(sequential_code)
    new_ui = surfaces["new-ui"]
    if (not _exact_object(new_ui, {
            "takeAccepted", "releaseAccepted", "commandSeq", "releaseCommandSeq",
            "publicOwnerAfterRelease", "controlReleaseCommandId"})
            or new_ui["takeAccepted"] is not True
            or new_ui["releaseAccepted"] is not True
            or not js_safe_integer(new_ui["commandSeq"], minimum=1)
            or not js_safe_integer(new_ui["releaseCommandSeq"], minimum=1)
            or new_ui["releaseCommandSeq"] <= new_ui["commandSeq"]
            or new_ui["publicOwnerAfterRelease"] != "AGENT"
            or not isinstance(new_ui["controlReleaseCommandId"], str)
            or UUID_V4.fullmatch(new_ui["controlReleaseCommandId"]) is None):
        reject(sequential_code)

    audible = lease["audibleSpecies"]
    if not _exact_object(audible, set(LEASE_SPECIES)):
        reject(audible_code)
    command_order = []
    probe_fields = {
        "commandAccepted", "releaseAccepted", "commandSeq", "releaseCommandSeq",
        "peakAbs", "pcmBlocks",
    }
    for species in LEASE_SPECIES:
        probe = audible[species]
        if (not _exact_object(probe, probe_fields)
                or probe["commandAccepted"] is not True
                or probe["releaseAccepted"] is not True
                or not js_safe_integer(probe["commandSeq"], minimum=1)
                or not js_safe_integer(probe["releaseCommandSeq"], minimum=1)
                or probe["releaseCommandSeq"] <= probe["commandSeq"]
                or not finite_json_number(probe["peakAbs"])
                or probe["peakAbs"] <= 1e-7
                or not js_safe_integer(probe["pcmBlocks"], minimum=1)):
            reject(audible_code)
        command_order.extend((probe["commandSeq"], probe["releaseCommandSeq"]))
    command_order.extend((new_ui["commandSeq"], new_ui["releaseCommandSeq"]))
    if any(left >= right for left, right in zip(command_order, command_order[1:])):
        reject(sequential_code)

    transports = lease["surfaceTransports"]
    if not _exact_object(transports, set(LEASE_SURFACES)):
        reject(sequential_code)
    http_fields = {
        "entryPath", "entrySeen", "requestCount", "getOnly", "status200Only",
        "candidateOriginOnly", "allowedPathOnly", "directOnly", "failureFree",
    }
    socket_fields = {"path", "lifecycle", "framesSent", "framesReceived"}
    true_http_fields = {
        "entrySeen", "getOnly", "status200Only", "candidateOriginOnly",
        "allowedPathOnly", "directOnly", "failureFree",
    }
    for surface in LEASE_SURFACES:
        transport = transports[surface]
        if not _exact_object(transport, {"http", "webSockets"}):
            reject(sequential_code)
        http = transport["http"]
        if (not _exact_object(http, http_fields)
                or http["entryPath"] != LEASE_ENTRY_PATHS[surface]
                or any(http[field] is not True for field in true_http_fields)
                or not js_safe_integer(http["requestCount"], minimum=1)
                or http["requestCount"] > LEASE_HTTP_LIMITS[surface]):
            reject(sequential_code)
        sockets = transport["webSockets"]
        if not isinstance(sockets, list):
            reject(sequential_code)
        sort_keys = []
        for record in sockets:
            if (not _exact_object(record, socket_fields)
                    or not isinstance(record["path"], str)
                    or record["lifecycle"] != ["open", "close"]
                    or not js_safe_integer(record["framesSent"], minimum=0)
                    or not js_safe_integer(record["framesReceived"], minimum=1)):
                reject(sequential_code)
            sort_keys.append((
                record["path"],
                record["framesSent"],
                record["framesReceived"],
            ))
        if (sort_keys != sorted(sort_keys)
                or [record["path"] for record in sockets]
                != LEASE_SOCKET_PATHS[surface]):
            reject(sequential_code)
    return lease


def validate_chromium_evidence(path: Path, expected_identity: dict) -> tuple[dict, bytes]:
    code = "PHASE5_PRODUCTION_E2E_REQUIRED"
    try:
        value = strict_json_bytes(path.read_bytes(), code)
        config = value["config"]; metadata = config["metadata"]; projects = config["projects"]
        suites = value["suites"]; stats = value["stats"]
        spec = next(item for item in suites if item.get("file") == "phase5-local.spec.js")
        spec_item = spec["specs"][0]; test = spec_item["tests"][0]; result = test["results"][0]
        attachments = result["attachments"]
        attachment = next(item for item in attachments
                          if item.get("name") == "phase5-runtime-identity"
                          and item.get("contentType") == "application/json")
        ready_raw = decode_canonical_base64(attachment["body"], code)
        ready = strict_json_bytes(ready_raw, code)
        lease_attachment = next(item for item in attachments
                                if item.get("name") == "phase5-lease-evidence"
                                and item.get("contentType") == "application/json")
        lease_raw = decode_canonical_base64(lease_attachment["body"], code)
        lease = validate_lease_evidence(strict_json_bytes(lease_raw, code))
    except (AcceptanceError, AttributeError, OSError, UnicodeError, json.JSONDecodeError,
            KeyError, IndexError, StopIteration, TypeError, ValueError, OverflowError) as exc:
        if isinstance(exc, AcceptanceError) and str(exc) == code:
            raise
        raise AcceptanceError(code) from exc
    ready_value = ready.get("value", {}) if isinstance(ready, dict) else {}
    ready_identity = (ready_value.get("workerIdentity", {})
                      if isinstance(ready_value, dict) else {})
    try:
        invalid_report = (
            Path(config.get("configFile", "")).name
            != "playwright.phase5-acceptance.config.js"
            or metadata.get("phase5Mode") is not True
            or metadata.get("phase5Acceptance") is not True
            or metadata.get("surfaceProfile") != "production-fixed-entry"
            or len(projects) != 1 or projects[0].get("name") != "chromium"
            or len(spec["specs"]) != 1 or spec_item.get("ok") is not True
            or test.get("projectName") != "chromium" or test.get("status") != "expected"
            or len(test["results"]) != 1 or result.get("status") != "passed"
            or len(attachments) != 2
            or not isinstance(ready, dict) or set(ready) != {"status", "value"}
            or not isinstance(ready_value, dict)
            or set(ready_value) != {"audioOwner", "phaseGate", "runtimeOwner",
                                    "workerIdentity", "workerReady"}
            or not isinstance(ready_identity, dict)
            or set(ready_identity) != {"expected", "reported"}
            or ready.get("status") != 200
            or ready_value.get("workerReady") is not True
            or ready_value.get("runtimeOwner") != "server"
            or ready_value.get("audioOwner") != "world"
            or ready_value.get("phaseGate") not in {"phase5-local", "phase5-production"}
            or ready_identity.get("expected") != expected_identity
            or ready_identity.get("reported") != expected_identity
            or stats.get("expected") != 1 or stats.get("unexpected") != 0
            or stats.get("skipped") != 0 or stats.get("flaky") != 0
        )
    except (AttributeError, OSError, TypeError, ValueError, OverflowError) as exc:
        raise AcceptanceError(code) from exc
    if invalid_report:
        reject(code)
    return lease, lease_raw


def validate_acceptance(value: object, release_manifest: object) -> None:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("status") != "accepted":
        reject("ACCEPTANCE_INVALID")
    expected_top = {"schemaVersion", "status", "environment", "release", "geometry",
                    "durationMinutes", "clients", "slowClients", "stability", "latency",
                    "speciesLoad", "audibleSpecies", "leaseExercise", "evidence",
                    "operatorListening"}
    if set(value) != expected_top:
        reject("ACCEPTANCE_INVALID")
    environment = value.get("environment")
    if (not isinstance(environment, dict)
            or set(environment) != {"kind", "surfaceProfile"}
            or environment.get("kind") != "isolated-equivalent-spark"
            or environment.get("surfaceProfile") != "production-fixed-entry"):
        reject("EQUIVALENT_STAGING_REQUIRED")
    if _number(value.get("durationMinutes"), "SOAK_DURATION_TOO_SHORT") < 30:
        reject("SOAK_DURATION_TOO_SHORT")
    if value.get("clients") != 4 or value.get("slowClients") != 1:
        reject("CLIENT_LOAD_INVALID")
    stability = value.get("stability")
    zero_fields = ("hotClientAbnormalCloses", "hotClientReconnectStorms", "hotClientUnderruns",
                   "pcmCorruptions", "cursorDiscontinuitiesUnexpected")
    if (not isinstance(stability, dict) or set(stability) != set(zero_fields)
            or any(stability.get(name) != 0 for name in zero_fields)):
        reject("SHARED_LOAD_STABILITY_FAILED")
    latency = value.get("latency")
    limits = {"runtimeReadyP95Ms": 1000, "uiStateLagP95Ms": 150,
              "renderP95BlockFraction": .70, "renderP99BlockFraction": .90}
    if (not isinstance(latency, dict) or set(latency) != set(limits)
            or any(_number(latency.get(name), "LATENCY_EVIDENCE_INVALID") > limit
                   for name, limit in limits.items())):
        reject("LATENCY_THRESHOLD_EXCEEDED")
    species = value.get("speciesLoad")
    species_keys = {"endpoint", "model", "normalRequests", "burstRequests", "errors",
                    "normalLatencySamplesSha256", "burstLatencySamplesSha256"}
    if (not isinstance(species, dict) or set(species) != species_keys
            or species.get("endpoint") != "http://127.0.0.1:8081/v1"
            or species.get("model") != "bird_agent"
            or not isinstance(species.get("normalRequests"), int) or species["normalRequests"] <= 0
            or not isinstance(species.get("burstRequests"), int) or species["burstRequests"] <= 0
            or species.get("errors") != 0
            or any(HEX.fullmatch(species.get(name, "")) is None for name in
                   ("normalLatencySamplesSha256", "burstLatencySamplesSha256"))):
        reject("SPECIES_LOAD_EVIDENCE_REQUIRED")
    probes = value.get("audibleSpecies")
    if not isinstance(probes, dict) or set(probes) != {"bass", "pad", "lead", "pluck"} or any(probes.get(name) is not True for name in
                                           ("bass", "pad", "lead", "pluck")):
        reject("AUDIBLE_SPECIES_EVIDENCE_REQUIRED")
    if value.get("leaseExercise") != ["demo", "tracks", "new-ui"]:
        reject("SEQUENTIAL_LEASE_EVIDENCE_REQUIRED")
    if not isinstance(release_manifest, dict):
        reject("RELEASE_TUPLE_MISMATCH")
    identity = release_manifest.get("workerIdentity", {})
    release = value.get("release")
    if (not isinstance(release, dict) or set(release) != {"releaseManifestSha256", "releaseRevision",
            "sourceManifestSha256", "audioArtifactSha256"}
            or REVISION.fullmatch(release.get("releaseRevision", "")) is None
            or release.get("releaseRevision") != identity.get("releaseRevision")
            or release.get("sourceManifestSha256") != identity.get("sourceManifestSha256")
            or release.get("audioArtifactSha256") != identity.get("audioArtifactSha256")):
        reject("RELEASE_TUPLE_MISMATCH")
    geometry = value.get("geometry")
    if geometry != release_manifest.get("geometry"):
        reject("AUDIO_GEOMETRY_MISMATCH")
    evidence = value.get("evidence")
    evidence_names = ("productionGraphSha256", "phase5E2eSha256",
                      "rawRuntimeReadySamplesSha256", "rawUiStateLagSamplesSha256",
                      "rawRenderSamplesSha256", "soakRunSha256", "productionMachineAttestationSha256",
                      "stagingMachineAttestationSha256", "leaseEvidenceSha256",
                      "listeningChecklistSha256")
    if not isinstance(evidence, dict) or set(evidence) != set(evidence_names) or any(HEX.fullmatch(evidence.get(name, "")) is None
                                             for name in evidence_names):
        reject("RAW_PERCENTILE_EVIDENCE_REQUIRED")
    if evidence["productionGraphSha256"] != release_manifest.get("productionGraphSha256"):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    listening = value.get("operatorListening")
    if (not isinstance(listening, dict) or set(listening) != {"completed", "noClicks", "noStalls",
            "allSpeciesAudible", "operator"} or not isinstance(listening.get("operator"), str)
            or not listening["operator"].strip()
            or any(listening.get(name) is not True for name in
                   ("completed", "noClicks", "noStalls", "allSpeciesAudible"))):
        reject("LISTENING_CHECKLIST_REQUIRED")
    validate_declared_schema(value, "acceptance.schema.json", "ACCEPTANCE_INVALID")


def validate_evidence_files(acceptance_path: Path, value: dict, production_path: Path,
                            staging_path: Path, release: dict) -> tuple[dict, dict]:
    root = acceptance_path.parent
    raw_root = root / "acceptance-evidence"
    expected = {
        "productionGraphSha256": root / "production-graph.json",
        "phase5E2eSha256": raw_root / "phase5-e2e.json",
        "rawRuntimeReadySamplesSha256": raw_root / "runtime-ready-samples.json",
        "rawUiStateLagSamplesSha256": raw_root / "ui-state-lag-samples.json",
        "rawRenderSamplesSha256": raw_root / "render-samples.json",
        "soakRunSha256": raw_root / "soak-run.json",
        "leaseEvidenceSha256": raw_root / "lease-evidence.json",
        "listeningChecklistSha256": root / "listening-checklist.json",
    }
    for field, path in expected.items():
        if sha256(path) != value["evidence"][field]:
            reject("RAW_PERCENTILE_EVIDENCE_REQUIRED")
    chromium_lease, chromium_lease_raw = validate_chromium_evidence(
        raw_root / "phase5-e2e.json", release["workerIdentity"])
    try:
        lease_raw = (raw_root / "lease-evidence.json").read_bytes()
        checklist = json.loads((root / "listening-checklist.json").read_bytes())
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AcceptanceError("RAW_PERCENTILE_EVIDENCE_REQUIRED") from exc
    lease = validate_lease_evidence(
        strict_json_bytes(lease_raw, "SEQUENTIAL_LEASE_EVIDENCE_REQUIRED"))
    if lease_raw != chromium_lease_raw or lease != chromium_lease:
        reject("SEQUENTIAL_LEASE_EVIDENCE_REQUIRED")
    if checklist != value["operatorListening"]:
        reject("LISTENING_CHECKLIST_REQUIRED")
    species_files = {"normalLatencySamplesSha256": raw_root / "species-normal-samples.json",
                     "burstLatencySamplesSha256": raw_root / "species-burst-samples.json"}
    for field, path in species_files.items():
        if sha256(path) != value["speciesLoad"][field]:
            reject("SPECIES_LOAD_EVIDENCE_REQUIRED")
    runtime_samples = load_raw_json(raw_root / "runtime-ready-samples.json",
                                    "RAW_PERCENTILE_EVIDENCE_REQUIRED")
    ui_samples = load_raw_json(raw_root / "ui-state-lag-samples.json",
                               "RAW_PERCENTILE_EVIDENCE_REQUIRED")
    render_samples = load_raw_json(raw_root / "render-samples.json",
                                   "RAW_PERCENTILE_EVIDENCE_REQUIRED")
    run = load_raw_json(raw_root / "soak-run.json", "RAW_PERCENTILE_EVIDENCE_REQUIRED")
    if not isinstance(runtime_samples, list) or len(runtime_samples) != 4:
        reject("RAW_PERCENTILE_EVIDENCE_REQUIRED")
    if not isinstance(render_samples, dict) or set(render_samples) != {
            "p95BlockFractions", "p99BlockFractions"}:
        reject("RAW_PERCENTILE_EVIDENCE_REQUIRED")
    duration_ms = _number(value["durationMinutes"], "SOAK_DURATION_TOO_SHORT") * 60_000
    ui_values = timed_values(ui_samples, "latencyMs", duration_ms, 2000, .95,
                             "RAW_PERCENTILE_EVIDENCE_REQUIRED")
    render_p95_values = timed_values(render_samples["p95BlockFractions"], "value",
                                     duration_ms, 250, .90,
                                     "RAW_PERCENTILE_EVIDENCE_REQUIRED")
    render_p99_values = timed_values(render_samples["p99BlockFractions"], "value",
                                     duration_ms, 250, .90,
                                     "RAW_PERCENTILE_EVIDENCE_REQUIRED")
    recomputed = {
        "runtimeReadyP95Ms": nearest_rank(runtime_samples, .95, "RAW_PERCENTILE_EVIDENCE_REQUIRED"),
        "uiStateLagP95Ms": nearest_rank(ui_values, .95, "RAW_PERCENTILE_EVIDENCE_REQUIRED"),
        "renderP95BlockFraction": nearest_rank(render_p95_values, .95,
                                                "RAW_PERCENTILE_EVIDENCE_REQUIRED"),
        "renderP99BlockFraction": nearest_rank(render_p99_values, .99,
                                                "RAW_PERCENTILE_EVIDENCE_REQUIRED"),
    }
    if value["latency"] != recomputed:
        reject("RAW_PERCENTILE_EVIDENCE_REQUIRED")
    run_keys = {"startedAtUnixMs", "endedAtUnixMs", "measuredDurationMs", "pcmBlocks",
                "hotClientMaxPcmGapMs", "hotClientFinalPcmAgeMs", "stability"}
    if (not isinstance(run, dict) or set(run) != run_keys
            or _number(run.get("measuredDurationMs"), "SOAK_DURATION_TOO_SHORT") < 30 * 60_000
            or _number(run.get("endedAtUnixMs"), "SOAK_DURATION_TOO_SHORT")
               - _number(run.get("startedAtUnixMs"), "SOAK_DURATION_TOO_SHORT") < 30 * 60_000
            or abs(run["measuredDurationMs"] - value["durationMinutes"] * 60_000) > 1
            or run.get("stability") != value["stability"]
            or not isinstance(run.get("pcmBlocks"), list) or len(run["pcmBlocks"]) != 4
            or any(not isinstance(item, int) or item < 1 for item in run["pcmBlocks"])
            or _number(run.get("hotClientMaxPcmGapMs"), "PCM_CONTINUITY_FAILED") > 1000
            or not isinstance(run.get("hotClientFinalPcmAgeMs"), list)
            or len(run["hotClientFinalPcmAgeMs"]) != 3
            or any(_number(item, "PCM_CONTINUITY_FAILED") > 1000
                   for item in run["hotClientFinalPcmAgeMs"])):
        reject("RAW_PERCENTILE_EVIDENCE_REQUIRED")
    total_errors = 0
    for mode, path in (("normal", species_files["normalLatencySamplesSha256"]),
                       ("burst", species_files["burstLatencySamplesSha256"])):
        samples = load_raw_json(path, "SPECIES_LOAD_EVIDENCE_REQUIRED")
        if not isinstance(samples, list) or not samples:
            reject("SPECIES_LOAD_EVIDENCE_REQUIRED")
        for sample in samples:
            if (not isinstance(sample, dict) or set(sample) != {"atMs", "ok", "latencyMs"}
                    or not isinstance(sample["ok"], bool)):
                reject("SPECIES_LOAD_EVIDENCE_REQUIRED")
            _number(sample["atMs"], "SPECIES_LOAD_EVIDENCE_REQUIRED")
            _number(sample["latencyMs"], "SPECIES_LOAD_EVIDENCE_REQUIRED")
        cadence = 2000 if mode == "normal" else 2500
        sample_times = [
            _number(item["atMs"], "SPECIES_LOAD_EVIDENCE_REQUIRED")
            for item in samples
        ]
        if (len(samples) < math.floor(duration_ms / cadence * .95)
                or sample_times != sorted(sample_times)
                or sample_times[0] > cadence * 2
                or sample_times[-1] < duration_ms - cadence * 5
                or any(right - left > cadence * 5
                       for left, right in zip(sample_times, sample_times[1:]))):
            reject("SPECIES_LOAD_EVIDENCE_REQUIRED")
        if value["speciesLoad"][f"{mode}Requests"] != len(samples):
            reject("SPECIES_LOAD_EVIDENCE_REQUIRED")
        total_errors += sum(item["ok"] is False for item in samples)
    if total_errors != value["speciesLoad"]["errors"]:
        reject("SPECIES_LOAD_EVIDENCE_REQUIRED")
    if sha256(production_path) != value["evidence"]["productionMachineAttestationSha256"]:
        reject("EQUIVALENT_STAGING_REQUIRED")
    if sha256(staging_path) != value["evidence"]["stagingMachineAttestationSha256"]:
        reject("EQUIVALENT_STAGING_REQUIRED")
    return (load_canonical_json(production_path, "EQUIVALENT_STAGING_REQUIRED"),
            load_canonical_json(staging_path, "EQUIVALENT_STAGING_REQUIRED"))


def validate_production_graph(release_path: Path, expected_sha: str) -> None:
    root = release_path.parent
    graph_path = root / "production-graph.json"
    if sha256(graph_path) != expected_sha:
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    release = load_canonical_json(release_path, "PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    if release.get("productionGraphSha256") != expected_sha:
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    graph = load_canonical_json(graph_path, "PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    source_path = root / "source-manifest.json"
    source = load_canonical_json(source_path, "PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    worker_identity = release.get("workerIdentity")
    if (not isinstance(worker_identity, dict)
            or worker_identity.get("sourceManifestSha256") != sha256(source_path)):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    files = graph.get("files"); hashes = graph.get("fileSha256")
    routes = graph.get("staticRoutes")
    entries = source.get("entries")
    if (set(graph) != {"files", "edges", "fileSha256", "staticRoutes", "sha256"}
            or not isinstance(files, list) or not files
            or any(not canonical_repo_path(name) for name in files)
            or files != sorted(set(files))
            or not isinstance(hashes, dict)
            or any(not isinstance(name, str) or not isinstance(value, str)
                   or HEX.fullmatch(value) is None for name, value in hashes.items())
            or set(hashes) != set(files)
            or not isinstance(graph.get("edges"), list)
            or not isinstance(routes, list) or not routes
            or not isinstance(entries, list)):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    route_keys = {"url", "repoPath", "mime", "sha256"}
    file_set = set(files)
    if (len(files) != PRODUCTION_GRAPH_FILE_COUNT
            or len(graph["edges"]) != PRODUCTION_GRAPH_EDGE_COUNT
            or len(routes) != PRODUCTION_GRAPH_ROUTE_COUNT
            or not PRODUCTION_GRAPH_ROOTS.issubset(file_set)):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    edge_keys = {"source", "line", "kind", "specifier", "resolved"}
    previous_edge_key = None
    for edge in graph["edges"]:
        if (not isinstance(edge, dict) or set(edge) != edge_keys
                or edge.get("source") not in file_set
                or not isinstance(edge.get("line"), int)
                or isinstance(edge.get("line"), bool)
                or not 1 <= edge["line"] <= (2 ** 53 - 1)
                or not isinstance(edge.get("kind"), str) or not edge["kind"]
                or not isinstance(edge.get("specifier"), str) or not edge["specifier"]
                or not isinstance(edge.get("resolved"), str) or not edge["resolved"]
                or not valid_production_graph_edge(edge, file_set)):
            reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
        edge_key = production_edge_sort_key(edge)
        if previous_edge_key is not None and previous_edge_key >= edge_key:
            reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
        previous_edge_key = edge_key
    if (any(not isinstance(route, dict) or set(route) != route_keys
            or not safe_static_route_url(route["url"])
            or not isinstance(route["repoPath"], str) or route["repoPath"] not in hashes
            or static_mime(route["repoPath"]) is None
            or route["mime"] != static_mime(route["repoPath"])
            or route["sha256"] != hashes[route["repoPath"]]
            for route in routes)
            or routes != sorted(routes, key=lambda route: (route["url"], route["repoPath"]))
            or len({route["url"].translate(ASCII_LOWER) for route in routes}) != len(routes)):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    route_map = {route["url"]: route["repoPath"] for route in routes}
    if route_map != expected_static_routes(files):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    source_hashes = {item.get("path"): item.get("sha256") for item in entries
                     if isinstance(item, dict)}
    if any(source_hashes.get(name) != hashes.get(name) for name in files):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")
    graph_body = canonical({"files": files, "edges": graph["edges"], "fileSha256": hashes,
                            "staticRoutes": routes})
    inner_sha = hashlib.sha256(graph_body).hexdigest()
    if (graph.get("sha256") != inner_sha
            or inner_sha != PRODUCTION_GRAPH_INNER_SHA256):
        reject("PRODUCTION_GRAPH_EVIDENCE_REQUIRED")


def validate_bundle(acceptance_path: Path, release_path: Path, equivalence_path: Path) -> None:
    acceptance = load_canonical_json(acceptance_path, "ACCEPTANCE_INVALID")
    release = load_canonical_json(release_path, "RELEASE_MANIFEST_INVALID")
    equivalence = load_canonical_json(equivalence_path, "EQUIVALENT_STAGING_REQUIRED")
    expected_equivalence_keys = {"schemaVersion", "kind", "productionMachineAttestationSha256",
                                 "gpuModel", "architecture", "sampleRate", "blockFrames",
                                 "poolSize", "speciesLoadEndpoint", "speciesModel"}
    if (set(equivalence) != expected_equivalence_keys or equivalence.get("schemaVersion") != 1
            or equivalence.get("kind") != "isolated-equivalent-spark"
            or equivalence.get("gpuModel") != "NVIDIA GB10"
            or equivalence.get("architecture") != "aarch64"
            or equivalence.get("speciesLoadEndpoint") != "http://127.0.0.1:8081/v1"
            or equivalence.get("speciesModel") != "bird_agent"):
        reject("EQUIVALENT_STAGING_REQUIRED")
    geometry = release.get("geometry", {})
    if any(equivalence.get(name) != geometry.get(name) for name in
           ("sampleRate", "blockFrames", "poolSize")):
        reject("AUDIO_GEOMETRY_MISMATCH")
    release_sha = sha256(release_path)
    if acceptance.get("release", {}).get("releaseManifestSha256") != release_sha:
        reject("RELEASE_TUPLE_MISMATCH")
    validate_acceptance(acceptance, release)
    production_path = equivalence_path.parent / "production-machine-attestation.json"
    staging_path = acceptance_path.parent / "staging-machine-attestation.json"
    if equivalence.get("productionMachineAttestationSha256") != sha256(production_path):
        reject("EQUIVALENT_STAGING_REQUIRED")
    production, staging = validate_evidence_files(acceptance_path, acceptance,
                                                   production_path, staging_path, release)
    validate_production_graph(release_path, acceptance["evidence"]["productionGraphSha256"])
    validate_attestation_evidence(production_path, production)
    validate_attestation_evidence(staging_path, staging)
    validate_machine_equivalence(production, staging)
    if (production["platform"]["architecture"] != equivalence["architecture"]
            or staging["platform"]["architecture"] != equivalence["architecture"]
            or production["platform"]["gpuModel"] != equivalence["gpuModel"]
            or staging["platform"]["gpuModel"] != equivalence["gpuModel"]):
        reject("EQUIVALENT_STAGING_REQUIRED")
    if (staging["environmentEvidence"]["vllmNormalProfile"]
            != acceptance["speciesLoad"]["normalLatencySamplesSha256"]
            or staging["environmentEvidence"]["vllmBurstProfile"]
            != acceptance["speciesLoad"]["burstLatencySamplesSha256"]):
        reject("SPECIES_LOAD_EVIDENCE_REQUIRED")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--acceptance", required=True, type=Path)
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--equivalence", required=True, type=Path)
    args = parser.parse_args()
    try:
        validate_bundle(args.acceptance.resolve(), args.release.resolve(), args.equivalence.resolve())
    except AcceptanceError as exc:
        print(str(exc))
        return 2
    print("PHASE5_ACCEPTANCE_VALID")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
