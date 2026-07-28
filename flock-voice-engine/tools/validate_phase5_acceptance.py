#!/usr/bin/env python3
"""Fail-closed validator for Phase 5 equivalent-host acceptance evidence."""
from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import math
import posixpath
import re
from pathlib import Path

HEX = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
SSH_FINGERPRINT = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
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
    "0051816406dbad274e9a9ac6a66cae0bcb1d051b569b6322af5948e2c48ed0ff"
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
PRODUCTION_GRAPH_FILE_COUNT = 164
PRODUCTION_GRAPH_EDGE_COUNT = 248
PRODUCTION_GRAPH_ROUTE_COUNT = 68


class AcceptanceError(RuntimeError):
    pass


def reject(code: str) -> None:
    raise AcceptanceError(code)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


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
    if "$ref" in schema:
        target = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            target = target[part]
        return _schema_matches(value, target, root)
    if "const" in schema and value != schema["const"]:
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
        return (isinstance(value, str) and len(value) >= schema.get("minLength", 0)
                and ("pattern" not in schema or re.fullmatch(schema["pattern"], value) is not None))
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool) and value >= schema.get("minimum", -math.inf)
    if kind == "number":
        return (isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value) and value >= schema.get("minimum", -math.inf))
    if kind == "boolean": return isinstance(value, bool)
    if "enum" in schema: return value in schema["enum"]
    return True


def validate_declared_schema(value: object, filename: str, code: str) -> None:
    local = Path(__file__).with_name(filename)
    source = Path(__file__).resolve().parents[1] / "release" / filename
    schema_path = local if local.is_file() else source
    try:
        schema = json.loads(schema_path.read_bytes())
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AcceptanceError(code) from exc
    if not _schema_matches(value, schema, schema):
        reject(code)


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


def validate_attestation(value: object) -> None:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        reject("EQUIVALENT_STAGING_REQUIRED")
    if HEX.fullmatch(value.get("machineIdSha256", "")) is None:
        reject("EQUIVALENT_STAGING_REQUIRED")
    if SSH_FINGERPRINT.fullmatch(value.get("sshHostKeySha256", "")) is None:
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
            or any(HEX.fullmatch(item) is None for item in raw.values())):
        reject("EQUIVALENT_STAGING_REQUIRED")
    required_environment = {"cudaDriver", "torch", "availableMemory",
                            "architecture", "vllmNormalProfile", "vllmBurstProfile"}
    if (not isinstance(environment, dict) or set(environment) != required_environment
            or any(HEX.fullmatch(item) is None for item in environment.values())):
        reject("EQUIVALENT_STAGING_REQUIRED")
    allowed = {"schemaVersion", "hostname", "machineIdSha256", "sshHostKeySha256",
               "canonicalInterfaceAddresses", "gpuUuids", "platform", "rawEvidence",
               "environmentEvidence"}
    if set(value) - allowed:
        reject("EQUIVALENT_STAGING_REQUIRED")
    platform_value = value.get("platform")
    platform_keys = {"architecture", "gpuModel", "driverVersion", "torchVersion", "cudaVersion",
                     "cudaAvailable", "availableMemoryBytes"}
    if (not isinstance(platform_value, dict) or set(platform_value) != platform_keys
            or platform_value.get("architecture") != "aarch64"
            or not all(isinstance(platform_value.get(name), str) and platform_value[name]
                       for name in ("gpuModel", "driverVersion", "torchVersion", "cudaVersion"))
            or platform_value.get("cudaAvailable") is not True
            or not isinstance(platform_value.get("availableMemoryBytes"), int)
            or platform_value["availableMemoryBytes"] <= 0):
        reject("EQUIVALENT_STAGING_REQUIRED")
    validate_declared_schema(value, "machine-attestation.schema.json", "EQUIVALENT_STAGING_REQUIRED")


