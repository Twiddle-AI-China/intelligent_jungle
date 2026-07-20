from __future__ import annotations

import random
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from midibrave.trainer import (_restore_rng, _split_discriminator_batch,
                               load_checkpoint, save_checkpoint)


class TinyDiscriminator(nn.Linear):
    architecture_id = "tiny_discriminator_v1"


class DifferentTinyDiscriminator(nn.Linear):
    architecture_id = "tiny_discriminator_v2"


class ToyPitchModel(nn.Module):
    def __init__(self, classes: int):
        super().__init__()
        self.stem = nn.Linear(4, 4)
        self.pitch_adversary = nn.Module()
        self.pitch_adversary.net = nn.Sequential(nn.Linear(4, 4), nn.ReLU(), nn.Linear(4, classes))


def test_split_discriminator_batch_preserves_scores_and_features():
    output = [
        (torch.arange(12).reshape(4, 3), [torch.arange(20).reshape(4, 5)]),
        (torch.arange(8).reshape(4, 2), [torch.arange(16).reshape(4, 4)]),
    ]
    first, second = _split_discriminator_batch(output, 2)
    assert all(item[0].shape[0] == 2 for item in first + second)
    assert torch.equal(torch.cat((first[0][0], second[0][0])), output[0][0])
    assert torch.equal(torch.cat((first[1][1][0], second[1][1][0])), output[1][1][0])


def test_checkpoint_restores_model_optimizer_position_and_rng(tmp_path: Path):
    torch.manual_seed(17)
    np.random.seed(17)
    random.seed(17)
    model = nn.Linear(4, 3)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    loss = model(torch.randn(2, 4)).square().mean()
    loss.backward()
    optimizer.step()
    optimizer.zero_grad(set_to_none=True)
    expected = {name: value.detach().clone() for name, value in model.state_dict().items()}
    checkpoint = tmp_path / "resume.pt"
    save_checkpoint(checkpoint, 1, 6, model, optimizer, scaler, 2, 11, "manifest")
    expected_torch = torch.rand(3)
    expected_numpy = np.random.rand(3)
    expected_python = [random.random() for _ in range(3)]
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.zero_()
    loop, updates, discriminator_updates, epoch, offset, rng = load_checkpoint(
        str(checkpoint), model, optimizer, scaler, 1, manifest_hash="manifest")
    assert (loop, updates, discriminator_updates, epoch, offset) == (7, 7, 0, 2, 11)
    assert all(torch.equal(model.state_dict()[name], value) for name, value in expected.items())
    assert rng is not None
    _restore_rng(rng)
    assert torch.equal(torch.rand(3), expected_torch)
    assert np.array_equal(np.random.rand(3), expected_numpy)
    assert [random.random() for _ in range(3)] == expected_python


def test_checkpoint_rejects_manifest_change(tmp_path: Path):
    model = nn.Linear(2, 2)
    optimizer = torch.optim.AdamW(model.parameters())
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    checkpoint = tmp_path / "resume.pt"
    save_checkpoint(checkpoint, 1, 0, model, optimizer, scaler, 0, 1, "first")
    try:
        load_checkpoint(str(checkpoint), model, optimizer, scaler, 1, manifest_hash="second")
    except ValueError as error:
        assert "manifest" in str(error)
    else:
        raise AssertionError("manifest mismatch was accepted")


def test_same_phase_rejects_legacy_checkpoint_format(tmp_path: Path):
    model = nn.Linear(2, 2)
    optimizer = torch.optim.AdamW(model.parameters())
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    checkpoint = tmp_path / "legacy.pt"
    torch.save({"format": 2, "phase": 1, "model": model.state_dict()}, checkpoint)
    try:
        load_checkpoint(str(checkpoint), model, optimizer, scaler, 1)
    except ValueError as error:
        assert "format 4" in str(error)
    else:
        raise AssertionError("legacy checkpoint was accepted as an exact resume")


