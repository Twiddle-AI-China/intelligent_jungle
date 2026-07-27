#!/usr/bin/env python3
"""用 AST 产生仓库内 Python 静态 import closure。"""
from __future__ import annotations

import ast
from pathlib import Path


class ImportGraphError(RuntimeError):
    pass


def _module_path(repo_root: Path, module: str) -> Path | None:
    candidate = repo_root / (module.replace(".", "/") + ".py")
    if candidate.is_file():
        return candidate
    package = repo_root / module.replace(".", "/") / "__init__.py"
    return package if package.is_file() else None


def python_import_graph(entry: str | Path, repo_root: str | Path | None = None) -> set[str]:
    entry_path = Path(entry).resolve()
    root = Path(repo_root).resolve() if repo_root else entry_path.parents[2]
    pending = [entry_path]
    visited: set[Path] = set()
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        tree = ast.parse(path.read_text("utf-8"), filename=str(path))
        relative = path.relative_to(root).with_suffix("")
        package_parts = list(relative.parts[:-1])
        if path.name == "__init__.py":
            package_parts = list(relative.parts[:-1])
        for node in ast.walk(tree):
            modules: list[str] = []
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    if node.level > len(package_parts) + 1:
                        raise ImportGraphError("UNRESOLVED_RELATIVE_IMPORT")
                    base = package_parts[:len(package_parts) - node.level + 1]
                    if node.module:
                        base.extend(node.module.split("."))
                    modules = [".".join(base)]
                elif node.module:
                    modules = [node.module]
            for module in modules:
                resolved = _module_path(root, module)
                if resolved is not None:
                    pending.append(resolved.resolve())
    return {path.relative_to(root).as_posix() for path in visited}
