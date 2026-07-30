#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 3 ]]; then
  echo "usage: import-release.sh release.tar.zst release.tar.zst.sha256 import-release.sh.sha256" >&2
  exit 2
fi
BOOTSTRAP_PATH="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")"
exec python3 - "$BOOTSTRAP_PATH" "$1" "$2" "$3" <<'PY'
import hashlib, os, pathlib, re, stat, subprocess, sys, tarfile, tempfile

def die(code):
    print(code, file=sys.stderr); raise SystemExit(2)
def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''): h.update(chunk)
    return h.hexdigest()
def check(path, sidecar):
    try: line=pathlib.Path(sidecar).read_text('ascii')
    except OSError: die('CHECKSUM_SIDECAR_MISSING')
    expected=f"{digest(path)}  {pathlib.Path(path).name}\n"
    if line != expected: die('CHECKSUM_SIDECAR_INVALID')
def link_or_reparse(value):
    flag=getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0x400)
    return stat.S_ISLNK(value.st_mode) or bool(getattr(value,'st_file_attributes',0)&flag)
def real_directory_state(path):
    try: value=path.lstat()
    except OSError: die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
    if link_or_reparse(value) or not stat.S_ISDIR(value.st_mode):
        die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
    return (value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,
            getattr(value,'st_file_attributes',0))
def execution_parent_paths(root,nested_parent_names):
    deploy=root/'deploy'
    return (deploy,*(deploy/name for name in nested_parent_names))
def execution_snapshot(path):
    descriptor=None
    try:
        value=path.lstat()
        if link_or_reparse(value) or not stat.S_ISREG(value.st_mode):
            die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
        descriptor=os.open(
            path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)
            |getattr(os,'O_BINARY',0))
        with os.fdopen(descriptor,'rb',closefd=True) as stream:
            descriptor=None
            before=os.fstat(stream.fileno())
            body=stream.read()
            after=os.fstat(stream.fileno())
        current=path.lstat()
    except OSError: die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
    finally:
        if descriptor is not None: os.close(descriptor)
    stable=lambda item:(item.st_dev,item.st_ino,item.st_mode,item.st_size,
                        item.st_mtime_ns,getattr(item,'st_file_attributes',0))
    if (stable(before)!=stable(after) or stable(after)!=stable(current)
            or link_or_reparse(current) or not stat.S_ISREG(current.st_mode)):
        die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
    return hashlib.sha256(body).hexdigest(),body
def execution_digest(path):
    return execution_snapshot(path)[0]
def materialize_execution_snapshot(destination,bodies):
    if destination.exists() or not isinstance(bodies,dict):
        die('DEPLOY_EXECUTION_SNAPSHOT_FAILED')
    try:
        destination.mkdir(mode=0o700)
        for name,body in bodies.items():
            relative=pathlib.PurePosixPath(name)
            if (not isinstance(name,str) or not isinstance(body,bytes)
                    or relative.is_absolute() or '..' in relative.parts):
                die('DEPLOY_EXECUTION_SNAPSHOT_FAILED')
            target=destination.joinpath(*relative.parts)
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            descriptor=os.open(
                target,os.O_WRONLY|os.O_CREAT|os.O_EXCL
                |getattr(os,'O_BINARY',0),0o400)
            try:
                written=0
                while written<len(body):
                    count=os.write(descriptor,body[written:])
                    if count<=0: raise OSError('short snapshot write')
                    written+=count
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return destination
    except OSError: die('DEPLOY_EXECUTION_SNAPSHOT_FAILED')
def execute_release_snapshot(snapshot_deploy,release_root,runner=subprocess.run):
    result=runner(['bash',str(snapshot_deploy/'release.sh'),'import',
                   '--release-dir',str(release_root)])
    return result.returncode