def validate_attestation_evidence(path: Path, value: dict) -> None:
    evidence_dir = path.with_suffix(".evidence")
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
    for (section, field), name in fields.items():
        if sha256(evidence_dir / name) != value[section][field]:
            reject("EQUIVALENT_STAGING_REQUIRED")
    try:
        raw_interfaces = json.loads((evidence_dir / "interfaces.json").read_bytes())
        claimed = [item["local"] for interface in raw_interfaces
                   for item in interface.get("addr_info", []) if "local" in item]
        raw_gpus = sorted(set(line.strip() for line in
                              (evidence_dir / "gpus.txt").read_text().splitlines() if line.strip()))
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, KeyError) as exc:
        raise AcceptanceError("EQUIVALENT_STAGING_REQUIRED") from exc
    if canonical_machine_addresses(claimed) != value["canonicalInterfaceAddresses"]:
        reject("EQUIVALENT_STAGING_REQUIRED")
    if raw_gpus != value["gpuUuids"]:
        reject("EQUIVALENT_STAGING_REQUIRED")
    try:
        public_key = (evidence_dir / "ssh-host-ed25519.pub").read_bytes().strip().split()
        key_blob = base64.b64decode(public_key[1], validate=True)
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(key_blob).digest()).decode().rstrip("=")
    except (OSError, IndexError, ValueError) as exc:
        raise AcceptanceError("EQUIVALENT_STAGING_REQUIRED") from exc
    if value["machineIdSha256"] != value["rawEvidence"]["machineId"]:
        reject("EQUIVALENT_STAGING_REQUIRED")
    if public_key[0] != b"ssh-ed25519" or fingerprint != value["sshHostKeySha256"]:
        reject("EQUIVALENT_STAGING_REQUIRED")
    try:
        driver, gpu_model, _memory = [item.strip() for item in
                                      (evidence_dir / "cuda-driver.txt").read_text().splitlines()[0].split(",", 2)]
        torch_value = json.loads((evidence_dir / "torch.json").read_bytes())
        available_line = next(line for line in
                              (evidence_dir / "available-memory.txt").read_text().splitlines()
                              if line.startswith("MemAvailable:"))
        available_bytes = int(available_line.split()[1]) * 1024
        architecture = (evidence_dir / "architecture.txt").read_text().strip().lower()
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, IndexError, StopIteration) as exc:
        raise AcceptanceError("EQUIVALENT_STAGING_REQUIRED") from exc
    platform_value = value["platform"]
    if (driver != platform_value["driverVersion"] or gpu_model != platform_value["gpuModel"]
            or torch_value.get("version") != platform_value["torchVersion"]
            or torch_value.get("cuda") != platform_value["cudaVersion"]
            or torch_value.get("available") is not True
            or available_bytes != platform_value["availableMemoryBytes"]
            or ("aarch64" if architecture == "arm64" else architecture)
               != platform_value["architecture"]):
        reject("EQUIVALENT_STAGING_REQUIRED")
    for name in ("vllm-normal-profile.json", "vllm-burst-profile.json"):
        samples = load_raw_json(evidence_dir / name, "EQUIVALENT_STAGING_REQUIRED")
        if not isinstance(samples, list) or not samples:
            reject("EQUIVALENT_STAGING_REQUIRED")
        for sample in samples:
            if (not isinstance(sample, dict) or set(sample) != {"atMs", "ok", "latencyMs"}
                    or not isinstance(sample["ok"], bool)):
                reject("EQUIVALENT_STAGING_REQUIRED")
            _number(sample["atMs"], "EQUIVALENT_STAGING_REQUIRED")
            _number(sample["latencyMs"], "EQUIVALENT_STAGING_REQUIRED")


def validate_machine_separation(production: object, staging: object) -> None:
    validate_attestation(production)
    validate_attestation(staging)
    if (production["machineIdSha256"] == staging["machineIdSha256"]
            or production["sshHostKeySha256"] == staging["sshHostKeySha256"]
            or set(production["gpuUuids"]).intersection(staging["gpuUuids"])):
        reject("EQUIVALENT_STAGING_REQUIRED")
    assert_machine_address_sets_are_distinct(production["canonicalInterfaceAddresses"],
                                             staging["canonicalInterfaceAddresses"])