def test_phase2_checkpoint_roundtrip_and_architecture_guard(tmp_path: Path):
    model = nn.Linear(2, 2)
    optimizer = torch.optim.AdamW(model.parameters())
    discriminator = TinyDiscriminator(2, 1)
    discriminator_optimizer = torch.optim.AdamW(discriminator.parameters())
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    checkpoint = tmp_path / "phase2.pt"
    save_checkpoint(
        checkpoint, 2, 4, model, optimizer, scaler, 1, 3, "manifest",
        discriminator, discriminator_optimizer, loop_step=7,
        generator_updates=5, discriminator_updates=5,
    )
    expected = {name: value.detach().clone() for name, value in discriminator.state_dict().items()}
    with torch.no_grad():
        for parameter in discriminator.parameters():
            parameter.zero_()
    position = load_checkpoint(
        str(checkpoint), model, optimizer, scaler, 2, discriminator,
        discriminator_optimizer, manifest_hash="manifest",
    )[:5]
    assert position == (7, 5, 5, 1, 3)
    assert all(torch.equal(discriminator.state_dict()[name], value)
               for name, value in expected.items())

    wrong = DifferentTinyDiscriminator(2, 1)
    wrong_optimizer = torch.optim.AdamW(wrong.parameters())
    try:
        load_checkpoint(str(checkpoint), model, optimizer, scaler, 2, wrong, wrong_optimizer)
    except ValueError as error:
        assert "architecture mismatch" in str(error)
    else:
        raise AssertionError("discriminator architecture mismatch was accepted")


def test_phase2_exact_resume_requires_discriminator_state(tmp_path: Path):
    model = nn.Linear(2, 2)
    optimizer = torch.optim.AdamW(model.parameters())
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    checkpoint = tmp_path / "incomplete-phase2.pt"
    save_checkpoint(checkpoint, 2, 0, model, optimizer, scaler, 0, 0, "manifest")
    discriminator = TinyDiscriminator(2, 1)
    discriminator_optimizer = torch.optim.AdamW(discriminator.parameters())
    try:
        load_checkpoint(
            str(checkpoint), model, optimizer, scaler, 2,
            discriminator, discriminator_optimizer,
        )
    except ValueError as error:
        assert "missing checkpoint state" in str(error)
    else:
        raise AssertionError("incomplete Phase 2 checkpoint was accepted")


def test_legacy_phase1_warm_start_skips_only_old_pitch_head(tmp_path: Path):
    old_model = ToyPitchModel(36)
    new_model = ToyPitchModel(128)
    with torch.no_grad():
        old_model.stem.weight.fill_(0.25)
        new_model.stem.weight.zero_()
    optimizer = torch.optim.AdamW(new_model.parameters())
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    checkpoint = tmp_path / "phase1-v2.pt"
    torch.save({"format": 2, "phase": 1, "model": old_model.state_dict()}, checkpoint)
    position = load_checkpoint(
        str(checkpoint), new_model, optimizer, scaler, 2,
    )[:5]
    assert position == (0, 0, 0, 0, 0)
    assert torch.equal(new_model.stem.weight, old_model.stem.weight)
    assert new_model.pitch_adversary.net[2].weight.shape[0] == 128


def test_cross_phase_warm_start_rejects_wrong_direction_and_manifest(tmp_path: Path):
    model = nn.Linear(2, 2)
    optimizer = torch.optim.AdamW(model.parameters())
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    phase2_checkpoint = tmp_path / "phase2.pt"
    torch.save({"format": 3, "phase": 2, "model": model.state_dict()}, phase2_checkpoint)
    try:
        load_checkpoint(str(phase2_checkpoint), model, optimizer, scaler, 1)
    except ValueError as error:
        assert "only from Phase 1" in str(error)
    else:
        raise AssertionError("Phase 2 to Phase 1 warm start was accepted")

    phase1_checkpoint = tmp_path / "phase1.pt"
    torch.save({
        "format": 3, "phase": 1, "manifest_hash": "first", "model": model.state_dict(),
    }, phase1_checkpoint)
    try:
        load_checkpoint(
            str(phase1_checkpoint), model, optimizer, scaler, 2, manifest_hash="second")
    except ValueError as error:
        assert "warm-start manifest" in str(error)
    else:
        raise AssertionError("cross-phase manifest mismatch was accepted")