def capture_checked_archive_snapshot(path,sidecar,destination):
    source_descriptor=None
    snapshot_descriptor=None
    try:
        sidecar_line=pathlib.Path(sidecar).read_text('ascii')
    except OSError: die('CHECKSUM_SIDECAR_MISSING')
    except UnicodeError: die('CHECKSUM_SIDECAR_INVALID')
    try:
        value=path.lstat()
        if link_or_reparse(value) or not stat.S_ISREG(value.st_mode):
            die('CHECKSUM_SIDECAR_INVALID')
        source_descriptor=os.open(
            path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)
            |getattr(os,'O_BINARY',0))
        before=os.fstat(source_descriptor)
        snapshot_descriptor=os.open(
            destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL
            |getattr(os,'O_BINARY',0),0o400)
        digest_value=hashlib.sha256()
        total=0
        while True:
            chunk=os.read(source_descriptor,1048576)
            if not chunk: break
            digest_value.update(chunk)
            total+=len(chunk)
            written=0
            while written<len(chunk):
                count=os.write(snapshot_descriptor,chunk[written:])
                if count<=0: raise OSError('short archive snapshot write')
                written+=count
        os.fsync(snapshot_descriptor)
        snapshot_state=os.fstat(snapshot_descriptor)
        after=os.fstat(source_descriptor)
        current=path.lstat()
    except OSError: die('CHECKSUM_SIDECAR_INVALID')
    finally:
        if snapshot_descriptor is not None: os.close(snapshot_descriptor)
        if source_descriptor is not None: os.close(source_descriptor)
    stable=lambda item:(item.st_dev,item.st_ino,item.st_mode,item.st_size,
                        item.st_mtime_ns,getattr(item,'st_file_attributes',0))
    expected=f"{digest_value.hexdigest()}  {path.name}\n"
    if (stable(before)!=stable(after) or stable(after)!=stable(current)
            or link_or_reparse(current) or not stat.S_ISREG(current.st_mode)
            or not stat.S_ISREG(snapshot_state.st_mode)
            or snapshot_state.st_size!=total or sidecar_line!=expected):
        die('CHECKSUM_SIDECAR_INVALID')
    return destination
def decompress_archive_snapshot(snapshot,tar_path,runner=subprocess.run):
    descriptor=None
    try:
        descriptor=os.open(
            tar_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL
            |getattr(os,'O_BINARY',0),0o600)
        with os.fdopen(descriptor,'wb',closefd=True) as output:
            descriptor=None
            result=runner(
                ['zstd','-q','-d','-c',str(snapshot)],stdout=output)
    except OSError: die('RELEASE_ARCHIVE_DECOMPRESSION_FAILED')
    finally:
        if descriptor is not None: os.close(descriptor)
    if result.returncode: die('RELEASE_ARCHIVE_DECOMPRESSION_FAILED')
    return tar_path

bootstrap, archive, archive_sidecar, bootstrap_sidecar = map(pathlib.Path, sys.argv[1:])
if (bootstrap.name, archive.name, archive_sidecar.name, bootstrap_sidecar.name) != (
    'import-release.sh','release.tar.zst','release.tar.zst.sha256','import-release.sh.sha256'):
    die('RELEASE_PAYLOAD_BASENAME_INVALID')
