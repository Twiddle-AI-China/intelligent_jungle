from __future__ import annotations

import copy
import base64
import functools
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
spec = importlib.util.spec_from_file_location("phase5_acceptance", TOOL)
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)

H = "a" * 64

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


def route_mime(repo_path: str) -> str:
    if repo_path.endswith(".html"):
        return "text/html; charset=utf-8"
    if repo_path.endswith(".js"):
        return "application/javascript; charset=utf-8"
    if repo_path.endswith(".json"):
        return "application/json; charset=utf-8"
    raise AssertionError(repo_path)


@pytest.fixture
def release_manifest():
    return {"workerIdentity": {"releaseRevision": "b" * 40, "sourceManifestSha256": "c" * 64,
                               "audioArtifactSha256": "d" * 64},
            "productionGraphSha256": H,
            "geometry": {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                         "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]}}


def valid_acceptance(release_manifest):
    return {"schemaVersion": 1, "status": "accepted",
            "environment": {"kind": "isolated-equivalent-spark",
                            "surfaceProfile": "production-fixed-entry"},
            "release": {"releaseManifestSha256": H, **release_manifest["workerIdentity"]},
            "geometry": copy.deepcopy(release_manifest["geometry"]),
            "durationMinutes": 30, "clients": 4, "slowClients": 1,
            "stability": {"hotClientAbnormalCloses": 0, "hotClientReconnectStorms": 0,
                          "hotClientUnderruns": 0, "pcmCorruptions": 0,
                          "cursorDiscontinuitiesUnexpected": 0},
            "latency": {"runtimeReadyP95Ms": 999, "uiStateLagP95Ms": 149,
                        "renderP95BlockFraction": .69, "renderP99BlockFraction": .89},
            "speciesLoad": {"endpoint": "http://127.0.0.1:8081/v1", "model": "bird_agent",
                            "normalRequests": 1, "burstRequests": 1, "errors": 0,
                            "normalLatencySamplesSha256": H,
                            "burstLatencySamplesSha256": H},
            "audibleSpecies": {name: True for name in ("bass", "pad", "lead", "pluck")},
            "leaseExercise": ["demo", "tracks", "new-ui"],
            "evidence": {name: H for name in ("productionGraphSha256", "phase5E2eSha256",
                         "rawRuntimeReadySamplesSha256", "rawUiStateLagSamplesSha256",
                         "rawRenderSamplesSha256", "soakRunSha256", "productionMachineAttestationSha256",
                         "stagingMachineAttestationSha256", "leaseEvidenceSha256",
                         "listeningChecklistSha256")},
            "operatorListening": {"completed": True, "noClicks": True, "noStalls": True,
                                  "allSpeciesAudible": True, "operator": "tester"}}


def test_valid_acceptance_passes(release_manifest):
    acceptance.validate_acceptance(valid_acceptance(release_manifest), release_manifest)


def test_acceptance_rejects_idle_gpu_numbers(release_manifest):
    value = valid_acceptance(release_manifest)
    value["speciesLoad"]["normalRequests"] = value["speciesLoad"]["burstRequests"] = 0
    with pytest.raises(acceptance.AcceptanceError, match="SPECIES_LOAD_EVIDENCE_REQUIRED"):
        acceptance.validate_acceptance(value, release_manifest)


def test_fake_local_evidence_can_never_satisfy_cutover(release_manifest):
    value = valid_acceptance(release_manifest); value["environment"]["kind"] = "local-fake"
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_acceptance(value, release_manifest)


def test_acceptance_graph_digest_must_match_release_manifest(release_manifest):
    value = valid_acceptance(release_manifest)
    value["evidence"]["productionGraphSha256"] = "e" * 64
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_acceptance(value, release_manifest)


@pytest.mark.parametrize("mutate,code", [
    (lambda x: x.update(durationMinutes=29.99), "SOAK_DURATION_TOO_SHORT"),
    (lambda x: x.update(clients=3), "CLIENT_LOAD_INVALID"),
    (lambda x: x["latency"].update(renderP99BlockFraction=.91), "LATENCY_THRESHOLD_EXCEEDED"),
    (lambda x: x["stability"].update(hotClientUnderruns=1), "SHARED_LOAD_STABILITY_FAILED"),
    (lambda x: x["speciesLoad"].update(errors=1), "SPECIES_LOAD_EVIDENCE_REQUIRED"),
    (lambda x: x["release"].update(releaseRevision="e" * 40), "RELEASE_TUPLE_MISMATCH"),
    (lambda x: x["geometry"].update(poolSize=4), "AUDIO_GEOMETRY_MISMATCH"),
    (lambda x: x["evidence"].update(rawRenderSamplesSha256="bad"),
     "RAW_PERCENTILE_EVIDENCE_REQUIRED"),
    (lambda x: x.update(durationMinutes=float("nan")), "SOAK_DURATION_TOO_SHORT"),
    (lambda x: x["latency"].update(runtimeReadyP95Ms=float("nan")),
     "LATENCY_EVIDENCE_INVALID"),
])
def test_acceptance_fail_closed_cases(release_manifest, mutate, code):
    value = valid_acceptance(release_manifest); mutate(value)
    with pytest.raises(acceptance.AcceptanceError, match=code):
        acceptance.validate_acceptance(value, release_manifest)


def test_schemas_are_strict_json_contracts():
    for name in ("acceptance.schema.json", "machine-attestation.schema.json"):
        value = json.loads((ROOT / "flock-voice-engine/release" / name).read_text())
        assert value["additionalProperties"] is False
        assert value["$schema"].endswith("2020-12/schema")


def test_fake_runner_can_only_write_ineligible_fault_smoke(tmp_path):
    output = tmp_path / "fault-smoke.json"
    result = subprocess.run([sys.executable,
        ROOT / "flock-voice-engine/tools/stress_audio_worker.py",
        "--backend", "fake", "--duration-seconds", "0.02",
        "--release-dir", tmp_path, "--output", output], capture_output=True, text=True)
    assert result.returncode == 0
    value = json.loads(output.read_text())
    assert value["kind"] == "local-fake-fault-smoke"
    assert value["cutoverEligible"] is False
    assert not (tmp_path / "acceptance.json").exists()


def test_raw_samples_are_recomputed_instead_of_trusting_aggregate(tmp_path, release_manifest):
    value = valid_acceptance(release_manifest); raw = tmp_path / "acceptance-evidence"; raw.mkdir()
    def write(path, item):
        path.write_bytes(acceptance.canonical(item)); return acceptance.sha256(path)
    runtime_path = raw / "runtime-ready-samples.json"
    value["evidence"]["rawRuntimeReadySamplesSha256"] = write(runtime_path, [10, 20, 30, 40])
    value["latency"]["runtimeReadyP95Ms"] = 40
    ui = [{"atMs": index * 2000, "latencyMs": 40} for index in range(900)]
    value["evidence"]["rawUiStateLagSamplesSha256"] = write(
        raw / "ui-state-lag-samples.json", ui)
    value["latency"]["uiStateLagP95Ms"] = 40
    render_p95 = [{"atMs": index * 250, "value": .2} for index in range(7200)]
    render_p99 = [{"atMs": index * 250, "value": .3} for index in range(7200)]
    value["evidence"]["rawRenderSamplesSha256"] = write(raw / "render-samples.json",
        {"p95BlockFractions": render_p95, "p99BlockFractions": render_p99})
    value["latency"]["renderP95BlockFraction"] = .2
    value["latency"]["renderP99BlockFraction"] = .3
    value["evidence"]["soakRunSha256"] = write(raw / "soak-run.json", {
        "startedAtUnixMs": 0, "endedAtUnixMs": 1_800_000, "measuredDurationMs": 1_800_000,
        "pcmBlocks": [1, 1, 1, 1], "hotClientMaxPcmGapMs": 100,
        "hotClientFinalPcmAgeMs": [100, 100, 100], "stability": value["stability"]})
    normal = [{"atMs": index * 2000, "ok": True, "latencyMs": 10}
              for index in range(900)]
    burst = [{"atMs": index * 2500, "ok": True, "latencyMs": 20}
             for index in range(720)]
    value["speciesLoad"]["normalRequests"] = len(normal)
    value["speciesLoad"]["burstRequests"] = len(burst)
    value["speciesLoad"]["normalLatencySamplesSha256"] = write(
        raw / "species-normal-samples.json", normal)
    value["speciesLoad"]["burstLatencySamplesSha256"] = write(
        raw / "species-burst-samples.json", burst)
    ready = {"status": 200, "value": {"workerReady": True, "runtimeOwner": "server",
        "audioOwner": "world", "phaseGate": "phase5-local", "workerIdentity": {
            "expected": release_manifest["workerIdentity"],
            "reported": release_manifest["workerIdentity"]}}}
    report = {"config": {"configFile": "/x/playwright.phase5-acceptance.config.js",
        "metadata": {"phase5Mode": True, "phase5Acceptance": True,
                     "surfaceProfile": "production-fixed-entry"},
        "projects": [{"name": "chromium"}]},
        "suites": [{"file": "phase5-local.spec.js", "specs": [{"ok": True, "tests": [{
            "projectName": "chromium", "status": "expected", "results": [{"status": "passed",
            "attachments": [{"name": "phase5-runtime-identity", "contentType": "application/json",
            "body": base64.b64encode(json.dumps(ready).encode()).decode()},
            {"name": "phase5-lease-evidence", "contentType": "application/json",
             "body": ""}]}]}]}]}],
        "stats": {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0}}
    value["evidence"]["productionGraphSha256"] = write(tmp_path / "production-graph.json", {})
    lease = {"schemaVersion": 1, "kind": "production-fixed-entry-chromium-lease-evidence",
             "sequence": ["demo", "tracks", "new-ui"], "surfaceLeases": {
                 name: {"takeAccepted": True, "releaseAccepted": True}
                 for name in ("demo", "tracks", "new-ui")}, "audibleSpecies": {
                 name: {"commandAccepted": True, "releaseAccepted": True,
                        "commandSeq": index * 2 + 1, "releaseCommandSeq": index * 2 + 2,
                        "peakAbs": .1, "pcmBlocks": 1}
                 for index, name in enumerate(("bass", "pad", "lead", "pluck"))}}
    lease["surfaceLeases"]["new-ui"].update({"commandSeq": 9, "releaseCommandSeq": 10})
    report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][1]["body"] = (
        base64.b64encode(json.dumps(lease).encode()).decode())
    value["evidence"]["phase5E2eSha256"] = write(raw / "phase5-e2e.json", report)
    value["evidence"]["leaseEvidenceSha256"] = write(raw / "lease-evidence.json", lease)
    value["evidence"]["listeningChecklistSha256"] = write(
        tmp_path / "listening-checklist.json", value["operatorListening"])
    production = tmp_path / "production.json"; staging = tmp_path / "staging.json"
    production.write_bytes(acceptance.canonical({})); staging.write_bytes(acceptance.canonical({}))
    value["evidence"]["productionMachineAttestationSha256"] = acceptance.sha256(production)
    value["evidence"]["stagingMachineAttestationSha256"] = acceptance.sha256(staging)
    acceptance.validate_evidence_files(tmp_path / "acceptance.json", value, production, staging,
                                       release_manifest)
    value["evidence"]["rawRuntimeReadySamplesSha256"] = write(runtime_path, [5000, 5000, 5000, 5000])
    with pytest.raises(acceptance.AcceptanceError, match="RAW_PERCENTILE_EVIDENCE_REQUIRED"):
        acceptance.validate_evidence_files(tmp_path / "acceptance.json", value, production, staging,
                                           release_manifest)


@functools.lru_cache(maxsize=1)
def authoritative_production_graph():
    graph = json.loads(subprocess.check_output(
        ["node", ROOT / "flock-voice-engine/runtime/tools/build-production-graph.mjs"],
        text=True,
    ))
    revision = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    graph["fileSha256"] = {
        relative: hashlib.sha256(subprocess.check_output([
            "git", "-C", str(ROOT), "show", f"{revision}:{relative}",
        ])).hexdigest()
        for relative in graph["files"]
    }
    for route in graph["staticRoutes"]:
        route["sha256"] = graph["fileSha256"][route["repoPath"]]
    inner = {
        name: graph[name]
        for name in ("files", "edges", "fileSha256", "staticRoutes")
    }
    graph["sha256"] = hashlib.sha256(acceptance.canonical(inner)).hexdigest()
    assert graph["sha256"] == acceptance.PRODUCTION_GRAPH_INNER_SHA256
    return graph


def production_graph_bundle(tmp_path):
    graph = copy.deepcopy(authoritative_production_graph())
    hashes = graph["fileSha256"]
    files = graph["files"]
    graph_path = tmp_path / "production-graph.json"
    graph_path.write_bytes(acceptance.canonical(graph))
    source_path = tmp_path / "source-manifest.json"
    source_path.write_bytes(acceptance.canonical({
        "schemaVersion": 1,
        "entries": [{"path": path, "sha256": hashes[path]} for path in files],
    }))
    graph_sha = acceptance.sha256(graph_path)
    release_path = tmp_path / "release-manifest.json"
    release_path.write_bytes(acceptance.canonical({
        "productionGraphSha256": graph_sha,
        "workerIdentity": {
            "sourceManifestSha256": acceptance.sha256(source_path),
        },
    }))
    return release_path, graph_path, graph_sha, graph


def bind_graph_bundle(release_path, graph_path, graph):
    graph_path.write_bytes(acceptance.canonical(graph))
    graph_sha = acceptance.sha256(graph_path)
    source_sha = acceptance.sha256(release_path.parent / "source-manifest.json")
    release_path.write_bytes(acceptance.canonical({
        "productionGraphSha256": graph_sha,
        "workerIdentity": {"sourceManifestSha256": source_sha},
    }))
    return graph_sha


def test_production_graph_validates_canonical_static_route_digest(tmp_path):
    release_path, _graph_path, graph_sha, _graph = production_graph_bundle(tmp_path)
    acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_rejects_fully_rebound_static_only_subgraph(tmp_path):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    retained = set(REQUIRED_STATIC_ROUTES.values())
    graph["files"] = sorted(retained)
    graph["edges"] = []
    graph["fileSha256"] = {
        path: digest for path, digest in graph["fileSha256"].items()
        if path in retained
    }
    graph["staticRoutes"] = [
        route for route in graph["staticRoutes"]
        if route["repoPath"] in retained
    ]
    inner = {name: graph[name] for name in
             ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(inner)).hexdigest()
    source = json.loads((tmp_path / "source-manifest.json").read_bytes())
    source["entries"] = [
        entry for entry in source["entries"] if entry["path"] in retained
    ]
    (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)

    assert len(graph["files"]) == 11
    assert len(graph["edges"]) == 0
    assert len(graph["staticRoutes"]) == 12
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_rejects_fully_rebound_unknown_static_mime(tmp_path):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    repo_path = "mvp/assets/payload.exe"
    graph["files"].append(repo_path)
    graph["files"].sort()
    graph["fileSha256"][repo_path] = hashlib.sha256(b"payload").hexdigest()
    graph["staticRoutes"].append({
        "url": "/assets/payload.exe",
        "repoPath": repo_path,
        "mime": None,
        "sha256": graph["fileSha256"][repo_path],
    })
    graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    inner = {name: graph[name] for name in
             ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(inner)).hexdigest()
    source = json.loads((tmp_path / "source-manifest.json").read_bytes())
    source["entries"].append({
        "path": repo_path,
        "sha256": graph["fileSha256"][repo_path],
    })
    (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)

    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_binds_canonical_source_manifest_bytes_to_release_identity(tmp_path):
    release_path, _graph_path, graph_sha, _graph = production_graph_bundle(tmp_path)
    source_path = tmp_path / "source-manifest.json"
    source = json.loads(source_path.read_bytes())
    source["entries"].append({
        "path": "unrelated.txt",
        "sha256": "f" * 64,
    })
    source_path.write_bytes(acceptance.canonical(source))

    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_validator_accepts_real_248_edge_graph(tmp_path):
    graph = copy.deepcopy(authoritative_production_graph())
    assert len(graph["files"]) == 164
    assert len(graph["edges"]) == 248
    assert len(graph["staticRoutes"]) == 68
    graph_path = tmp_path / "production-graph.json"
    graph_path.write_bytes(acceptance.canonical(graph))
    source_path = tmp_path / "source-manifest.json"
    source_path.write_bytes(acceptance.canonical({
        "schemaVersion": 1,
        "entries": [
            {"path": path, "sha256": graph["fileSha256"][path]}
            for path in graph["files"]
        ],
    }))
    graph_sha = acceptance.sha256(graph_path)
    release_path = tmp_path / "release-manifest.json"
    release_path.write_bytes(acceptance.canonical({
        "productionGraphSha256": graph_sha,
        "workerIdentity": {
            "sourceManifestSha256": acceptance.sha256(source_path),
        },
    }))

    acceptance.validate_production_graph(release_path, graph_sha)


def test_production_graph_rejects_static_route_drift_even_when_outer_sha_is_rebound(tmp_path):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    graph["staticRoutes"][0]["mime"] = "application/octet-stream"
    drifted_outer_sha = bind_graph_bundle(release_path, graph_path, graph)
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, drifted_outer_sha)


