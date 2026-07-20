from __future__ import annotations

import json
import os
import statistics
import time

import torch
import torch.distributed as dist
from torch import nn
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.profiler import ProfilerActivity, profile, record_function, schedule
from torch.utils.data import DataLoader, DistributedSampler

from midibrave.config import Config
from midibrave.data import PairDataset
from midibrave.losses import (
    BraveMultiScaleDiscriminator,
    DifferentiableCrepeObjective,
    MultiBandSTFTLoss,
    MultiResolutionSTFTLoss,
    MultiScaleEnvelopeLoss,
    ReconstructionLoss,
    discriminator_hinge,
    feature_matching,
    generator_adversarial,
)
from midibrave.model import (
    BraveDecoder,
    HarmonicExcitation,
    MidiBrave,
    MidiConditioner,
    PQMF,
    TimbreAdapter,
)
from midibrave.trainer import (
    _split_discriminator_batch,
    make_generator_optimizer,
    move_batch,
    unwrap,
)


def wrap_forward(cls: type[nn.Module], label: str) -> None:
    original = cls.forward

    def wrapped(self, *args, **kwargs):
        with record_function(label):
            return original(self, *args, **kwargs)

    cls.forward = wrapped


def wrap_method(cls: type[nn.Module], method: str, label: str) -> None:
    original = getattr(cls, method)

    def wrapped(self, *args, **kwargs):
        with record_function(label):
            return original(self, *args, **kwargs)

    setattr(cls, method, wrapped)


wrap_forward(TimbreAdapter, "component::timbre_adapter")
wrap_forward(MidiConditioner, "component::midi_conditioner")
wrap_forward(HarmonicExcitation, "component::harmonic_excitation")
wrap_forward(BraveDecoder, "component::brave_decoder")
wrap_method(PQMF, "analysis", "component::pqmf_analysis")
wrap_method(PQMF, "synthesis", "component::pqmf_synthesis")
wrap_forward(MultiResolutionSTFTLoss, "loss::mrstft")
wrap_forward(MultiBandSTFTLoss, "loss::multiband_stft")
wrap_forward(MultiScaleEnvelopeLoss, "loss::envelope")
wrap_forward(DifferentiableCrepeObjective, "loss::crepe")
wrap_forward(BraveMultiScaleDiscriminator, "component::discriminator")


phase = int(os.environ["PROFILE_PHASE"])
config_path = os.environ.get(
    "PROFILE_CONFIG", "/workspace/MidiBrave/configs/quality300_eligible.yaml"
)
output_root = os.environ["PROFILE_OUTPUT"]
world_size = int(os.environ.get("WORLD_SIZE", "1"))
rank = int(os.environ.get("RANK", "0"))
local_rank = int(os.environ.get("LOCAL_RANK", "0"))

torch.cuda.set_device(local_rank)
device = torch.device("cuda", local_rank)
if world_size > 1:
    dist.init_process_group("nccl")

config = Config.load(config_path)
torch.manual_seed(config.seed + rank)
torch.cuda.manual_seed_all(config.seed + rank)
torch.backends.cudnn.benchmark = True

dataset = PairDataset(config.data, config.seed)
sampler = DistributedSampler(
    dataset,
    num_replicas=world_size,
    rank=rank,
    shuffle=True,
    seed=config.seed,
    drop_last=True,
)
loader_kwargs = {
    "batch_size": config.train.batch_per_gpu,
    "sampler": sampler,
    "num_workers": config.data.num_workers,
    "pin_memory": True,
    "persistent_workers": config.data.num_workers > 0,
    "drop_last": True,
}
if config.data.num_workers > 0:
    loader_kwargs["prefetch_factor"] = config.data.prefetch_factor
loader = DataLoader(dataset, **loader_kwargs)
iterator = iter(loader)

model: nn.Module = MidiBrave(
    config.model, config.data.window_samples, config.data.sample_rate
).to(device)
if world_size > 1:
    model = DDP(model, device_ids=[local_rank], broadcast_buffers=False)
generator_optimizer = make_generator_optimizer(unwrap(model), config, phase)

discriminator: nn.Module | None = None
discriminator_optimizer: torch.optim.Optimizer | None = None
if phase == 2:
    discriminator = BraveMultiScaleDiscriminator().to(device)
    if world_size > 1:
        discriminator = DDP(
            discriminator, device_ids=[local_rank], broadcast_buffers=False
        )
    discriminator_optimizer = torch.optim.AdamW(
        discriminator.parameters(),
        lr=config.train.discriminator_lr,
        betas=(0.5, 0.9),
    )

reconstruction = ReconstructionLoss(
    config.loss,
    config.data.sample_rate,
    config.model.pitch_backend,
    config.data.pitch_hop_length,
    config.model.pqmf_bands,
    config.model.pqmf_taps,
).to(device)
scaler = torch.amp.GradScaler(
    "cuda",
    init_scale=config.train.grad_scaler_init_scale,
    growth_interval=config.train.grad_scaler_growth_interval,
)


def get_batch():
    global iterator
    try:
        value = next(iterator)
    except StopIteration:
        iterator = iter(loader)
        value = next(iterator)
    return move_batch(value, device)


