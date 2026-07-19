"""Reproducibility controls shared by GPU training entrypoints."""

from __future__ import annotations

import random

import numpy as np
import torch


def seed_training(seed: int) -> None:
    """Fix all trainer-side RNG roots before models or dataloaders are built."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
