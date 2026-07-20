#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from typing import Any

import torch


def compare(left: Any, right: Any, path: str = "root",
            atol: float = 1e-7, rtol: float = 1e-6) -> tuple[int, float]:
    if isinstance(left, torch.Tensor):
        if not isinstance(right, torch.Tensor) or left.shape != right.shape or left.dtype != right.dtype:
            raise AssertionError(f"tensor contract mismatch at {path}")
        if not torch.equal(left, right):
            difference = float((left.float() - right.float()).abs().max().item())
            if (not left.is_floating_point()
                    or not torch.allclose(left, right, atol=atol, rtol=rtol)):
                raise AssertionError(f"tensor mismatch at {path}: max_abs={difference}")
            return left.numel(), difference
        return left.numel(), 0.0
    if isinstance(left, dict):
        if not isinstance(right, dict) or left.keys() != right.keys():
            raise AssertionError(f"mapping keys mismatch at {path}")
        count = 0
        maximum = 0.0
        for key in left:
            child_count, child_maximum = compare(
                left[key], right[key], f"{path}.{key}", atol, rtol)
            count += child_count
            maximum = max(maximum, child_maximum)
        return count, maximum
    if isinstance(left, (list, tuple)):
        if not isinstance(right, type(left)) or len(left) != len(right):
            raise AssertionError(f"sequence mismatch at {path}")
        count = 0
        maximum = 0.0
        for index, (left_value, right_value) in enumerate(zip(left, right)):
            child_count, child_maximum = compare(
                left_value, right_value, f"{path}[{index}]", atol, rtol
            )
            count += child_count
            maximum = max(maximum, child_maximum)
        return count, maximum
    if left != right:
        raise AssertionError(f"value mismatch at {path}: {left!r} != {right!r}")
    return 0, 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("left")
    parser.add_argument("right")
    parser.add_argument("--atol", type=float, default=1e-7)
    parser.add_argument("--rtol", type=float, default=1e-6)
    args = parser.parse_args()
    left = torch.load(args.left, map_location="cpu", weights_only=False)
    right = torch.load(args.right, map_location="cpu", weights_only=False)
    keys = ["model", "optimizer", "scaler"]
    if int(left["phase"]) == 2:
        keys.extend(("discriminator", "discriminator_optimizer"))
    tensor_values = 0
    maximum_difference = 0.0
    for key in keys:
        count, difference = compare(
            left[key], right[key], key, args.atol, args.rtol)
        tensor_values += count
        maximum_difference = max(maximum_difference, difference)
    positions = ("phase", "generator_updates", "discriminator_updates")
    for key in positions:
        if left.get(key) != right.get(key):
            raise AssertionError(f"position mismatch for {key}")
    print(json.dumps({
        "equal": True,
        "phase": int(left["phase"]),
        "generator_updates": int(left["generator_updates"]),
        "discriminator_updates": int(left.get("discriminator_updates", 0)),
        "tensor_values_compared": tensor_values,
        "maximum_absolute_difference": maximum_difference,
        "atol": args.atol,
        "rtol": args.rtol,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