profiler = profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
    schedule=schedule(wait=3, warmup=5, active=10, repeat=1),
    record_shapes=world_size == 1,
    profile_memory=world_size == 1,
    with_stack=False,
    with_flops=True,
)
step_ms: list[float] = []
data_ms: list[float] = []
torch.cuda.reset_peak_memory_stats(device)

with profiler:
    for _ in range(18):
        wall_start = time.perf_counter()
        data_start = time.perf_counter()
        batch = get_batch()
        data_ms.append((time.perf_counter() - data_start) * 1000.0)

        generator_optimizer.zero_grad(set_to_none=True)
        if discriminator_optimizer is not None:
            discriminator_optimizer.zero_grad(set_to_none=True)

        with record_function("step::generator_forward_and_losses"):
            if discriminator is not None:
                discriminator.requires_grad_(False)
            with torch.autocast("cuda", dtype=torch.float16):
                output = model(
                    batch["clap_a"],
                    batch["note_a"],
                    batch["velocity_a"],
                    batch["note_b"],
                    batch["velocity_b"],
                    batch["clap_b"],
                    grl_scale=1.0,
                )
                losses = reconstruction(
                    output,
                    batch,
                    output.target_timbre,
                    adversary_enabled=True,
                )
                generator_loss = losses.total
                if discriminator is not None:
                    pair_batch = batch["audio_a"].shape[0]
                    with torch.no_grad():
                        real_combined = discriminator(
                            torch.cat((batch["audio_a"], batch["audio_b"]), dim=0)
                        )
                        real_self, real_cross = _split_discriminator_batch(
                            real_combined, pair_batch
                        )
                    fake_combined = discriminator(
                        torch.cat((output.self_audio, output.cross_audio), dim=0)
                    )
                    fake_self, fake_cross = _split_discriminator_batch(
                        fake_combined, pair_batch
                    )
                    adversarial = generator_adversarial(fake_self) + 0.25 * generator_adversarial(
                        fake_cross
                    )
                    matching = feature_matching(real_self, fake_self) + 0.25 * feature_matching(
                        real_cross, fake_cross
                    )
                    generator_loss = (
                        generator_loss
                        + config.loss.adversarial * adversarial
                        + config.loss.feature_matching * matching
                    )

        with record_function("step::generator_backward"):
            scaler.scale(generator_loss).backward()
        if discriminator is not None:
            discriminator.requires_grad_(True)

        if discriminator is not None and discriminator_optimizer is not None:
            with record_function("step::discriminator_forward"):
                with torch.autocast("cuda", dtype=torch.float16):
                    real = discriminator(
                        torch.cat((batch["audio_a"], batch["audio_b"]), dim=0)
                    )
                    fake = discriminator(
                        torch.cat(
                            (output.self_audio.detach(), output.cross_audio.detach()), dim=0
                        )
                    )
                    discriminator_loss = discriminator_hinge(real, fake)
            with record_function("step::discriminator_backward"):
                scaler.scale(discriminator_loss).backward()

        with record_function("step::optimizer"):
            scaler.unscale_(generator_optimizer)
            nn.utils.clip_grad_norm_(model.parameters(), config.train.grad_clip)
            if discriminator_optimizer is not None and discriminator is not None:
                scaler.unscale_(discriminator_optimizer)
                nn.utils.clip_grad_norm_(
                    discriminator.parameters(), config.train.grad_clip
                )
            scaler.step(generator_optimizer)
            if discriminator_optimizer is not None:
                scaler.step(discriminator_optimizer)
            scaler.update()

        torch.cuda.synchronize(device)
        step_ms.append((time.perf_counter() - wall_start) * 1000.0)
        profiler.step()

if rank == 0:
    os.makedirs(output_root, exist_ok=True)
    trace_path = os.path.join(output_root, "trace.json")
    profiler.export_chrome_trace(trace_path)
    active_steps = step_ms[8:]
    active_data = data_ms[8:]
    sorted_steps = sorted(active_steps)
    report = {
        "phase": phase,
        "world_size": world_size,
        "batch_per_gpu": config.train.batch_per_gpu,
        "window_samples": config.data.window_samples,
        "active_steps": len(active_steps),
        "median_step_ms": statistics.median(active_steps),
        "p90_step_ms": sorted_steps[
            min(len(sorted_steps) - 1, round(0.9 * (len(sorted_steps) - 1)))
        ],
        "median_data_ms": statistics.median(active_data),
        "peak_allocated_gib": torch.cuda.max_memory_allocated(device) / 2**30,
        "peak_reserved_gib": torch.cuda.max_memory_reserved(device) / 2**30,
        "trace": trace_path,
    }
    print("PROFILE_JSON=" + json.dumps(report, sort_keys=True), flush=True)
    print(
        profiler.key_averages().table(sort_by="cuda_time_total", row_limit=120),
        flush=True,
    )
    print(
        profiler.key_averages().table(
            sort_by="self_cuda_time_total", row_limit=80
        ),
        flush=True,
    )

if world_size > 1:
    dist.barrier()
    dist.destroy_process_group()
