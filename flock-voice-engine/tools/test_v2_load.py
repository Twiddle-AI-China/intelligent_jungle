"""独立测试：四音色 v2 backend 能否正确加载，hash 校验是否真的过了。"""
import sys, time
sys.path.insert(0, ".")
from server.backends.midibrave_backend_v2 import MidiBraveBackendV2, VOICE_CHECKPOINTS

for name in VOICE_CHECKPOINTS:
    t0 = time.time()
    b = MidiBraveBackendV2(name, verify_hashes=True)
    dt = time.time() - t0
    cfg = b.config.model
    print(f"{name}: OK in {dt:.2f}s  timbre_dim={cfg.timbre_dim}  "
          f"stochastic={cfg.stochastic_excitation}  seed={cfg.stochastic_seed}  "
          f"film_scale_limit={cfg.film_scale_limit}  step={b.checkpoint_meta.get('step')}")
print("\n全部 hash 校验通过（config file hash + checkpoint 自报 hash 双重核对）")
