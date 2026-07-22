"""安装和校验 GitHub Release 中的神经音源权重。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class AssetError(RuntimeError):
    """模型制品操作失败。"""


class AssetManifestError(AssetError):
    """制品清单无效。"""


class AssetDownloadError(AssetError):
    """curl 下载失败。"""


class AssetVerificationError(AssetError):
    """文件大小或 SHA-256 不匹配。"""


@dataclass(frozen=True)
class AssetSpec:
    filename: str
    bytes: int
    sha256: str


@dataclass(frozen=True)
class AssetManifest:
    base_url: str
    assets: tuple[AssetSpec, ...]


def _load_manifest(path: Path) -> AssetManifest:
    try:
        payload: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AssetManifestError(f"无法读取制品清单: {error.__class__.__name__}") from error
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise AssetManifestError("制品清单 version 必须为 1")
    base_url = payload.get("baseUrl")
    raw_assets = payload.get("assets")
    if not isinstance(base_url, str) or not base_url.startswith(("http://", "https://")):
        raise AssetManifestError("baseUrl 必须是 http/https URL")
    if not isinstance(raw_assets, list) or not raw_assets:
        raise AssetManifestError("assets 必须是非空数组")

    assets: list[AssetSpec] = []
    names: set[str] = set()
    for raw in raw_assets:
        if not isinstance(raw, dict) or set(raw) != {"filename", "bytes", "sha256"}:
            raise AssetManifestError("每个 asset 必须只有 filename/bytes/sha256")
        filename = raw["filename"]
        byte_count = raw["bytes"]
        sha256 = raw["sha256"]
        if (
            not isinstance(filename, str)
            or Path(filename).name != filename
            or "/" in filename
            or "\\" in filename
        ):
            raise AssetManifestError(f"非法制品文件名: {filename!r}")
        if filename in names:
            raise AssetManifestError(f"重复制品文件名: {filename}")
        if isinstance(byte_count, bool) or not isinstance(byte_count, int) or byte_count <= 0:
            raise AssetManifestError(f"{filename} 的 bytes 无效")
        if (
            not isinstance(sha256, str)
            or len(sha256) != 64
            or any(char not in "0123456789abcdef" for char in sha256)
        ):
            raise AssetManifestError(f"{filename} 的 SHA-256 无效")
        names.add(filename)
        assets.append(AssetSpec(filename, byte_count, sha256))
    return AssetManifest(base_url.rstrip("/"), tuple(assets))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_one(path: Path, asset: AssetSpec) -> None:
    if not path.is_file():
        raise AssetVerificationError(f"缺少 {asset.filename}")
    actual_size = path.stat().st_size
    if actual_size != asset.bytes:
        raise AssetVerificationError(
            f"{asset.filename} 字节数不符: {actual_size} != {asset.bytes}"
        )
    actual_hash = _sha256(path)
    if actual_hash != asset.sha256:
        raise AssetVerificationError(
            f"{asset.filename} SHA-256 不符: {actual_hash} != {asset.sha256}"
        )


def verify_assets(manifest_path: Path, output_dir: Path) -> list[Path]:
    manifest = _load_manifest(Path(manifest_path))
    output = Path(output_dir)
    verified: list[Path] = []
    for asset in manifest.assets:
        path = output / asset.filename
        _verify_one(path, asset)
        verified.append(path)
    return verified


def _curl_command(part: Path, url: str) -> list[str]:
    return [
        "curl",
        "-fL",
        "-C",
        "-",
        "--retry",
        "5",
        "--retry-delay",
        "2",
        "--output",
        str(part),
        url,
    ]


def install_assets(
    manifest_path: Path,
    output_dir: Path,
    base_url: str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
) -> list[Path]:
    manifest = _load_manifest(Path(manifest_path))
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    selected_base = (
        base_url
        or os.environ.get("LCS_MODEL_RELEASE_BASE_URL")
        or manifest.base_url
    ).rstrip("/")
    if not selected_base.startswith(("http://", "https://")):
        raise AssetManifestError("下载 base URL 必须是 http/https URL")

    installed: list[Path] = []
    for asset in manifest.assets:
        final = output / asset.filename
        part = output / f"{asset.filename}.part"
        try:
            _verify_one(final, asset)
        except AssetVerificationError:
            if final.exists():
                final.unlink()
        else:
            installed.append(final)
            continue

        command = _curl_command(part, f"{selected_base}/{asset.filename}")
        try:
            runner(command, check=True)
        except subprocess.CalledProcessError as error:
            if error.returncode != 33:
                raise AssetDownloadError(
                    f"下载 {asset.filename} 失败，curl 退出码 {error.returncode}"
                ) from error
            if part.exists():
                part.unlink()
            try:
                runner(command, check=True)
            except subprocess.CalledProcessError as retry_error:
                raise AssetDownloadError(
                    f"重新下载 {asset.filename} 失败，curl 退出码 {retry_error.returncode}"
                ) from retry_error

        try:
            _verify_one(part, asset)
        except AssetVerificationError:
            if part.exists():
                part.unlink()
            raise
        os.replace(part, final)
        installed.append(final)

    return verify_assets(Path(manifest_path), output)


def main() -> int:
    parser = argparse.ArgumentParser(description="安装/校验 Intelligent Jungle 神经音源权重")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("install", "verify"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--manifest", type=Path, required=True)
        subparser.add_argument("--output", type=Path, required=True)
        if command == "install":
            subparser.add_argument("--base-url")
    args = parser.parse_args()
    try:
        if args.command == "install":
            paths = install_assets(args.manifest, args.output, args.base_url)
        else:
            paths = verify_assets(args.manifest, args.output)
    except AssetError as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2
    for path in paths:
        print(f"OK {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
