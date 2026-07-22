from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from midibrave.losses import DifferentiableCrepeObjective


@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA-only frozen CREPE gradient probe")
def test_frozen_crepe_backpropagates_only_to_audio():
    objective = DifferentiableCrepeObjective(
        44100, 128, 0.1, 25.0, 0.1,
        activation_weight=1.0, hard_negative_weight=0.25,
        autocorrelation_weight=1.0,
    ).cuda()
    time = torch.arange(8192, device="cuda", dtype=torch.float32) / 44100.0
    audio = (0.2 * torch.sin(2 * torch.pi * 440.0 * time)).view(1, 1, -1)
    audio.requires_grad_()
    frames = 8192 // 128
    components = objective.forward_group_components([(
        audio, audio.detach(), torch.tensor([69], device="cuda"),
        torch.ones(1, frames, device="cuda"),
        torch.ones(1, frames, dtype=torch.bool, device="cuda"),
    )])[0]
    loss = components["total"]
    assert set(components) == {
        "total", "cents", "distribution", "activation",
        "hard_negative", "autocorrelation",
    }
    assert all(torch.isfinite(value) for value in components.values())
    loss.backward()
    assert audio.grad is not None and torch.isfinite(audio.grad).all()
    assert audio.grad.abs().sum() > 0
    model = objective._crepe_model(torch.device("cuda"))
    assert all(not parameter.requires_grad and parameter.grad is None
               for parameter in model.parameters())


@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA-only silence gradient probe")
def test_frozen_crepe_autocorrelation_has_finite_silence_gradient():
    objective = DifferentiableCrepeObjective(
        44100, 128, 0.1, 25.0, 0.1,
        activation_weight=1.0, hard_negative_weight=0.25,
        autocorrelation_weight=1.0,
    ).cuda()
    samples = 8192
    audio = torch.zeros(1, 1, samples, device="cuda", requires_grad=True)
    frames = samples // 128
    components = objective.forward_group_components([(
        audio, audio.detach(), torch.tensor([69], device="cuda"),
        torch.full((1, frames), 0.9, device="cuda"),
        torch.ones(1, frames, dtype=torch.bool, device="cuda"),
    )])[0]
    components["total"].backward()
    assert all(torch.isfinite(value) for value in components.values())
    assert audio.grad is not None and torch.isfinite(audio.grad).all()


class _NonFiniteCrepe(torch.nn.Module):
    def forward(self, frames: torch.Tensor) -> torch.Tensor:
        base = frames.mean(dim=-1, keepdim=True)
        return base.expand(-1, 360) * float("nan")


@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA-only BCE assert regression")
def test_nonfinite_crepe_activation_is_masked_without_device_assert(monkeypatch):
    fake = _NonFiniteCrepe().cuda()
    monkeypatch.setattr(
        DifferentiableCrepeObjective, "_crepe_model",
        staticmethod(lambda device: fake.to(device)),
    )
    objective = DifferentiableCrepeObjective(
        44_100, 128, 0.1, 25.0, 0.0,
        activation_weight=1.0, hard_negative_weight=0.25,
        autocorrelation_weight=0.0,
    ).cuda()
    audio = torch.zeros(1, 1, 4096, device="cuda", requires_grad=True)
    components = objective.forward_group_components([(
        audio, torch.tensor([69], device="cuda"),
        torch.ones(1, 32, device="cuda"),
        torch.ones(1, 32, dtype=torch.bool, device="cuda"),
    )])[0]

    assert all(torch.isfinite(value) for value in components.values())
    assert all(value.item() == 0.0 for value in components.values())
    components["total"].backward()
    torch.cuda.synchronize()
    assert audio.grad is not None and torch.isfinite(audio.grad).all()
    assert audio.grad.abs().sum().item() == 0.0
