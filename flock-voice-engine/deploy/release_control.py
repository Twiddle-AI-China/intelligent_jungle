#!/usr/bin/env python3
"""Fail-closed Phase 5 release controller (local scope through Task 9)."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
LOCAL_CONTAINERS = ("flock-runtime-candidate", "flock-audio-candidate")


class ReleaseError(RuntimeError):
    pass


def fail(code: str) -> None:
    raise ReleaseError(code)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, code: str = "RELEASE_MANIFEST_INVALID") -> dict:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReleaseError(code) from exc
    if not isinstance(value, dict):
        fail(code)
    return value


def require_local_scope() -> None:
    if os.environ.get("FLOCK_DEPLOY_SCOPE") != "local":
        fail("LOCAL_DEPLOY_SCOPE_REQUIRED")
    forbidden = " ".join(sys.argv + list(os.environ.values()))
    if any(token in forbidden for token in ("192.168.9.140", "/srv/deploy", "0.0.0.0:8090:8090")):
        fail("PRODUCTION_TARGET_REJECTED")


def require_release_gate_platform() -> None:
    if sys.platform != "linux":
        fail("RELEASE_GATE_REQUIRES_LINUX")


def container_user() -> str:
    return f"{os.getuid()}:{os.getgid()}"


def run(*args: str, capture: bool = False) -> str:
    try:
        result = subprocess.run(args, check=True, text=True,
                                stdout=subprocess.PIPE if capture else None)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("COMMAND_FAILED") from exc
    return result.stdout.strip() if capture else ""


def validate_base_images(inputs: Path) -> dict:
    value = load_json(inputs, "AUDIO_INPUTS_INVALID")
    images = value.get("baseImages")
    if not isinstance(images, dict) or set(images) != {"runtime", "audio"}:
        fail("BASE_IMAGE_DIGEST_INVALID")
    for name in images:
        item = images[name]
        if not isinstance(item, dict) or not isinstance(item.get("repository"), str):
            fail("BASE_IMAGE_DIGEST_INVALID")
        repository = item["repository"]
        tail = repository.rsplit("/", 1)[-1]
        if "@" in repository or ":" in tail or DIGEST.fullmatch(item.get("digest", "")) is None:
            fail("BASE_IMAGE_DIGEST_INVALID")
    return value


def oci_manifest_digest(archive: Path) -> tuple[str, str]:
    """Return selected linux/arm64 manifest digest and its config digest."""
    try:
        with tarfile.open(archive, "r:*") as tf:
            members = {member.name: member for member in tf.getmembers() if member.isfile()}
            def body(name: str) -> bytes:
                member = members.get(name)
                if member is None or member.size > 64 * 1024 * 1024:
                    fail("OCI_LAYOUT_INVALID")
                stream = tf.extractfile(member)
                if stream is None:
                    fail("OCI_LAYOUT_INVALID")
                return stream.read()
            index = json.loads(body("index.json"))
            descriptors = index.get("manifests", [])
            selected = [d for d in descriptors if d.get("platform", {}).get("architecture") == "arm64"
                        and d.get("platform", {}).get("os") == "linux"]
            if len(selected) != 1 or DIGEST.fullmatch(selected[0].get("digest", "")) is None:
                fail("OCI_ARM64_MANIFEST_MISSING")
            descriptor = selected[0]
            blob_name = "blobs/sha256/" + descriptor["digest"].split(":", 1)[1]
            manifest_bytes = body(blob_name)
            if len(manifest_bytes) != descriptor.get("size") or "sha256:" + hashlib.sha256(manifest_bytes).hexdigest() != descriptor["digest"]:
                fail("OCI_MANIFEST_DIGEST_MISMATCH")
            manifest = json.loads(manifest_bytes)
            children = [manifest.get("config"), *manifest.get("layers", [])]
            for child in children:
                if not isinstance(child, dict) or DIGEST.fullmatch(child.get("digest", "")) is None:
                    fail("OCI_DESCRIPTOR_INVALID")
                blob = body("blobs/sha256/" + child["digest"].split(":", 1)[1])
                if len(blob) != child.get("size") or "sha256:" + hashlib.sha256(blob).hexdigest() != child["digest"]:
                    fail("OCI_BLOB_DIGEST_MISMATCH")
            return descriptor["digest"], manifest["config"]["digest"]
    except (OSError, tarfile.TarError, KeyError, TypeError, json.JSONDecodeError) as exc:
        if isinstance(exc, ReleaseError):
            raise
        raise ReleaseError("OCI_LAYOUT_INVALID") from exc


def manifest_pair(release_dir: Path) -> dict:
    path = release_dir / "release-manifest.json"
    sidecar = release_dir / "release-manifest.json.sha256"
    manifest = load_json(path)
    try:
        line = sidecar.read_text("ascii")
    except OSError as exc:
        raise ReleaseError("RELEASE_MANIFEST_SIDECAR_MISSING") from exc
    expected = f"{sha(path)}  release-manifest.json\n"
    if line != expected or canonical(manifest) != path.read_bytes():
        fail("RELEASE_MANIFEST_SIDECAR_INVALID")
    return manifest


def write_manifest_pair(release_dir: Path, manifest: dict) -> None:
    path = release_dir / "release-manifest.json"
    path.write_bytes(canonical(manifest))
    (release_dir / "release-manifest.json.sha256").write_text(
        f"{sha(path)}  release-manifest.json\n", encoding="ascii")


def production_graph_from_head(repo: Path, output: Path) -> dict:
    snapshot = output / ".graph-head"
    snapshot.mkdir(mode=0o700)
    archive = subprocess.check_output(["git", "-C", str(repo), "archive", "--format=tar", "HEAD"])
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tf:
        members = tf.getmembers()
        if any(not (member.isdir() or member.isfile()) for member in members):
            fail("SOURCE_PATH_INVALID")
        tf.extractall(snapshot, members=members)
    install_env = {**os.environ, "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"}
    try:
        subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                       cwd=snapshot / "flock-voice-engine/runtime", env=install_env,
                       check=True, stdout=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_DEPENDENCIES_INVALID") from exc
    try:
        value = json.loads(run("node", str(snapshot / "flock-voice-engine/runtime/tools/build-production-graph.mjs"),
                               capture=True))
    except json.JSONDecodeError as exc:
        raise ReleaseError("PRODUCTION_GRAPH_INVALID") from exc
    finally:
        shutil.rmtree(snapshot)
    return value


def materialize_runtime_context(repo: Path, output: Path, graph: dict) -> Path:
    context = output / ".build-runtime-context"
    context.mkdir(mode=0o700)
    files = graph.get("files")
    if not isinstance(files, list) or not files:
        fail("PRODUCTION_GRAPH_INVALID")
    bundle = context / "production-bundle"
    allowed = ("mvp/", "flock-voice-engine/client/", "flock-voice-engine/assets/",
               "flock-voice-engine/runtime/src/")
    tracked = set(run("git", "-C", str(repo), "ls-tree", "-r", "--name-only", "HEAD",
                      capture=True).splitlines())
    for relative in files:
        if not isinstance(relative, str) or not relative.startswith(allowed):
            continue
        if relative not in tracked:
            fail("PRODUCTION_GRAPH_UNTRACKED_SOURCE")
        destination = bundle / relative.removeprefix("flock-voice-engine/")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(subprocess.check_output(
            ["git", "-C", str(repo), "show", f"HEAD:{relative}"]))
    package = context / "runtime-package"
    package.mkdir()
    for name in ("package.json", "package-lock.json"):
        relative = f"flock-voice-engine/runtime/{name}"
        (package / name).write_bytes(subprocess.check_output(
            ["git", "-C", str(repo), "show", f"HEAD:{relative}"]))
    (context / "Dockerfile.runtime").write_bytes(subprocess.check_output(
        ["git", "-C", str(repo), "show", "HEAD:flock-voice-engine/deploy/Dockerfile.runtime"]))
    return context


def copy_tracked_scope(repo: Path, scope: str, destination_root: Path) -> None:
    names = run("git", "-C", str(repo), "ls-tree", "-r", "--name-only", "HEAD", "--",
                scope, capture=True).splitlines()
    if not names:
        fail("TRACKED_RELEASE_SCOPE_EMPTY")
    for relative in names:
        destination = destination_root / Path(relative).relative_to(scope)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(subprocess.check_output(
            ["git", "-C", str(repo), "show", f"HEAD:{relative}"]))


def materialize_audio_context(repo: Path, output: Path, graph: dict) -> Path:
    context = output / ".build-audio-context"
    context.mkdir(mode=0o700)
    names = [name for name in graph.get("files", [])
             if isinstance(name, str) and name.startswith("flock-voice-engine/server/")]
    if not names:
        fail("AUDIO_SOURCE_MANIFEST_EMPTY")
    for relative in names:
        destination = context / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(subprocess.check_output(
            ["git", "-C", str(repo), "show", f"HEAD:{relative}"]))
    lock = "flock-voice-engine/deploy/requirements-audio.lock"
    destination = context / lock; destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(subprocess.check_output(
        ["git", "-C", str(repo), "show", f"HEAD:{lock}"]))
    (context / "Dockerfile.audio").write_bytes(subprocess.check_output(
        ["git", "-C", str(repo), "show", "HEAD:flock-voice-engine/deploy/Dockerfile.audio"]))
    return context


def build_local(args) -> None:
    require_local_scope()
    inputs = Path(args.inputs).resolve()
    if not inputs.is_file():
        fail("AUDIO_INPUTS_MISSING")
    values = validate_base_images(inputs)
    output = Path(args.output).resolve()
    if output.exists():
        fail("OUTPUT_PATH_EXISTS")
    repo = Path(__file__).resolve().parents[2]
    builder = repo / "flock-voice-engine/tools/build_release_artifact.py"
    run(sys.executable, str(builder), "--repo-root", str(repo), "--inputs", str(inputs), "--output", str(output))
    (output / "deploy").mkdir()
    copy_tracked_scope(repo, "flock-voice-engine/deploy", output / "deploy")
    (output / "deploy/prepare-cutover-request.mjs").write_bytes(subprocess.check_output([
        "git", "-C", str(repo), "show",
        "HEAD:flock-voice-engine/runtime/tools/prepare-cutover-request.mjs",
    ]))
    for source, destination in (
        ("flock-voice-engine/tools/validate_phase5_acceptance.py", "validate_phase5_acceptance.py"),
        ("flock-voice-engine/release/acceptance.schema.json", "acceptance.schema.json"),
        ("flock-voice-engine/release/machine-attestation.schema.json", "machine-attestation.schema.json"),
    ):
        (output / "deploy" / destination).write_bytes(subprocess.check_output(
            ["git", "-C", str(repo), "show", f"HEAD:{source}"]))
    images_dir = output / "images"
    images_dir.mkdir(mode=0o700)
    graph = production_graph_from_head(repo, output)
    (output / "production-graph.json").write_bytes(canonical(graph))
    runtime_context = materialize_runtime_context(repo, output, graph)
    audio_context = materialize_audio_context(repo, output, graph)
    source_root = output / "source"
    (source_root / "flock-voice-engine").mkdir(parents=True)
    bundle = runtime_context / "production-bundle"
    shutil.copytree(bundle / "mvp", source_root / "mvp")
    for name in ("runtime", "client", "assets"):
        shutil.copytree(bundle / name, source_root / "flock-voice-engine" / name)
    built_manifest = manifest_pair(output)
    declared_bases = {name: {key: values["baseImages"][name][key]
                             for key in ("repository", "digest")}
                      for name in ("runtime", "audio")}
    if built_manifest.get("baseImages") != declared_bases:
        fail("BASE_IMAGE_MANIFEST_MISMATCH")
    revision = built_manifest["workerIdentity"]["releaseRevision"]
    source_sha = built_manifest["workerIdentity"]["sourceManifestSha256"]
    tags = {name: f"flock-{name}:{revision}-{source_sha[:12]}" for name in ("runtime", "audio")}
    for name in ("runtime", "audio"):
        item = values["baseImages"][name]
        context = runtime_context if name == "runtime" else audio_context
        dockerfile = context / f"Dockerfile.{name}"
        archive = images_dir / f"{name}.oci.tar"
        prefix = name.upper()
        common = ("docker", "buildx", "build", "--platform", "linux/arm64", "--provenance=false",
                  "--file", str(dockerfile), "--build-arg", f"{prefix}_BASE_REPOSITORY={item['repository']}",
                  "--build-arg", f"{prefix}_BASE_DIGEST={item['digest']}")
        run(*common, "--tag", tags[name], "--output", f"type=oci,dest={archive}", str(context))
        run(*common, "--load", "--tag", tags[name], str(context))
    manifest = manifest_pair(output)
    manifest["deployReleaseScriptSha256"] = sha(output / "deploy/release.sh")
    manifest["bootstrapSha256"] = sha(output / "deploy/import-release.sh")
    manifest["deployExecutionIdentity"] = {
        name: sha(output / "deploy" / name)
        for name in ("release.sh", "release_control.py", "verify-smoke.mjs",
                     "verify-candidate.sh", "prepare-cutover-request.mjs",
                     "validate_phase5_acceptance.py", "acceptance.schema.json",
                     "machine-attestation.schema.json")
    }
    identities = {}
    diagnostics = {}
    for name in ("runtime", "audio"):
        identities[name], config_digest = oci_manifest_digest(images_dir / f"{name}.oci.tar")
        engine_id = run("docker", "image", "inspect", "--format", "{{.Id}}", tags[name], capture=True)
        if engine_id != config_digest:
            fail("LOADED_IMAGE_CONFIG_MISMATCH")
        diagnostics[name] = {"localEngineImageId": engine_id, "tag": tags[name]}
    manifest["imageIdentity"] = identities
    manifest["localImageDiagnostics"] = diagnostics
    if run("git", "-C", str(repo), "status", "--porcelain", "--untracked-files=no", capture=True):
        fail("TRACKED_TREE_DIRTY")
    if run("git", "-C", str(repo), "rev-parse", "HEAD", capture=True) != revision:
        fail("CANDIDATE_REVISION_CHANGED")
    write_manifest_pair(output, manifest)
    shutil.rmtree(runtime_context)
    shutil.rmtree(audio_context)


def stage_local(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest = manifest_pair(release_dir)
    revision = manifest["workerIdentity"]["releaseRevision"]
    tags = manifest.get("localImageDiagnostics", {})
    runtime_tag = tags.get("runtime", {}).get("tag", "")
    audio_tag = tags.get("audio", {}).get("tag", "")
    if "latest" in runtime_tag or "latest" in audio_tag or not runtime_tag or not audio_tag:
        fail("IMMUTABLE_IMAGE_TAG_REQUIRED")
    for name, tag in (("runtime", runtime_tag), ("audio", audio_tag)):
        loaded = run("docker", "image", "inspect", "--format", "{{.Id}}", tag, capture=True)
        if loaded != tags[name].get("localEngineImageId"):
            fail("LOADED_IMAGE_CONFIG_MISMATCH")
    rollback_state = {
        "schemaVersion": 1,
        "releaseManifestSha256": sha(release_dir / "release-manifest.json"),
        "kind": "reset",
        "previousState": "absent",
        "stateRecord": {"policy": "reset-new-world"},
        "previousImageIdentity": manifest["imageIdentity"],
        "previousImages": {name: dict(tags[name]) for name in ("runtime", "audio")},
    }
    (release_dir / "rollback-state.json").write_bytes(canonical(rollback_state))
    socket_dir = release_dir / "run-flock-audio"
    socket_dir.mkdir(mode=0o770, exist_ok=True)
    os.chmod(socket_dir, 0o770)
    maintenance_secret = socket_dir / "maintenance-token"
    maintenance_secret.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    os.chmod(maintenance_secret, 0o400)
    user = container_user()
    for container in ("flock-runtime", "flock-audio"):
        probe = subprocess.run(["docker", "container", "inspect", container],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            fail("PRODUCTION_CONTAINER_PRESENT")
    for container in LOCAL_CONTAINERS:
        probe = subprocess.run(["docker", "container", "inspect", container],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            fail("CANDIDATE_CONTAINER_ALREADY_EXISTS")
    run("docker", "run", "-d", "--name", "flock-audio-candidate", "--gpus", "all",
        "--user", user,
        "--mount", f"type=bind,src={release_dir},dst=/release,readonly",
        "--mount", f"type=bind,src={socket_dir},dst=/run/flock-audio",
        tags["audio"]["localEngineImageId"])
    try:
        run("docker", "run", "-d", "--name", "flock-runtime-candidate",
            "--user", user,
            "--publish", "127.0.0.1:18090:8090", "--env", "FLOCK_RUNTIME_PROFILE=container-local",
            "--env", f"FLOCK_RELEASE_REVISION={manifest['workerIdentity']['releaseRevision']}",
            "--env", f"FLOCK_SOURCE_MANIFEST_SHA256={manifest['workerIdentity']['sourceManifestSha256']}",
            "--mount", f"type=bind,src={release_dir},dst=/release,readonly",
            "--mount", f"type=bind,src={socket_dir},dst=/run/flock-audio",
            "--mount", f"type=bind,src={maintenance_secret},dst=/run/secrets/flock-maintenance-token,readonly",
            tags["runtime"]["localEngineImageId"])
    except ReleaseError:
        cleanup = subprocess.run(["docker", "rm", "-f", "flock-audio-candidate"])
        if cleanup.returncode != 0:
            fail("PARTIAL_STAGE_CLEANUP_FAILED")
        raise


def get_json(base: str, path: str) -> tuple[int, dict]:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(base + path, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try: return exc.code, json.loads(exc.read())
        except Exception: return exc.code, {}
    except Exception as exc:
        raise ReleaseError("CANDIDATE_HTTP_FAILED") from exc


def verify_candidate(args) -> None:
    release_dir = Path(args.release_dir).resolve()
    manifest = manifest_pair(release_dir)
    if args.base_url != "http://127.0.0.1:18090":
        fail("LOOPBACK_CANDIDATE_URL_REQUIRED")
    health_status, _ = get_json(args.base_url, "/healthz")
    ready_status, ready = get_json(args.base_url, "/readyz")
    identity = ready.get("workerIdentity", {})
    valid = (health_status == 200 and ready_status == 200 and ready.get("runtimeOwner") == "server"
             and ready.get("audioOwner") == "world" and ready.get("workerReady") is True
             and identity.get("expected") == identity.get("reported") == manifest.get("workerIdentity")
             and ready.get("phaseGate") in {"phase5-local", "phase5-production"})
    if not valid:
        fail("CANDIDATE_NOT_IDENTITY_READY")
    status, _ = get_json(args.base_url, "/api/decoder-status")
    if status != 200:
        fail("CANDIDATE_SMOKE_FAILED")
    run("node", str(Path(__file__).with_name("verify-smoke.mjs")), args.base_url)


def verify_local(args) -> None:
    require_local_scope()
    verify_candidate(args)
    record = Path(args.release_dir) / "local-verification.json"
    record.write_bytes(canonical({"schemaVersion": 1, "status": "verified-local-only",
                                  "cutoverEligible": False,
                                  "releaseManifestSha256": sha(Path(args.release_dir) / "release-manifest.json")}))


def checksum(path: Path) -> None:
    path.with_name(path.name + ".sha256").write_text(f"{sha(path)}  {path.name}\n", encoding="ascii")


def bound_record(path: Path, release_sha: str, status: str, code: str) -> dict:
    value = load_json(path, code)
    bound_sha = value.get("releaseManifestSha256")
    if status == "accepted":
        bound_sha = value.get("release", {}).get("releaseManifestSha256")
    if (canonical(value) != path.read_bytes() or value.get("schemaVersion") != 1
            or value.get("status") != status
            or bound_sha != release_sha):
        fail(code)
    return value


def exact_checksum(path: Path) -> None:
    sidecar = path.with_name(path.name + ".sha256")
    try:
        value = sidecar.read_text("ascii")
    except OSError as exc:
        raise ReleaseError("CHECKSUM_SIDECAR_MISSING") from exc
    if value != f"{sha(path)}  {path.name}\n":
        fail("CHECKSUM_SIDECAR_INVALID")


def archive_member_sha(archive: Path, member: str) -> str:
    try:
        body = subprocess.check_output(["tar", "--zstd", "-xOf", str(archive), member])
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PACKAGE_ARCHIVE_INVALID") from exc
    return hashlib.sha256(body).hexdigest()


def validate_acceptance_bundle(release_dir: Path, equivalence: Path) -> None:
    manifest = manifest_pair(release_dir)
    validator_path = release_dir / "deploy/validate_phase5_acceptance.py"
    identity = manifest.get("deployExecutionIdentity", {})
    for name in ("validate_phase5_acceptance.py", "acceptance.schema.json",
                 "machine-attestation.schema.json"):
        path = release_dir / "deploy" / name
        if not path.is_file() or sha(path) != identity.get(name):
            fail("ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH")
    if not validator_path.is_file():
        fail("ACCEPTANCE_VALIDATOR_MISSING")
    spec = importlib.util.spec_from_file_location("phase5_acceptance_release", validator_path)
    validator = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(validator)
        validator.validate_bundle(release_dir / "acceptance.json",
                                  release_dir / "release-manifest.json", equivalence)
    except Exception as exc:
        if isinstance(exc, ReleaseError):
            raise
        raise ReleaseError(str(exc) or "ACCEPTANCE_REQUIRED") from exc


def materialize_acceptance_inputs(release_dir: Path, equivalence: Path) -> Path:
    destination = release_dir / "acceptance-inputs"
    temporary = release_dir / ".acceptance-inputs.tmp"
    if destination.exists() or temporary.exists():
        fail("ACCEPTANCE_INPUTS_ALREADY_MATERIALIZED")
    production = equivalence.parent / "production-machine-attestation.json"
    evidence = production.with_suffix(".evidence")
    expected_evidence = ("machine-id", "ssh-host-ed25519.pub", "interfaces.json", "gpus.txt",
                         "cuda-driver.txt", "torch.json", "available-memory.txt",
                         "architecture.txt",
                         "vllm-normal-profile.json", "vllm-burst-profile.json")
    sources = [equivalence, production, *(evidence / name for name in expected_evidence)]
    if any(path.is_symlink() or not path.is_file() for path in sources):
        fail("EQUIVALENT_STAGING_REQUIRED")
    temporary.mkdir(mode=0o700)
    (temporary / "production-machine-attestation.evidence").mkdir(mode=0o700)
    try:
        shutil.copy2(equivalence, temporary / "staging-equivalence.json")
        shutil.copy2(production, temporary / production.name)
        for name in expected_evidence:
            shutil.copy2(evidence / name, temporary / "production-machine-attestation.evidence" / name)
        validate_acceptance_bundle(release_dir, temporary / "staging-equivalence.json")
        os.replace(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return destination / "staging-equivalence.json"


def package(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest_pair(release_dir)
    release_sha = sha(release_dir / "release-manifest.json")
    equivalence = (Path(args.equivalence).resolve() if getattr(args, "equivalence", None)
                   else release_dir.parent / "phase5-inputs/staging-equivalence.json")
    validate_acceptance_bundle(release_dir, equivalence)
    embedded_equivalence = materialize_acceptance_inputs(release_dir, equivalence)
    output = release_dir
    for name in ("release.tar.zst", "release.tar.zst.sha256", "import-release.sh",
                 "import-release.sh.sha256"):
        if (output / name).exists():
            fail("PACKAGE_OUTPUT_EXISTS")
    archive = output / "release.tar.zst"
    package_record = {"schemaVersion": 1, "status": "packaged",
                      "releaseManifestSha256": sha(release_dir / "release-manifest.json"),
                      "acceptanceSha256": sha(release_dir / "acceptance.json"),
                      "equivalenceSha256": sha(embedded_equivalence),
                      "acceptanceValidatorSha256": sha(release_dir / "deploy/validate_phase5_acceptance.py")}
    (release_dir / "package.json").write_bytes(canonical(package_record))
    temporary_archive = release_dir.parent / f".{release_dir.name}-release.tar.zst.tmp"
    if temporary_archive.exists():
        fail("PACKAGE_OUTPUT_EXISTS")
    try:
        run("tar", "--zstd", "-cf", str(temporary_archive),
            f"--exclude={release_dir.name}/run-flock-audio",
            "-C", str(release_dir.parent), release_dir.name)
        os.replace(temporary_archive, archive)
    finally:
        temporary_archive.unlink(missing_ok=True)
    checksum(archive)
    bootstrap = Path(__file__).with_name("import-release.sh")
    shutil.copy2(bootstrap, output / bootstrap.name)
    checksum(output / bootstrap.name)


def import_release(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest = manifest_pair(release_dir)
    for name in ("runtime", "audio"):
        archive = release_dir / "images" / f"{name}.oci.tar"
        digest, config = oci_manifest_digest(archive)
        if digest != manifest.get("imageIdentity", {}).get(name):
            fail("OCI_IMAGE_IDENTITY_MISMATCH")
        output = run("docker", "load", "--input", str(archive), capture=True)
        if not output:
            fail("IMAGE_IMPORT_FAILED")
        expected_config = manifest.get("localImageDiagnostics", {}).get(name, {}).get("localEngineImageId")
        tag = manifest.get("localImageDiagnostics", {}).get(name, {}).get("tag")
        loaded_config = run("docker", "image", "inspect", "--format", "{{.Id}}", tag, capture=True)
        if not expected_config or expected_config != config or loaded_config != config:
            fail("LOADED_IMAGE_CONFIG_MISMATCH")


def prepare_request(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    release_sha = sha(release_dir / "release-manifest.json")
    if args.state_policy != "reset-new-world":
        fail("CUTOVER_REQUEST_PREREQUISITE_MISSING")
    bound_record(release_dir / "acceptance.json", release_sha, "accepted",
                 "CUTOVER_REQUEST_PREREQUISITE_MISSING")
    package_record = bound_record(release_dir / "package.json", release_sha, "packaged",
                                  "CUTOVER_REQUEST_PREREQUISITE_MISSING")
    embedded_equivalence = release_dir / "acceptance-inputs/staging-equivalence.json"
    if (not embedded_equivalence.is_file()
            or not (release_dir / "deploy/validate_phase5_acceptance.py").is_file()
            or package_record.get("acceptanceSha256") != sha(release_dir / "acceptance.json")
            or package_record.get("equivalenceSha256") != sha(embedded_equivalence)
            or package_record.get("acceptanceValidatorSha256")
            != sha(release_dir / "deploy/validate_phase5_acceptance.py")):
        fail("CUTOVER_REQUEST_PREREQUISITE_MISSING")
    validate_acceptance_bundle(release_dir, embedded_equivalence)
    exact_checksum(release_dir / "release.tar.zst")
    exact_checksum(release_dir / "import-release.sh")
    archive_prefix = release_dir.name
    if (archive_member_sha(release_dir / "release.tar.zst", f"{archive_prefix}/acceptance.json")
            != package_record["acceptanceSha256"]
            or archive_member_sha(release_dir / "release.tar.zst", f"{archive_prefix}/package.json")
            != sha(release_dir / "package.json")):
        fail("PACKAGE_ARCHIVE_INVALID")
    output = Path(args.output).resolve()
    evidence = [release_dir / name for name in ("initial-world.json", "bootstrap.json",
                                                 "state-replace.json")]
    if (output != release_dir / "cutover-request.json" or output.exists()
            or any(path.exists() for path in evidence)):
        fail("CUTOVER_REQUEST_OUTPUT_EXISTS")
    manifest = manifest_pair(release_dir)
    tool = release_dir / "deploy/prepare-cutover-request.mjs"
    expected_tool = manifest.get("deployExecutionIdentity", {}).get(tool.name)
    if not expected_tool or sha(tool) != expected_tool:
        fail("DEPLOY_EXECUTION_DIGEST_MISMATCH")
    source_manifest = load_json(release_dir / "source-manifest.json", "SOURCE_MANIFEST_INVALID")
    if (canonical(source_manifest) != (release_dir / "source-manifest.json").read_bytes()
            or sha(release_dir / "source-manifest.json")
            != manifest["workerIdentity"]["sourceManifestSha256"]):
        fail("SOURCE_MANIFEST_MISMATCH")
    source_entries = {item.get("path"): item for item in source_manifest.get("entries", [])
                      if isinstance(item, dict)}
    source_root = release_dir / "source"
    for source in source_root.rglob("*"):
        if source.is_symlink():
            fail("SOURCE_MANIFEST_INVALID")
        if not source.is_file():
            if source.is_dir():
                continue
            fail("SOURCE_MANIFEST_INVALID")
        relative = source.relative_to(source_root).as_posix()
        logical = relative if relative.startswith("mvp/") else relative
        item = source_entries.get(logical)
        if not item or item.get("byteCount") != source.stat().st_size or item.get("sha256") != sha(source):
            fail("SOURCE_MANIFEST_MISMATCH")
    diagnostics = manifest["localImageDiagnostics"]["runtime"]
    if run("docker", "image", "inspect", "--format", "{{.Id}}", diagnostics["tag"],
           capture=True) != diagnostics["localEngineImageId"]:
        fail("LOADED_IMAGE_CONFIG_MISMATCH")
    run("docker", "run", "--rm", "--network", "none", "--user",
        container_user(), "--entrypoint", "node",
        "--mount", f"type=bind,src={release_dir},dst=/release",
        diagnostics["localEngineImageId"],
        "/release/deploy/prepare-cutover-request.mjs", "--release-dir", "/release",
        "--runtime-root", "/release/source/flock-voice-engine/runtime",
        "--state-policy", args.state_policy, "--output", "/release/cutover-request.json")


def rollback(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest_pair(release_dir)
    state = load_json(release_dir / "rollback-state.json", "ROLLBACK_STATE_MISSING")
    release_sha = sha(release_dir / "release-manifest.json")
    if (canonical(state) != (release_dir / "rollback-state.json").read_bytes()
            or state.get("schemaVersion") != 1 or state.get("releaseManifestSha256") != release_sha
            or state.get("kind") not in {"reset", "snapshot"}
            or state.get("previousState") not in {"absent", "running"}
            or set(state.get("previousImageIdentity", {})) != {"runtime", "audio"}
            or set(state.get("previousImages", {})) != {"runtime", "audio"}):
        fail("ROLLBACK_STATE_INVALID")
    record = state.get("stateRecord")
    if (state["kind"] == "reset" and (not isinstance(record, dict)
            or record.get("policy") != "reset-new-world")):
        fail("ROLLBACK_STATE_INVALID")
    if state["kind"] == "snapshot" and (not isinstance(record, dict)
            or not isinstance(record.get("worldGeneration"), str)):
        fail("ROLLBACK_STATE_INVALID")
    for name in ("runtime", "audio"):
        image = state["previousImages"][name]
        if (DIGEST.fullmatch(state["previousImageIdentity"][name]) is None
                or DIGEST.fullmatch(image.get("localEngineImageId", "")) is None
                or not isinstance(image.get("tag"), str)
                or run("docker", "image", "inspect", "--format", "{{.Id}}",
                       image["tag"], capture=True) != image["localEngineImageId"]):
            fail("ROLLBACK_IMAGE_MISSING")
    for container in LOCAL_CONTAINERS:
        removed = subprocess.run(["docker", "rm", "-f", container], check=False)
        if removed.returncode != 0:
            fail("ROLLBACK_CANDIDATE_REMOVE_FAILED")


def status(args) -> None:
    require_local_scope()
    run("docker", "ps", "--filter", "name=flock-runtime-candidate", "--filter", "name=flock-audio-candidate")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-local"); build.add_argument("--inputs", required=True); build.add_argument("--output", required=True); build.set_defaults(fn=build_local)
    stage = commands.add_parser("stage-local"); stage.add_argument("--release-dir", required=True); stage.set_defaults(fn=stage_local)
    for name, fn in (("verify-local", verify_local), ("verify-candidate", verify_candidate)):
        item = commands.add_parser(name); item.add_argument("--release-dir", required=True); item.add_argument("--base-url", required=True); item.set_defaults(fn=fn)
    pack = commands.add_parser("package"); pack.add_argument("--release-dir", required=True); pack.add_argument("--equivalence"); pack.set_defaults(fn=package)
    imp = commands.add_parser("import"); imp.add_argument("--release-dir", required=True); imp.set_defaults(fn=import_release)
    prep = commands.add_parser("prepare-cutover-request"); prep.add_argument("--release-dir", required=True); prep.add_argument("--state-policy", required=True); prep.add_argument("--output", required=True); prep.set_defaults(fn=prepare_request)
    rollback_p = commands.add_parser("rollback"); rollback_p.add_argument("--release-dir", required=True); rollback_p.set_defaults(fn=rollback)
    status_p = commands.add_parser("status"); status_p.set_defaults(fn=status)
    cutover = commands.add_parser("cutover"); cutover.set_defaults(fn=lambda _: fail("PRODUCTION_RELEASE_AUTHORIZATION_REQUIRED"))
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        require_release_gate_platform()
        args.fn(args)
    except ReleaseError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
