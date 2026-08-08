"""pad 的新引擎（TrajectoryBrave）冒烟测试：单音、4 行同时发声（和弦）、
越界 note 不崩溃、XY 漫游确实改变音色、reset() 立即静音。

跟 ``test_multivoice.py``/``test_roam.py``/``test_pca_roam.py`` 同一套验收
思路，只测 pad 这一个音色（其余音色引擎没变，已有脚本覆盖）。默认
``device="cpu"``——GPU 上的延迟门禁（4 行同时 render_split 是否在当前
block_samples=4096/44.1kHz≈92.88ms 预算内）必须在隔离候选环境单独测，这里只验证
正确性/不崩溃，不测时序。

用法（只在隔离 candidate checkout/staging 跑；device=cpu 也能跑，只是慢）::

    python3 tools/test_trajectorybrave_pad.py
"""
import sys
import time

sys.path.insert(0, ".")
import numpy as np
from server.backends.brave_voices import MultiVoiceBraveBackend, ROW_VOICES
from server.config import DEFAULT_BLOCK_SAMPLES
from server.voices import Voice

BLOCK_SAMPLES = DEFAULT_BLOCK_SAMPLES
PAD_ROWS = [row for row, name in enumerate(ROW_VOICES) if name == "pad"]
assert PAD_ROWS == [1, 4, 8, 9], f"预期当前 pad 行为 [1, 4, 8, 9]，实际 {PAD_ROWS}"

backend = MultiVoiceBraveBackend(
    sample_rate=44100,
    pool_size=len(ROW_VOICES),
    block_samples=BLOCK_SAMPLES,
)
backend.load()
print(f"pad 占行: {PAD_ROWS}")

meta = backend._backends[PAD_ROWS[0]].checkpoint_meta
print(f"checkpoint: step={meta.get('step')} sha256={meta.get('sha256', '')[:16]}…")
assert meta.get("step") == 35000, f"checkpoint step 不是预期的 35000: {meta.get('step')}"

# -- 单音：非静音、有限值 -----------------------------------------------
row = PAD_ROWS[0]
v = Voice(row=row)
v.midi, v.velocity, v.duration_seconds, v.gate = 60, 1.0, 2.0, True
backend.note_on(v)
frames = [backend.render_split([v], BLOCK_SAMPLES) for _ in range(20)]
wav = np.concatenate([f[row] for f in frames])
rms = float(np.sqrt(np.mean(wav.astype(np.float64) ** 2)))
print(f"\n=== 单音（row {row}）===")
print(f"  {len(wav)} samples, rms={rms:.4f}, finite={bool(np.isfinite(wav).all())}")
assert np.isfinite(wav).all(), "单音输出含 NaN/Inf"
assert rms > 1e-4, f"单音几乎静音（rms={rms:.6f}），引擎可能没有真正发声"

# -- 越界 note：TRAIN_NOTE_MIN/MAX(21-109) 允许但 checkpoint 只到 36-71 ---
# 必须在 TrajectoryVoice 内部被 clamp，不能把 LiveRenderer 的 ValueError
# 一路炸穿 note_on()（brave_voices.py 的 note_on 是同步调用，炸出去就是
# 整个会话挂掉——跟 mvp jungle break 的 NaN 崩溃是同一类风险）。
print("\n=== 越界 note（100，超出 pad 训练范围 36-71）===")
v_extreme = Voice(row=row)
v_extreme.midi, v_extreme.velocity, v_extreme.duration_seconds, v_extreme.gate = 100, 1.0, 0.5, True
backend.note_on(v_extreme)  # 不应该抛异常
frames_extreme = backend.render_split([v_extreme], BLOCK_SAMPLES)
assert np.isfinite(frames_extreme[row]).all(), "越界 note 渲染出 NaN/Inf"
print("  未抛异常，输出有限值 ✅")
backend.note_off(v_extreme)

