#!/usr/bin/env python3
"""Render only the attested Phase 5 managed status block."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path

START = "<!-- phase5-managed-status:start -->"
END = "<!-- phase5-managed-status:end -->"
PATTERN = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)


def render(path: Path, status: str, record: dict | None) -> None:
    if status != "legacy-not-cut-over" and record is None:
        raise ValueError("ATTESTED_CUTOVER_RECORD_REQUIRED")
    body = {"status": status, "production": "legacy" if status == "legacy-not-cut-over" else "phase5"}
    if record is not None:
        required = {"releaseManifestSha256", "runtimeImageDigest", "audioImageDigest"}
        if not required.issubset(record):
            raise ValueError("CUTOVER_RECORD_INVALID")
        body.update({key: record[key] for key in sorted(required)})
        body["cutoverRecordSha256"] = record["cutoverRecordSha256"]
    block = f"{START}\n```json\n{json.dumps(body, ensure_ascii=False, sort_keys=True, indent=2)}\n```\n{END}"
    original = path.read_text("utf-8")
    updated = PATTERN.sub(block, original) if PATTERN.search(original) else original.rstrip() + "\n\n" + block + "\n"
    path.write_text(updated, "utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--initial-status", choices=["legacy-not-cut-over"])
    parser.add_argument("--cutover-record", "--record", dest="cutover_record")
    parser.add_argument("--handoff", action="append", default=[])
    parser.add_argument("--deploy-doc", action="append", default=[])
    args = parser.parse_args()
    record = None
    if args.cutover_record:
        record_path = Path(args.cutover_record)
        raw = record_path.read_bytes()
        record = json.loads(raw)
        canonical = json.dumps(record, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")).encode("utf-8")
        digest = hashlib.sha256(raw).hexdigest()
        sidecar = Path(f"{record_path}.sha256")
        if raw != canonical or sidecar.read_text("ascii") != f"{digest}  {record_path.name}\n":
            raise ValueError("CUTOVER_RECORD_DIGEST_INVALID")
        for key in ("releaseManifestSha256", "runtimeImageDigest", "audioImageDigest"):
            value = record.get(key, "")
            normalized = value.removeprefix("sha256:") if key.endswith("ImageDigest") else value
            if re.fullmatch(r"[0-9a-f]{64}", normalized) is None:
                raise ValueError("CUTOVER_RECORD_INVALID")
        record["cutoverRecordSha256"] = digest
    status = args.initial_status or "cut-over"
    for item in args.handoff + args.deploy_doc:
        render(Path(item), status, record)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
