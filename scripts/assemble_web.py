"""从受跟踪源码确定性组装独立发行版静态站点。"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

RUNTIME_CONFIG = (
    "// 由 scripts/assemble_web.py 生成；只指向同源服务。\n"
    "window.LCS_RUNTIME = { stepfunBase: '/api/agent' };\n"
)


def _inside(root: Path, candidate: Path) -> bool:
    return candidate == root or root in candidate.parents


def assemble(root: Path, output: Path) -> None:
    """组装站点到 ``output``；只替换已验证位于仓库内的精确目录。"""

    root = root.resolve()
    output = output.resolve()
    if not _inside(root, output) or output == root:
        raise ValueError(f"输出目录必须位于仓库内: {output}")

    mvp = root / "mvp"
    client = root / "flock-voice-engine" / "client"
    for required in (mvp / "index.html", mvp / "src", mvp / "eval", mvp / "assets", client):
        if not required.exists():
            raise FileNotFoundError(f"缺少站点源文件: {required}")

    temporary = output.with_name(f"{output.name}.tmp")
    previous = output.with_name(f"{output.name}.previous")
    for generated in (temporary, previous):
        if generated.exists():
            shutil.rmtree(generated)

    temporary.mkdir(parents=True)
    try:
        shutil.copy2(mvp / "index.html", temporary / "index.html")
        for directory in ("src", "eval", "assets"):
            shutil.copytree(
                mvp / directory,
                temporary / directory,
                ignore=shutil.ignore_patterns("generated", "__pycache__", "*.pyc"),
            )
        shutil.copytree(
            client,
            temporary / "_client",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        (temporary / "runtime-config.js").write_text(RUNTIME_CONFIG, encoding="utf-8")

        if output.exists():
            output.replace(previous)
        temporary.replace(output)
        if previous.exists():
            shutil.rmtree(previous)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        if previous.exists() and not output.exists():
            previous.replace(output)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="组装 Intelligent Jungle 独立前端")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path("runtime/web"))
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else args.root / args.output
    assemble(args.root, output)
    print(f"前端已组装: {output.resolve()}")


if __name__ == "__main__":
    main()