check(bootstrap, bootstrap_sidecar)
with tempfile.TemporaryDirectory(prefix='flock-import-') as temporary:
    tar_path=pathlib.Path(temporary)/'release.tar'
    archive_snapshot=pathlib.Path(temporary)/'release.tar.zst.snapshot'
    capture_checked_archive_snapshot(
        archive,archive_sidecar,archive_snapshot)
    decompress_archive_snapshot(archive_snapshot,tar_path)
    destination=pathlib.Path(temporary)/'unpacked'; destination.mkdir()
    try:
        with tarfile.open(tar_path,'r:') as tf:
            members=tf.getmembers()
            if len({member.name for member in members}) != len(members): die('RELEASE_ARCHIVE_UNSAFE')
            for member in members:
                parts=pathlib.PurePosixPath(member.name).parts
                if member.name.startswith('/') or '..' in parts or member.issym() or member.islnk():
                    die('RELEASE_ARCHIVE_UNSAFE')
                if not (member.isdir() or member.isfile()): die('RELEASE_ARCHIVE_UNSAFE')
            tf.extractall(destination, members=members)
    except (tarfile.TarError, OSError): die('RELEASE_ARCHIVE_INVALID')
    roots=list(destination.iterdir())
    if len(roots)!=1 or not roots[0].is_dir(): die('RELEASE_ARCHIVE_INVALID')
    root=roots[0]
    manifest=root/'release-manifest.json'; sidecar=root/'release-manifest.json.sha256'
    check(manifest, sidecar)
    import json
    try:
        manifest_bytes=manifest.read_bytes(); value=json.loads(manifest_bytes)
    except Exception: die('RELEASE_MANIFEST_INVALID')
    if json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()!=manifest_bytes:
        die('RELEASE_MANIFEST_INVALID')
    if digest(bootstrap)!=value.get('bootstrapSha256'): die('BOOTSTRAP_DIGEST_MISMATCH')
    execution=value.get('deployExecutionIdentity',{})
    names=('release.sh','release_control.py',
           'phase5_candidate_attempt.py','phase5_candidate_bootstrap.py',
           'verify-smoke.mjs','verify-candidate.sh',
           'legacy-lease.mjs','prepare-cutover-request.mjs',
           'validate_phase5_acceptance.py','acceptance.schema.json',
           'machine-attestation.schema.json',
           'phase5-fault-verifier/verify-phase5-fault-evidence.mjs',
           'phase5-fault-verifier/verify-phase5-capture-proof.mjs',
           'phase5-fault-verifier/lib/phase5-fault-evidence.mjs',
           'phase5-fault-verifier/lib/phase5-fault-validation.mjs',
           'phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs',
           'phase5-fault-verifier/lib/phase5-fault-semantics.mjs',
           'src/capture/phase5-capture-proof.js',
           'src/capture/capture-wire.js',
           'phase5-browser-preflight/flock-voice-engine/runtime/package.json',
           'phase5-browser-preflight/flock-voice-engine/runtime/package-lock.json',
           'phase5-browser-preflight/flock-voice-engine/runtime/playwright.phase5-acceptance.config.js',
           'phase5-browser-preflight/flock-voice-engine/runtime/test/e2e/phase5-local.spec.js',
           'phase5-browser-preflight/flock-voice-engine/runtime/tools/production-graph-config.mjs',
           'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/production-graph.mjs',
           'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/static-route-manifest.mjs',
           'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/candidate-browser-transport.mjs',
           'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/candidate-ops.mjs',
           'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/phase5-lease-evidence.mjs',
           'phase5-browser-preflight/flock-voice-engine/runtime/src/security/static-manifest-contract.js',
           'phase5-summary/phase5-summary.schema.json',
           'phase5-summary/soak-phase5.mjs',
           'phase5-summary/lib/candidate-ops.mjs',
           'phase5-summary/lib/phase5-client-observation-recorder.mjs',
           'phase5-summary/lib/phase5-controller-session-client.mjs',
           'phase5-summary/lib/phase5-fault-control-client.mjs',
           'phase5-summary/lib/phase5-fault-evidence.mjs',
           'phase5-summary/lib/phase5-fault-semantics.mjs',
           'phase5-summary/lib/phase5-fault-transport-projection.mjs',
           'phase5-summary/lib/phase5-latency-recorder.mjs',
           'phase5-summary/lib/phase5-lease-evidence.mjs',
           'phase5-summary/lib/phase5-raw-bundle.mjs',
           'phase5-summary/lib/phase5-raw-common.mjs',
           'phase5-summary/lib/phase5-raw-manifest.mjs',
           'phase5-summary/lib/phase5-render-recorder.mjs',
           'phase5-summary/lib/phase5-soak-clients.mjs',
           'phase5-summary/lib/phase5-soak-orchestrator.mjs',
           'phase5-summary/lib/phase5-soak-sampling.mjs',
           'phase5-summary/lib/phase5-websocket-client.mjs',
           'phase5-summary/lib/phase5-species-raw-recorder.mjs',
           'src/acceptance/phase5-fault-control-protocol.js',
           'phase5-summary/capture_machine_attestation.py',
           'phase5-summary/phase5_capture_channel_client.py')
    if not isinstance(execution,dict) or set(execution)!=set(names):
        die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
    nested_parent_names=(
        'phase5-fault-verifier',
        'phase5-fault-verifier/lib',
        'src',
        'src/acceptance',
        'src/capture',
        'phase5-browser-preflight',
        'phase5-browser-preflight/flock-voice-engine',
        'phase5-browser-preflight/flock-voice-engine/runtime',
        'phase5-browser-preflight/flock-voice-engine/runtime/src',
        'phase5-browser-preflight/flock-voice-engine/runtime/src/security',
        'phase5-browser-preflight/flock-voice-engine/runtime/test',
        'phase5-browser-preflight/flock-voice-engine/runtime/test/e2e',
        'phase5-browser-preflight/flock-voice-engine/runtime/tools',
        'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib',
        'phase5-summary',
        'phase5-summary/lib',
    )
    execution_parents=execution_parent_paths(root,nested_parent_names)
    parent_state=tuple(real_directory_state(path) for path in execution_parents)
    execution_bodies={}
    execution_digests={}
    for name in names:
        actual,body=execution_snapshot(root/'deploy'/name)
        if actual!=execution.get(name): die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
        execution_digests[name]=actual
        execution_bodies[name]=body
    if parent_state!=tuple(real_directory_state(path) for path in execution_parents):
        die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
    if execution_digests['release.sh']!=value.get('deployReleaseScriptSha256'):
        die('RELEASE_SCRIPT_DIGEST_MISMATCH')
    snapshot_deploy=materialize_execution_snapshot(
        pathlib.Path(temporary)/'execution-deploy',execution_bodies)
    os.environ['FLOCK_DEPLOY_SCOPE']='local'
    raise SystemExit(execute_release_snapshot(snapshot_deploy,root))
PY
