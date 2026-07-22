"""把 checkpoint 里的 timbre.net（6 个张量）导成 npz。

给 tools/build_latent_map.py 用 —— 那个脚本要在 Octopus 上跑（CLAP 缓存在那），
但 Octopus 既没装 torch 也没有本工程树。搬 6 个小张量过去，比把 438 MB 的
CLAP 缓存拉回 Spark 划算。
"""
from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

if __package__:
    from .project_paths import TIMBRE_WEIGHTS
else:
    from project_paths import TIMBRE_WEIGHTS

DEFAULT_CHECKPOINT = Path(
    "/data/model_weights/midiBrave/"
    "midibrave-full-c9-phase1-step-000075365.pt"
)


class _DumpArgumentParser(argparse.ArgumentParser):
    def parse_args(self, args=None, namespace=None):
        parsed = super().parse_args(args, namespace)
        legacy_out = parsed._legacy_out
        flag_out = parsed._flag_out
        if legacy_out is not None and flag_out is not None:
            self.error("位置参数 OUT 与 --out 不能同时使用")
        parsed.out = (
            flag_out
            if flag_out is not None
            else legacy_out if legacy_out is not None else TIMBRE_WEIGHTS
        )
        del parsed._legacy_out
        del parsed._flag_out
        return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = _DumpArgumentParser()
    parser.add_argument(
        "checkpoint",
        nargs="?",
        type=Path,
        default=DEFAULT_CHECKPOINT,
        metavar="CHECKPOINT",
    )
    parser.add_argument("_legacy_out", nargs="?", type=Path, metavar="OUT")
    parser.add_argument("--out", dest="_flag_out", type=Path, metavar="OUT")
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int | None:
    args = parse_args(argv)

    import numpy as np
    import torch

    state = torch.load(
        args.checkpoint, map_location="cpu", weights_only=False
    )["model"]
    g = lambda k: state[f"timbre.net.{k}"].numpy()
    np.savez(args.out,
             ln_weight=g("0.weight"), ln_bias=g("0.bias"),
             fc1_weight=g("1.weight"), fc1_bias=g("1.bias"),
             fc2_weight=g("3.weight"), fc2_bias=g("3.bias"))
    print("已写", args.out, {k: v.shape for k, v in np.load(args.out).items()})


if __name__ == "__main__":
    raise SystemExit(main())
