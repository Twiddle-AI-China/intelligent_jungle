from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable


@dataclass(frozen=True)
class Mapping:
    label: str
    production: str
    repository: str
    kind: str = "tree"


class UnsafeManifestPathError(RuntimeError):
    """候选文件通过 link/reparse point 逃出可信根，必须在读取前终止。"""


def _is_link_or_reparse(file_stat: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    attributes = getattr(file_stat, "st_file_attributes", 0)
    return stat.S_ISLNK(file_stat.st_mode) or bool(attributes & reparse_flag)


def validate_trusted_root(root: Path) -> Path:
    """拒绝 root 自身的 link/reparse，并返回未跟随链接的绝对根。"""
    lexical_root = Path(os.path.abspath(root))
    try:
        root_stat = lexical_root.lstat()
    except OSError as error:
        raise UnsafeManifestPathError(f"trusted root cannot be inspected: {root}") from error
    if _is_link_or_reparse(root_stat):
        raise UnsafeManifestPathError(f"trusted root is a link/reparse point: {root}")
    if not stat.S_ISDIR(root_stat.st_mode):
        raise UnsafeManifestPathError(f"trusted root is not a directory: {root}")
    return lexical_root


def read_file_bytes(path: Path, root: Path) -> bytes:
    """验证整条路径链后读取；这是 manifest 内容读取的唯一入口。"""
    lexical_root = validate_trusted_root(root)
    lexical_path = Path(os.path.abspath(path))
    try:
        relative = lexical_path.relative_to(lexical_root)
    except ValueError as error:
        raise UnsafeManifestPathError(f"path is outside lexical root: {path}") from error

    cursor = lexical_root
    final_stat = None
    for component in relative.parts:
        cursor = cursor / component
        try:
            final_stat = cursor.lstat()
        except OSError as error:
            raise UnsafeManifestPathError(f"manifest path cannot be inspected: {path}") from error
        if _is_link_or_reparse(final_stat):
            raise UnsafeManifestPathError(f"link/reparse point is forbidden: {cursor}")

    try:
        resolved_root = lexical_root.resolve(strict=True)
        resolved_path = lexical_path.resolve(strict=True)
        resolved_path.relative_to(resolved_root)
    except ValueError as error:
        raise UnsafeManifestPathError(f"resolved path escapes root: {path}") from error
    except OSError as error:
        raise UnsafeManifestPathError(f"manifest path cannot be resolved: {path}") from error
    if final_stat is None or not stat.S_ISREG(final_stat.st_mode):
        raise UnsafeManifestPathError(f"manifest input is not a regular file: {path}")
    return lexical_path.read_bytes()


MAPPINGS = (
    Mapping("mvp-src", "web/src", "mvp/src"),
    Mapping("mvp-index", "web/index.html", "mvp/index.html", "file"),
    Mapping("mvp-runtime-example", "web/runtime-config.example.js", "mvp/runtime-config.example.js", "file"),
    Mapping("mvp-readme", "web/README.md", "mvp/README.md", "file"),
    Mapping("mvp-assets", "web/assets", "mvp/assets"),
    Mapping("mvp-eval", "web/eval", "mvp/eval"),
    Mapping("mvp-tests", "web/test", "mvp/test"),
    Mapping("mvp-tools", "web/tools", "mvp/tools"),
    Mapping("served-timbre-assets", "web/assets/timbre", "flock-voice-engine/assets/timbre"),
    Mapping("active-legacy-client", "web/_client", "flock-voice-engine/client"),
    Mapping("engine-gitignore", ".gitignore", "flock-voice-engine/.gitignore", "file"),
    Mapping("engine-server", "server", "flock-voice-engine/server"),
    Mapping("engine-deploy", "deploy", "flock-voice-engine/deploy"),
    Mapping("engine-docs", "docs", "flock-voice-engine/docs"),
    Mapping("engine-tools", "tools", "flock-voice-engine/tools"),
    Mapping("engine-assets", "assets", "flock-voice-engine/assets"),
    Mapping("engine-brief", "BRIEF.md", "flock-voice-engine/BRIEF.md", "file"),
    Mapping("engine-readme", "README.md", "flock-voice-engine/README.md", "file"),
)


EXCLUDE_RULES = (
    ("runtime-config.js", "部署配置/可能含凭证"),
    ("deploy/sync.sh", "已废弃且含明文凭证的脚本；绝不读取或 hash"),
    ("docs/deploy.md", "历史部署文档含凭证形态文本；从审计输入和 hash 中精确排除"),
    ("docs/HANDOFF.md", "历史交接文档含凭证形态文本；从审计输入和 hash 中精确排除"),
    ("docs/model-notes.md", "历史模型说明含凭证形态文本；从审计输入和 hash 中精确排除"),
    (".env", "环境凭证文件"),
    (".env.", "环境凭证文件变体"),
    (".pem", "私钥/证书材料"),
    (".key", "私钥材料"),
    (".ckpt", "模型权重文件"),
    (".safetensors", "模型权重文件"),
    ("checkpoint", "模型 checkpoint/权重目录"),
    ("__pycache__", "生成缓存"),
    (".pyc", "生成缓存"),
    ("._", "AppleDouble"),
    (".npy", "生成的数值资产"),
    (".bak", "符合精确备份命名规则的文件或目录"),
    ("staging", "临时产物"),
    ("vendor", "外部依赖"),
    (".venv", "虚拟环境"),
)


IGNORED_TREES = {"client": "未被当前容器提供的旧混合副本"}

TEXT_SUFFIXES = frozenset(
    {".py", ".js", ".mjs", ".html", ".css", ".md", ".json", ".sh", ".txt", ".service", ".svg", ".xml"}
)
TEXT_NAMES = frozenset({".gitignore", "Dockerfile", "LICENSE"})

_RULE_REASONS = dict(EXCLUDE_RULES)
_EXACT_EXCLUDED_PATHS = {
    "web/runtime-config.js": _RULE_REASONS["runtime-config.js"],
    "deploy/sync.sh": _RULE_REASONS["deploy/sync.sh"],
    "docs/deploy.md": _RULE_REASONS["docs/deploy.md"],
    "docs/HANDOFF.md": _RULE_REASONS["docs/HANDOFF.md"],
    "docs/model-notes.md": _RULE_REASONS["docs/model-notes.md"],
}
_BACKUP_TIMESTAMP = re.compile(r"\.bak[_.]\d{8}_?\d{6}$")


def _join_relative(root: Path, relative: str) -> Path:
    return root.joinpath(*PurePosixPath(relative).parts)


def _collect_regular_files(root: Path) -> dict[str, Path]:
    """仅通过 lstat 遍历可信根；遇到链接、reparse 或特殊文件立即终止。"""
    files: dict[str, Path] = {}
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            current_stat = current.lstat()
        except OSError as error:
            raise UnsafeManifestPathError(f"manifest path cannot be inspected: {current}") from error
        if _is_link_or_reparse(current_stat):
            raise UnsafeManifestPathError(f"link/reparse point is forbidden: {current}")
        if stat.S_ISDIR(current_stat.st_mode):
            try:
                children = sorted(current.iterdir(), key=lambda item: item.name, reverse=True)
            except OSError as error:
                raise UnsafeManifestPathError(f"manifest directory cannot be traversed: {current}") from error
            pending.extend(children)
            continue
        if not stat.S_ISREG(current_stat.st_mode):
            raise UnsafeManifestPathError(f"manifest path is not a regular file or directory: {current}")
        relative = current.relative_to(root).as_posix()
        files[relative] = current
    return files


def _validate_mapping_endpoint(root: Path, relative: str, kind: str) -> None:
    candidate = _join_relative(root, relative)
    try:
        candidate_stat = candidate.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise UnsafeManifestPathError(f"mapping endpoint cannot be inspected: {relative}") from error
    if _is_link_or_reparse(candidate_stat):
        raise UnsafeManifestPathError(f"mapping endpoint is a link/reparse point: {relative}")
    expected = stat.S_ISREG(candidate_stat.st_mode) if kind == "file" else stat.S_ISDIR(candidate_stat.st_mode)
    if not expected:
        raise UnsafeManifestPathError(f"mapping endpoint has the wrong kind: {relative}")


def _mapping_members(files: dict[str, Path], relative: str, kind: str) -> dict[str, Path]:
    if kind == "file":
        return {"": files[relative]} if relative in files else {}
    prefix = relative + "/"
    return {
        path[len(prefix) :]: candidate
        for path, candidate in files.items()
        if path.startswith(prefix)
    }


def _mapped_path(root: str, suffix: str) -> str:
    return root if not suffix else f"{root}/{suffix}"


def _skip_mapping_member(mapping: Mapping, suffix: str) -> bool:
    return mapping.label == "mvp-assets" and (suffix == "timbre" or suffix.startswith("timbre/"))


def _backup_component(component: str) -> bool:
    return component.endswith(".bak") or _BACKUP_TIMESTAMP.search(component) is not None


def _exclusion_reason(production_path: str) -> str | None:
    exact_reason = _EXACT_EXCLUDED_PATHS.get(production_path)
    if exact_reason is not None:
        return exact_reason

    parts = PurePosixPath(production_path).parts
    if not parts:
        return None
    basename = parts[-1]
    lower_basename = basename.lower()

    if basename == ".env":
        return _RULE_REASONS[".env"]
    if basename.startswith(".env."):
        return _RULE_REASONS[".env."]
    for suffix in (".pem", ".key", ".ckpt", ".safetensors"):
        if lower_basename.endswith(suffix):
            return _RULE_REASONS[suffix]
    if "checkpoint" in parts:
        return _RULE_REASONS["checkpoint"]
    if "__pycache__" in parts:
        return _RULE_REASONS["__pycache__"]
    if lower_basename.endswith(".pyc"):
        return _RULE_REASONS[".pyc"]
    if basename.startswith("._"):
        return _RULE_REASONS["._"]
    if lower_basename.endswith(".npy"):
        return _RULE_REASONS[".npy"]
    if any(_backup_component(component) for component in parts):
        return _RULE_REASONS[".bak"]
    for directory in ("staging", "vendor", ".venv"):
        if directory in parts:
            return _RULE_REASONS[directory]
    return None


def _ignored_tree_reason(production_path: str) -> str | None:
    parts = PurePosixPath(production_path).parts
    if not parts:
        return None
    return IGNORED_TREES.get(parts[0])


def _hash_manifest_file(path: Path, root: Path, relative: str) -> str:
    content = read_file_bytes(path, root)
    relative_path = PurePosixPath(relative)
    if relative_path.suffix.lower() in TEXT_SUFFIXES or relative_path.name in TEXT_NAMES:
        content = content.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return hashlib.sha256(content).hexdigest()


def _decision_table(decisions: dict[str, object]) -> dict[str, object]:
    raw = decisions.get("decisions", {})
    if not isinstance(raw, dict):
        raise ValueError("decisions.decisions must be an object")
    return raw


def _default_disposition(status: str) -> str:
    if status == "same":
        return "matched"
    if status == "repository-only":
        return "retain-repository"
    return "unreviewed"


def _record_excluded(
    records: dict[tuple[str, str], dict[str, str]],
    production_path: str,
    reason: str,
) -> None:
    records[(production_path, reason)] = {
        "productionPath": production_path,
        "reason": reason,
    }


def _status_for(production_sha: str | None, repository_sha: str | None) -> str:
    if production_sha is None:
        return "repository-only"
    if repository_sha is None:
        return "production-only"
    return "same" if production_sha == repository_sha else "changed"


def _mapping_json(mapping: Mapping) -> dict[str, str]:
    return {
        "label": mapping.label,
        "production": mapping.production,
        "repository": mapping.repository,
        "kind": mapping.kind,
    }


def build_manifest(
    snapshot_root: Path,
    repository_root: Path,
    metadata: dict[str, object],
    decisions: dict[str, object],
) -> dict[str, object]:
    """返回稳定排序、可 JSON 序列化的生产差异 manifest。"""
    snapshot_root = validate_trusted_root(snapshot_root)
    repository_root = validate_trusted_root(repository_root)

    snapshot_files = _collect_regular_files(snapshot_root)
    repository_files = _collect_regular_files(repository_root)
    decision_table = _decision_table(decisions)
    used_decisions: set[str] = set()
    excluded_records: dict[tuple[str, str], dict[str, str]] = {}
    snapshot_exclusions: dict[str, str] = {}
    production_claims: dict[str, list[str]] = {}
    entries: list[dict[str, object]] = []

    for production_path in sorted(snapshot_files):
        reason = _ignored_tree_reason(production_path) or _exclusion_reason(production_path)
        if reason is None:
            continue
        snapshot_exclusions[production_path] = reason
        _record_excluded(excluded_records, production_path, reason)

    # runtime-config.js 不属于任一 canonical mapping，但 repository-only 也必须显式排除。
    if "mvp/runtime-config.js" in repository_files:
        _record_excluded(
            excluded_records,
            "web/runtime-config.js",
            _RULE_REASONS["runtime-config.js"],
        )

    for mapping in MAPPINGS:
        _validate_mapping_endpoint(snapshot_root, mapping.production, mapping.kind)
        _validate_mapping_endpoint(repository_root, mapping.repository, mapping.kind)
        production_members = _mapping_members(snapshot_files, mapping.production, mapping.kind)
        repository_members = _mapping_members(repository_files, mapping.repository, mapping.kind)

        for suffix in sorted(set(production_members) | set(repository_members)):
            if _skip_mapping_member(mapping, suffix):
                continue
            production_path = _mapped_path(mapping.production, suffix)
            repository_path = _mapped_path(mapping.repository, suffix)
            production_file = production_members.get(suffix)
            repository_file = repository_members.get(suffix)

            reason = (
                snapshot_exclusions.get(production_path)
                or _ignored_tree_reason(production_path)
                or _exclusion_reason(production_path)
            )
            if reason is not None:
                _record_excluded(excluded_records, production_path, reason)
                continue

            if production_file is not None:
                production_claims.setdefault(production_path, []).append(mapping.label)
            production_sha = (
                _hash_manifest_file(production_file, snapshot_root, production_path)
                if production_file is not None
                else None
            )
            repository_sha = (
                _hash_manifest_file(repository_file, repository_root, repository_path)
                if repository_file is not None
                else None
            )
            status = _status_for(production_sha, repository_sha)
            decision_key = f"{mapping.label}:{status}:{repository_path}"
            decision = decision_table.get(decision_key)
            disposition = _default_disposition(status)
            reason_text = None
            if decision_key in decision_table:
                used_decisions.add(decision_key)
                if isinstance(decision, dict):
                    candidate_disposition = decision.get("disposition")
                    if isinstance(candidate_disposition, str) and candidate_disposition:
                        disposition = candidate_disposition
                    candidate_reason = decision.get("reason")
                    if isinstance(candidate_reason, str):
                        reason_text = candidate_reason

            entry: dict[str, object] = {
                "mapping": mapping.label,
                "productionPath": production_path,
                "repositoryPath": repository_path,
                "productionSha256": production_sha,
                "repositorySha256": repository_sha,
                "status": status,
                "disposition": disposition,
            }
            if reason_text is not None:
                entry["reason"] = reason_text
            entries.append(entry)

    unmapped: list[dict[str, str]] = []
    for production_path in sorted(snapshot_files):
        if production_path in snapshot_exclusions:
            continue
        claims = production_claims.get(production_path, [])
        if not claims:
            unmapped.append({"productionPath": production_path})
        elif len(claims) > 1:
            labels = ", ".join(sorted(claims))
            unmapped.append(
                {
                    "productionPath": production_path,
                    "reason": f"mapping overlap: {labels}",
                }
            )

    entries.sort(
        key=lambda item: (
            str(item["mapping"]),
            str(item["repositoryPath"]),
            str(item["productionPath"]),
        )
    )
    excluded = sorted(
        excluded_records.values(),
        key=lambda item: (item["productionPath"], item["reason"]),
    )
    unmapped.sort(key=lambda item: item["productionPath"])
    unused_decisions = sorted(set(decision_table) - used_decisions)

    summary = {
        "same": sum(entry["status"] == "same" for entry in entries),
        "changed": sum(entry["status"] == "changed" for entry in entries),
        "productionOnly": sum(entry["status"] == "production-only" for entry in entries),
        "repositoryOnly": sum(entry["status"] == "repository-only" for entry in entries),
        "excluded": len(excluded),
        "unmapped": len(unmapped),
        "unusedDecisions": len(unused_decisions),
        "unreviewed": (
            sum(entry["disposition"] == "unreviewed" for entry in entries)
            + len(unmapped)
            + len(unused_decisions)
        ),
    }

    return {
        "schemaVersion": 1,
        "metadata": copy.deepcopy(metadata),
        "mappings": [_mapping_json(mapping) for mapping in MAPPINGS],
        "summary": summary,
        "entries": entries,
        "excluded": excluded,
        "unmapped": unmapped,
        "unusedDecisions": unused_decisions,
    }


def write_manifest(manifest: dict[str, object], output: Path) -> None:
    """UTF-8、indent=2、sort_keys=True，并以换行结尾原子写入。"""
    payload = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_bytes(payload.encode("utf-8"))
    temporary.replace(output)


def _read_json_object(path: Path, label: str) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain a JSON object")
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="构建生产快照差异 manifest")
    parser.add_argument("--snapshot-root", required=True, type=Path)
    parser.add_argument("--repository-root", required=True, type=Path)
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument("--decisions", type=Path, default=None)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fail-unreviewed", action="store_true")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    metadata = _read_json_object(args.metadata, "metadata")
    decisions = (
        _read_json_object(args.decisions, "decisions")
        if args.decisions is not None
        else {"decisions": {}}
    )
    manifest = build_manifest(
        args.snapshot_root,
        args.repository_root,
        metadata,
        decisions,
    )
    write_manifest(manifest, args.output)
    if args.fail_unreviewed and manifest["summary"]["unreviewed"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