# -- 4 行同时发声（和弦）：全部非静音、有限值，顺带量一下墙钟耗时 --------
print(f"\n=== 4 行同时发声（和弦，rows={PAD_ROWS}）===")
chord_voices = []
for i, r in enumerate(PAD_ROWS):
    cv = Voice(row=r)
    cv.midi, cv.velocity, cv.duration_seconds, cv.gate = 60 + i * 3, 1.0, 2.0, True
    chord_voices.append(cv)
    backend.note_on(cv)

render_ms = []
chord_frames = {r: [] for r in PAD_ROWS}
for _ in range(20):
    started = time.perf_counter()
    block = backend.render_split(chord_voices, BLOCK_SAMPLES)
    render_ms.append((time.perf_counter() - started) * 1000.0)
    for r in PAD_ROWS:
        chord_frames[r].append(block[r])

budget_ms = BLOCK_SAMPLES / 44100 * 1000
p50 = float(np.percentile(render_ms, 50))
p99 = float(np.percentile(render_ms, 99))
print(f"  render_split 墙钟耗时: p50={p50:.2f}ms p99={p99:.2f}ms 预算={budget_ms:.2f}ms")
print("  （这是本机数字，不是 GPU 门禁——GPU 上必须单独测，见模块 docstring）")

for r in PAD_ROWS:
    wav_r = np.concatenate(chord_frames[r])
    rms_r = float(np.sqrt(np.mean(wav_r.astype(np.float64) ** 2)))
    finite_r = bool(np.isfinite(wav_r).all())
    print(f"  row {r}: rms={rms_r:.4f} finite={finite_r}")
    assert finite_r, f"row {r} 和弦渲染输出含 NaN/Inf"
    assert rms_r > 1e-4, f"row {r} 和弦渲染几乎静音（rms={rms_r:.6f}）"

for cv in chord_voices:
    backend.note_off(cv)

# -- XY 漫游：不同 XY 应该产生明显不同的音色（同 test_roam.py 的验收思路）--
m = backend._maps[row]
if m is not None and len(m["xy"]) >= 2:
    print(f"\n=== XY 漫游（row {row}，地图 {m['count']} 点，布局={m['layout']}）===")
    xy_a = (float(m["xy"][0][0]), float(m["xy"][0][1]))
    xy_b = (float(m["xy"][-1][0]), float(m["xy"][-1][1]))

    v_a = Voice(row=row)
    v_a.timbre_xy = xy_a
    v_a.midi, v_a.velocity, v_a.duration_seconds, v_a.gate = 60, 1.0, 1.0, True
    backend.note_on(v_a)
    wav_a = np.concatenate(
        [backend.render_split([v_a], BLOCK_SAMPLES)[row] for _ in range(12)]
    )
    backend.note_off(v_a)

    v_b = Voice(row=row)
    v_b.timbre_xy = xy_b
    v_b.midi, v_b.velocity, v_b.duration_seconds, v_b.gate = 60, 1.0, 1.0, True
    backend.note_on(v_b)
    wav_b = np.concatenate(
        [backend.render_split([v_b], BLOCK_SAMPLES)[row] for _ in range(12)]
    )
    backend.note_off(v_b)

    diff = float(np.abs(wav_a - wav_b).mean())
    print(f"  两个不同地图点的平均差异={diff:.4f}（应明显>0）")
    assert diff > 1e-3, "不同 XY 点渲染出几乎一样的东西——latent_from_xy 到新地图的接线可能没生效"
else:
    print("\n=== XY 漫游：跳过（地图未生成，先跑 tools/build_pad_trajectorybrave_map.py）===")

# -- reset()：应立即静音，不留 release 尾音 ------------------------------
print("\n=== reset() ===")
v_final = Voice(row=row)
v_final.midi, v_final.velocity, v_final.duration_seconds, v_final.gate = 60, 1.0, 2.0, True
backend.note_on(v_final)
backend.render_split([v_final], BLOCK_SAMPLES)
backend.reset()
print("  reset() 未抛异常 ✅")

print("\n✅ TrajectoryBrave pad 冒烟测试全部通过")
