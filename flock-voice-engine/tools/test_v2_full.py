"""完整验收：四音色 × 多种块长，流式 vs 离线逐样本比对。

**方法论要点**：torch.randn(bands, N) 对不同 N 是两次独立的 draw，不是
「大 draw 的前缀 == 小 draw」（行主序填充：第 0 行先填满 N 个元素才轮到
第 1 行，N 一变第 1 行的起始偏移就变，bands>1 时不再是同一个流的前缀）。
所以离线参考和流式必须读**同一个已生成好的缓冲区的切片**，而不是分别
生成两个不同大小的缓冲区——测试脚本在调用 render_note() 之前先调用
prepare_note_stochastic()，确保两条路径共享同一个 buffer 对象。
"""
import sys, numpy as np, torch
sys.path.insert(0, ".")
from server.backends.midibrave_backend_v2 import MidiBraveBackendV2
from server.backends.streaming import StreamingVoice

NOTE, VEL, DURATION = 60, 127, 1.0

def offline(backend):
    z = torch.from_numpy(np.load(f"assets/timbre/voice_defaults/{backend.voice_name}.npy")).float()
    with torch.no_grad():
        z_timbre = backend.timbre_from_clap(z)
    # 关键：先 prepare，让 render_note() 内部的 excitation_bands() 走「有缓冲」
    # 分支，读同一个 buffer 的前缀切片，而不是自己单独现算一个不同大小的。
    backend.prepare_note_stochastic(DURATION)
    return backend.render_note(z_timbre, NOTE, VEL, DURATION), z_timbre

def streaming(backend, z_timbre, block_samples, total_needed):
    # 复用 offline() 已经生成好的同一个 _stochastic_cache——不清空、不重算。
    voice = StreamingVoice(backend)
    voice.note_on(z_timbre, NOTE, VEL)
    chunks, got = [], 0
    while got < total_needed:
        block = voice.render_block(block_samples)
        chunks.append(block)
        got += block_samples
    return np.concatenate(chunks)[:total_needed]

all_ok = True
for voice_name in ["pad", "bass", "lead", "pluck"]:
    backend = MidiBraveBackendV2(voice_name, verify_hashes=True)
    ref, z_timbre = offline(backend)
    total_needed = len(ref)
    print(f"\n=== {voice_name} (checkpoint step={backend.checkpoint_meta.get('step')}) ===")
    for block_samples in (128, 512, 2048, 4096):
        got = streaming(backend, z_timbre, block_samples, total_needed)
        n = min(len(ref), len(got))
        diff = np.abs(ref[:n] - got[:n])
        ok = diff.max() < 1e-4
        all_ok &= ok
        print(f"  块={block_samples:5d}  max_abs_diff={diff.max():.3e}  "
              f"（峰值 {np.abs(ref).max():.4f}）  {'OK' if ok else 'FAIL'}")

print(f"\n{'='*50}")
print("全部通过" if all_ok else "存在未通过项")
