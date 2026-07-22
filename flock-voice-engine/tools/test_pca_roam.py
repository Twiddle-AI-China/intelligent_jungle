"""测试每行的 PCA 无约束漫游（``timbre_pca`` / 协议 ``timbrePCA`` 字段）：
零系数应该接近该行的语料均值、不同系数应该听感不同、极端系数不该崩溃
（可能失真但必须 finite），且 PCA 优先级高于 XY（同时给两个，PCA 生效）。

跟 ``test_roam.py``（kNN/XY 模式）是同一套验收思路的 PCA 版本。这条路径
**不保证落在训练流形上**——极端系数产生怪音/失真是预期行为，不是这个脚本
要抓的 bug；这个脚本只抓"崩溃/NaN/系数不生效"这类真正的错误。
"""
import sys
sys.path.insert(0, ".")
import numpy as np
from server.backends.brave_voices import MultiVoiceBraveBackend, ROW_VOICES
from server.voices import Voice

backend = MultiVoiceBraveBackend(sample_rate=44100, pool_size=len(ROW_VOICES), block_samples=2048)
backend.load()

# 每个音色名字只测一次主行（增补的 pad 和弦行背后是同一个模型+同一张地图，
# 结果必然一样，测了也是重复）。
seen = set()
for row, name in enumerate(ROW_VOICES):
    if name in seen:
        continue
    seen.add(name)

    m = backend._maps[row]
    pca = m["pca"] if m else None
    if pca is None:
        print(f"\n=== {name}：无 PCA 基，跳过 ===")
        continue
    dims = pca["dims"]
    print(f"\n=== {name}：PCA {dims} 维，语料 {m['count']} 点 ===")

    # -- 零系数应该约等于该行语料的均值 ---------------------------------
    zero_latent = backend.latent_from_pca(row, [0.0] * dims)
    assert zero_latent is not None
    mean_diff = float(np.abs(zero_latent - pca["mean"]).max())
    print(f"  零系数 vs 语料均值：max|diff|={mean_diff:.5f}（应≈0，除非被 clip 夹过）")

    # -- 不同系数应该产生明显不同的音色 -----------------------------------
    v_a = Voice(row=row)
    v_a.timbre_pca = tuple([0.0] * dims)
    v_a.midi, v_a.velocity, v_a.duration_seconds, v_a.gate = 60, 1.0, 0.8, True
    backend.note_on(v_a)
    frames_a = [backend.render_split([v_a], 2048) for _ in range(18)]
    wav_a = np.concatenate([f[row] for f in frames_a])

    coeffs_b = [0.0] * dims
    # 用该维 p95 的系数，落在"语料里真实见过"的范围内，不是瞎给的极端值。
    coeffs_b[0] = float(pca["ranges"][0]["p95"])
    if dims > 1:
        coeffs_b[1] = float(pca["ranges"][1]["p95"])
    v_b = Voice(row=row)
    v_b.timbre_pca = tuple(coeffs_b)
    v_b.midi, v_b.velocity, v_b.duration_seconds, v_b.gate = 60, 1.0, 0.8, True
    backend.note_on(v_b)
    frames_b = [backend.render_split([v_b], 2048) for _ in range(18)]
    wav_b = np.concatenate([f[row] for f in frames_b])

    diff = float(np.abs(wav_a - wav_b).mean())
    rms_a = float(np.sqrt(np.mean(wav_a.astype(np.float64) ** 2)))
    rms_b = float(np.sqrt(np.mean(wav_b.astype(np.float64) ** 2)))
    print(f"  PC1/PC2=0 vs p95：rms_a={rms_a:.4f} rms_b={rms_b:.4f} "
          f"平均差异={diff:.4f}（应明显>0，说明系数真的生效了）")
    assert diff > 1e-3, f"{name}: 不同 PCA 系数渲染出几乎一样的东西——latent_from_pca 可能没生效"
    assert np.isfinite(wav_a).all() and np.isfinite(wav_b).all(), f"{name}: 输出含 NaN/Inf"

    # -- 极端系数（p95 的 3 倍，明显出流形）：可能失真，但不能崩/不能 NaN --
    extreme = [float(pca["ranges"][i]["p95"]) * 3 for i in range(dims)]
    v_c = Voice(row=row)
    v_c.timbre_pca = tuple(extreme)
    v_c.midi, v_c.velocity, v_c.duration_seconds, v_c.gate = 60, 1.0, 0.5, True
    backend.note_on(v_c)
    frames_c = [backend.render_split([v_c], 2048) for _ in range(12)]
    wav_c = np.concatenate([f[row] for f in frames_c])
    finite_c = bool(np.isfinite(wav_c).all())
    print(f"  极端系数（3×p95）：finite={finite_c}（不保证好听，只保证不崩）")
    assert finite_c, f"{name}: 极端 PCA 系数产生了 NaN/Inf，clip 逻辑可能有问题"

    # -- PCA 优先级高于 XY：两个都给，听到的必须是 PCA 那个 --------------
    if m["xy"] is not None and len(m["xy"]):
        v_d = Voice(row=row)
        v_d.timbre_xy = (float(m["xy"][0][0]), float(m["xy"][0][1]))  # 一个真实 XY 点
        v_d.timbre_pca = tuple(coeffs_b)  # 同时给 PCA
        v_d.midi, v_d.velocity, v_d.duration_seconds, v_d.gate = 60, 1.0, 0.8, True
        backend.note_on(v_d)
        frames_d = [backend.render_split([v_d], 2048) for _ in range(18)]
        wav_d = np.concatenate([f[row] for f in frames_d])
        diff_from_pca_only = float(np.abs(wav_b - wav_d).mean())
        diff_from_xy_only = float(np.abs(wav_a - wav_d).mean())
        print(f"  PCA+XY 同给：与纯 PCA 差异={diff_from_pca_only:.4f}，"
              f"（应该很小——PCA 优先级更高，XY 应该被忽略）")
        assert diff_from_pca_only < diff_from_xy_only, \
            f"{name}: 同时给 timbre_pca 和 timbre_xy 时，XY 反而生效了——优先级判断可能有问题"

print("\n✅ 全部音色的 PCA 漫游验证通过")
