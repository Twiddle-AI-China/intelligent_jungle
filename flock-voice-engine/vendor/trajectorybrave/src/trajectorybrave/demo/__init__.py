"""Minimal browser demo for real-time 8-D TrajectoryBrave control.

Vendored subset: only ``live`` (``LiveRenderer``/``load_runtime_model``) is used
by this repo's backend integration (``server/backends/trajectorybrave_pad.py``).
``control.AnchorManifold`` implements a different roam-safety mechanism (RBF
trust-region projection over normalized PCA coordinates) than the one this repo
already uses for every other voice (``MultiVoiceBraveBackend.latent_from_xy``/
``latent_from_pca`` in ``brave_voices.py``, kNN/free-subspace over the voice's
own ``assets/timbre/voice_maps/{voice}.json``) — so ``control.py`` and
``server.py`` (their own standalone demo server) are intentionally not
vendored here.
"""

from .live import LiveLifecycle, LiveRenderer, load_runtime_model

__all__ = ["LiveLifecycle", "LiveRenderer", "load_runtime_model"]
