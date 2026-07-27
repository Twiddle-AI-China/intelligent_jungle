#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 3 ]]; then
  echo "usage: import-release.sh release.tar.zst release.tar.zst.sha256 import-release.sh.sha256" >&2
  exit 2
fi
BOOTSTRAP_PATH="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")"
exec python3 - "$BOOTSTRAP_PATH" "$1" "$2" "$3" <<'PY'
import hashlib, os, pathlib, re, subprocess, sys, tarfile, tempfile

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

bootstrap, archive, archive_sidecar, bootstrap_sidecar = map(pathlib.Path, sys.argv[1:])
if (bootstrap.name, archive.name, archive_sidecar.name, bootstrap_sidecar.name) != (
    'import-release.sh','release.tar.zst','release.tar.zst.sha256','import-release.sh.sha256'):
    die('RELEASE_PAYLOAD_BASENAME_INVALID')
check(bootstrap, bootstrap_sidecar); check(archive, archive_sidecar)
with tempfile.TemporaryDirectory(prefix='flock-import-') as temporary:
    tar_path=pathlib.Path(temporary)/'release.tar'
    with tar_path.open('wb') as output:
        result=subprocess.run(['zstd','-q','-d','-c',str(archive)],stdout=output)
    if result.returncode: die('RELEASE_ARCHIVE_DECOMPRESSION_FAILED')
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
    release_script=root/'deploy/release.sh'
    if digest(release_script)!=value.get('deployReleaseScriptSha256'): die('RELEASE_SCRIPT_DIGEST_MISMATCH')
    if digest(bootstrap)!=value.get('bootstrapSha256'): die('BOOTSTRAP_DIGEST_MISMATCH')
    execution=value.get('deployExecutionIdentity',{})
    for name in ('release.sh','release_control.py','verify-smoke.mjs','verify-candidate.sh',
                 'prepare-cutover-request.mjs'):
        if digest(root/'deploy'/name)!=execution.get(name): die('DEPLOY_EXECUTION_DIGEST_MISMATCH')
    os.environ['FLOCK_DEPLOY_SCOPE']='local'
    raise SystemExit(subprocess.run(['bash',str(release_script),'import','--release-dir',str(root)]).returncode)
PY
