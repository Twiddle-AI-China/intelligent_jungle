#!/usr/bin/env python3
from __future__ import annotations

import json
import os

import torch
import torch.distributed as dist
from torch import nn

from midibrave.trainer import _global_all_true


def flatten(*modules: nn.Module) -> torch.Tensor:
    return torch.cat([parameter.detach().flatten() for module in modules
                      for parameter in module.parameters()])


def main() -> None:
    dist.init_process_group("nccl")
    rank = dist.get_rank()
    local_rank = int(os.environ["LOCAL_RANK"])
    torch.cuda.set_device(local_rank)
    device = torch.device("cuda", local_rank)
    torch.manual_seed(11)
    generator = nn.Linear(4, 3).to(device)
    discriminator = nn.Linear(3, 1).to(device)
    generator_optimizer = torch.optim.AdamW(generator.parameters(), lr=1e-3)
    discriminator_optimizer = torch.optim.AdamW(discriminator.parameters(), lr=1e-3)
    scaler = torch.amp.GradScaler("cuda", init_scale=2.0, growth_interval=1000)
    inputs = torch.arange(8, device=device, dtype=torch.float32).reshape(2, 4) / 8.0

    before = flatten(generator, discriminator).clone()
    with torch.autocast("cuda", dtype=torch.float16):
        hidden = generator(inputs)
        loss = hidden.square().mean() + discriminator(hidden).square().mean()
    scaler.scale(loss).backward()
    if rank == 0:
        next(generator.parameters()).grad.fill_(float("inf"))
    scaler.unscale_(generator_optimizer)
    scaler.unscale_(discriminator_optimizer)
    generator_norm = torch.nn.utils.clip_grad_norm_(generator.parameters(), 1.0)
    discriminator_norm = torch.nn.utils.clip_grad_norm_(discriminator.parameters(), 1.0)
    local_finite = bool(torch.isfinite(generator_norm) & torch.isfinite(discriminator_norm))
    applied = _global_all_true(local_finite, device)
    if applied:
        raise AssertionError("rank-local overflow did not become a global skip")
    scaler.update(new_scale=1.0)
    generator_optimizer.zero_grad(set_to_none=True)
    discriminator_optimizer.zero_grad(set_to_none=True)
    if not torch.equal(flatten(generator, discriminator), before):
        raise AssertionError("an optimizer changed parameters during the atomic skip")

    with torch.autocast("cuda", dtype=torch.float16):
        hidden = generator(inputs)
        loss = hidden.square().mean() + discriminator(hidden).square().mean()
    scaler.scale(loss).backward()
    scaler.unscale_(generator_optimizer)
    scaler.unscale_(discriminator_optimizer)
    generator_norm = torch.nn.utils.clip_grad_norm_(generator.parameters(), 1.0)
    discriminator_norm = torch.nn.utils.clip_grad_norm_(discriminator.parameters(), 1.0)
    local_finite = bool(torch.isfinite(generator_norm) & torch.isfinite(discriminator_norm))
    applied = _global_all_true(local_finite, device)
    if not applied:
        raise AssertionError("finite update was incorrectly skipped")
    scaler.step(generator_optimizer)
    scaler.step(discriminator_optimizer)
    scaler.update()
    after = flatten(generator, discriminator)
    if torch.equal(after, before):
        raise AssertionError("finite atomic update did not change parameters")
    gathered = [torch.empty_like(after) for _ in range(dist.get_world_size())]
    dist.all_gather(gathered, after)
    if not all(torch.equal(gathered[0], value) for value in gathered[1:]):
        raise AssertionError("ranks diverged after the finite update")
    if rank == 0:
        print(json.dumps({
            "global_overflow_skip": True,
            "finite_atomic_update": True,
            "world_size": dist.get_world_size(),
            "scale_after_skip": 1.0,
        }, sort_keys=True))
    dist.destroy_process_group()


if __name__ == "__main__":
    main()