def test_production_graph_rejects_release_manifest_binding_drift(tmp_path):
    release_path, _graph_path, graph_sha, _graph = production_graph_bundle(tmp_path)
    release = json.loads(release_path.read_bytes())
    release["productionGraphSha256"] = "e" * 64
    release_path.write_bytes(acceptance.canonical(release))
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


@pytest.mark.parametrize("unsafe_url", [
    "/double//slash",
    "/trailing/",
    "/%2e%2e/path",
    "/back\\slash",
    "/query?x=1",
    "/fragment#x",
    "/dot/./path",
    "/dot/../path",
])
def test_acceptance_rejects_unsafe_static_route_urls(tmp_path, unsafe_url):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    graph["staticRoutes"][0]["url"] = unsafe_url
    graph_body = {name: graph[name] for name in
                  ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(graph_body)).hexdigest()
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


@pytest.mark.parametrize("mutation", [
    "non-object-edge",
    "wrong-mime",
    "missing-root",
    "extra-runtime-route",
    "replaced-mvp-route",
    "bad-static-root",
    "shadow-legacy-route",
    "rogue-mvp-route",
    "unknown-external",
    "external-wrong-source",
    "unknown-runtime-api",
    "wrong-runtime-api-specifier",
    "wrong-runtime-api-kind",
    "unknown-edge-kind",
    "wrong-source-extension",
    "wrong-target-extension",
    "mismatched-internal-specifier",
    "control-specifier",
    "duplicate-edge",
    "unsorted-edges",
])
def test_acceptance_rejects_fully_rebound_invalid_graph_semantics(tmp_path, mutation):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    if mutation == "non-object-edge":
        graph["edges"] = [7]
    elif mutation == "wrong-mime":
        graph["staticRoutes"][0]["mime"] = "application/octet-stream"
    elif mutation == "missing-root":
        graph["staticRoutes"] = [
            route for route in graph["staticRoutes"] if route["url"] != "/"
        ]
        graph["staticRoutes"].append({
            **next(route for route in graph["staticRoutes"]
                   if route["url"] == "/index.html"),
            "url": "/replacement",
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    elif mutation == "extra-runtime-route":
        repo_path = "flock-voice-engine/runtime/src/simulation-runtime.js"
        graph["staticRoutes"].append({
            "url": "/runtime.js",
            "repoPath": repo_path,
            "mime": route_mime(repo_path),
            "sha256": graph["fileSha256"][repo_path],
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    elif mutation == "replaced-mvp-route":
        route = next(route for route in graph["staticRoutes"]
                     if route["url"] == "/src/server-main.js")
        route["url"] = "/src/replaced.js"
        graph["staticRoutes"].sort(key=lambda item: (item["url"], item["repoPath"]))
    elif mutation == "bad-static-root":
        edge = next(edge for edge in graph["edges"]
                    if edge["resolved"]
                    == "flock-voice-engine/assets/timbre/voice_maps")
        edge["specifier"] = "../../assets/timbre/"
    elif mutation == "shadow-legacy-route":
        repo_path = "mvp/assets/timbre/latent_map.json"
        graph["files"].append(repo_path)
        graph["files"].sort()
        graph["fileSha256"][repo_path] = hashlib.sha256(b"shadow").hexdigest()
        route = next(route for route in graph["staticRoutes"]
                     if route["url"] == "/assets/timbre/latent_map.json")
        route.update({
            "repoPath": repo_path,
            "sha256": graph["fileSha256"][repo_path],
        })
        source = json.loads((tmp_path / "source-manifest.json").read_bytes())
        source["entries"].append({
            "path": repo_path,
            "sha256": graph["fileSha256"][repo_path],
        })
        (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    elif mutation == "rogue-mvp-route":
        repo_path = "mvp/rogue.js"
        graph["files"].append(repo_path)
        graph["files"].sort()
        graph["fileSha256"][repo_path] = hashlib.sha256(b"rogue").hexdigest()
        graph["staticRoutes"].append({
            "url": "/rogue.js",
            "repoPath": repo_path,
            "mime": route_mime(repo_path),
            "sha256": graph["fileSha256"][repo_path],
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
        source = json.loads((tmp_path / "source-manifest.json").read_bytes())
        source["entries"].append({
            "path": repo_path,
            "sha256": graph["fileSha256"][repo_path],
        })
        (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    elif mutation == "unknown-external":
        graph["edges"][0].update({
            "specifier": "external:evil",
            "resolved": "external:evil",
        })
    elif mutation == "external-wrong-source":
        graph["edges"][0]["source"] = "mvp/src/server-main.js"
    elif mutation == "unknown-runtime-api":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.runtime-api",
            "specifier": "/api/evil",
            "resolved": "runtime-api:/api/evil",
        })
    elif mutation == "wrong-runtime-api-specifier":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.runtime-api",
            "specifier": "/api/v1/latent-maps/pad",
            "resolved": "runtime-api:/api/v1/bootstrap",
        })
    elif mutation == "wrong-runtime-api-kind":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.fetch",
            "specifier": "/api/v1/bootstrap",
            "resolved": "runtime-api:/api/v1/bootstrap",
        })
    elif mutation == "unknown-edge-kind":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.unknown",
            "specifier": "../index.html",
            "resolved": "mvp/index.html",
        })
    elif mutation == "wrong-source-extension":
        graph["edges"][0].update({
            "source": "mvp/index.html",
            "kind": "js.import",
            "specifier": "src/server-main.js",
            "resolved": "mvp/src/server-main.js",
        })
    elif mutation == "wrong-target-extension":
        graph["edges"][0].update({
            "kind": "js.audio-worklet",
            "specifier": "./demo.html",
            "resolved": "flock-voice-engine/client/demo.html",
        })
    elif mutation == "mismatched-internal-specifier":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.import",
            "specifier": "./server-main.js",
            "resolved": "flock-voice-engine/runtime/src/simulation-runtime.js",
        })
    elif mutation == "control-specifier":
        graph["edges"][0]["specifier"] = "external:configurable-fetch\n"
    elif mutation == "duplicate-edge":
        graph["edges"].insert(1, copy.deepcopy(graph["edges"][0]))
    else:
        graph["edges"].reverse()
    graph_body = {name: graph[name] for name in
                  ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(graph_body)).hexdigest()
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)