def _number(value: object, code: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        reject(code)
    return float(value)


def nearest_rank(values: object, fraction: float, code: str) -> float:
    if (not isinstance(values, list) or not values
            or any(isinstance(item, bool) or not isinstance(item, (int, float))
                   or not math.isfinite(item) or item < 0 for item in values)):
        reject(code)
    ordered = sorted(float(item) for item in values)
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
    if (times != sorted(times) or times[0] > cadence_ms * 2
            or times[-1] < duration_ms - cadence_ms * 3
            or any(right - left > cadence_ms * 4 for left, right in zip(times, times[1:]))):
        reject(code)
    return values


def load_raw_json(path: Path, code: str) -> object:
    try:
        raw = path.read_bytes(); value = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AcceptanceError(code) from exc
    if raw != canonical(value):
        reject(code)
    return value


def validate_chromium_evidence(path: Path, expected_identity: dict) -> dict:
    try:
        value = json.loads(path.read_bytes())
        config = value["config"]; metadata = config["metadata"]; projects = config["projects"]
        suites = value["suites"]; stats = value["stats"]
        spec = next(item for item in suites if item.get("file") == "phase5-local.spec.js")
        spec_item = spec["specs"][0]; test = spec_item["tests"][0]; result = test["results"][0]
        attachments = result["attachments"]
        attachment = next(item for item in attachments
                          if item.get("name") == "phase5-runtime-identity"
                          and item.get("contentType") == "application/json")
        ready = json.loads(base64.b64decode(attachment["body"], validate=True))
        lease_attachment = next(item for item in attachments
                                if item.get("name") == "phase5-lease-evidence"
                                and item.get("contentType") == "application/json")
        lease = json.loads(base64.b64decode(lease_attachment["body"], validate=True))
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, IndexError, StopIteration,
            TypeError) as exc:
        raise AcceptanceError("PHASE5_PRODUCTION_E2E_REQUIRED") from exc
    if (Path(config.get("configFile", "")).name != "playwright.phase5-acceptance.config.js"
            or metadata.get("phase5Mode") is not True
            or metadata.get("phase5Acceptance") is not True
            or metadata.get("surfaceProfile") != "production-fixed-entry"
            or len(projects) != 1 or projects[0].get("name") != "chromium"
            or len(spec["specs"]) != 1 or spec_item.get("ok") is not True
            or test.get("projectName") != "chromium" or test.get("status") != "expected"
            or len(test["results"]) != 1 or result.get("status") != "passed"
            or len(attachments) != 2 or ready.get("status") != 200
            or ready.get("value", {}).get("workerReady") is not True
            or ready["value"].get("runtimeOwner") != "server"
            or ready["value"].get("audioOwner") != "world"
            or ready["value"].get("phaseGate") not in {"phase5-local", "phase5-production"}
            or ready["value"].get("workerIdentity", {}).get("expected") != expected_identity
            or ready["value"].get("workerIdentity", {}).get("reported") != expected_identity
            or stats.get("expected") != 1 or stats.get("unexpected") != 0
            or stats.get("skipped") != 0 or stats.get("flaky") != 0):
        reject("PHASE5_PRODUCTION_E2E_REQUIRED")
    return lease


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
    chromium_lease = validate_chromium_evidence(
        raw_root / "phase5-e2e.json", release["workerIdentity"])
    try:
        lease = json.loads((raw_root / "lease-evidence.json").read_bytes())
        checklist = json.loads((root / "listening-checklist.json").read_bytes())
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AcceptanceError("RAW_PERCENTILE_EVIDENCE_REQUIRED") from exc
    if (lease.get("schemaVersion") != 1
            or lease.get("kind") != "production-fixed-entry-chromium-lease-evidence"
            or lease.get("sequence") != ["demo", "tracks", "new-ui"]
            or lease != chromium_lease):
        reject("SEQUENTIAL_LEASE_EVIDENCE_REQUIRED")
    surfaces = lease.get("surfaceLeases", {})
    new_ui = surfaces.get("new-ui", {}) if isinstance(surfaces, dict) else {}
    if (set(surfaces) != {"demo", "tracks", "new-ui"}
            or any(surfaces.get(surface) != {
                "takeAccepted": True, "releaseAccepted": True}
                for surface in ("demo", "tracks"))
            or set(new_ui) != {"takeAccepted", "releaseAccepted", "commandSeq",
                               "releaseCommandSeq"}
            or new_ui.get("takeAccepted") is not True
            or new_ui.get("releaseAccepted") is not True
            or not isinstance(new_ui.get("commandSeq"), int)
            or not isinstance(new_ui.get("releaseCommandSeq"), int)
            or new_ui["commandSeq"] < 1
            or new_ui["releaseCommandSeq"] <= new_ui["commandSeq"]):
        reject("SEQUENTIAL_LEASE_EVIDENCE_REQUIRED")
    for species in ("bass", "pad", "lead", "pluck"):
        probe = lease.get("audibleSpecies", {}).get(species, {})
        if (probe.get("commandAccepted") is not True or probe.get("releaseAccepted") is not True
                or not isinstance(probe.get("pcmBlocks"), int) or probe["pcmBlocks"] < 1
                or not isinstance(probe.get("commandSeq"), int) or probe["commandSeq"] < 1
                or not isinstance(probe.get("releaseCommandSeq"), int)
                or probe["releaseCommandSeq"] <= probe["commandSeq"]
                or _number(probe.get("peakAbs"), "AUDIBLE_SPECIES_EVIDENCE_REQUIRED") <= 1e-7):
            reject("AUDIBLE_SPECIES_EVIDENCE_REQUIRED")
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
        sample_times = [float(item["atMs"]) for item in samples]
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
    validate_machine_separation(production, staging)
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
