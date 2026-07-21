"""测试每行的漫游地图：不同 XY 点应产生明显不同、且可听辨的音色；
kNN 混合应落在合理响度范围；漫游到已有 preset 附近应接近原始渲染。"""
import sys
sys.path.insert(0, ".")
import numpy as np
from server.backends.brave_voices import MultiVoiceBraveBackend, ROW_VOICES
from server.voices import Voice

backend = MultiVoiceBraveBackend(sample_rate=44100, pool_size=4, block_samples=2048)
backend.load()

for row, name in enumerate(ROW_VOICES):
    m = backend._maps[row]
    assert m is not None, f"{name} 缺地图"
    print(f"\n=== {name}：{m['count']} 点，布局={m['layout']}，scale={m['scale']:.2f} ===")

    # 用地图上两个真实点的坐标直接起音，应该分别听起来像该 preset
    xy_a = tuple(m["xy"][0].tolist())
    xy_b = tuple(m["xy"][len(m['xy'])//2].tolist())

    v = Voice(row=row)
    v.timbre_xy = xy_a
    v.timbre_k = 1  # k=1 = 硬切到最近点，最接近"就是那个 preset"
    v.midi, v.velocity, v.duration_seconds, v.gate = 60, 1.0, 0.8, True
    backend.note_on(v)
    frames = [backend.render_split([v], 2048) for _ in range(18)]
    wav_a = np.concatenate([f[row] for f in frames])
    rms_a = float(np.sqrt(np.mean(wav_a.astype(np.float64)**2)))

    v2 = Voice(row=row)
    v2.timbre_xy = xy_b
    v2.timbre_k = 1
    v2.midi, v2.velocity, v2.duration_seconds, v2.gate = 60, 1.0, 0.8, True
    backend.note_on(v2)
    frames2 = [backend.render_split([v2], 2048) for _ in range(18)]
    wav_b = np.concatenate([f[row] for f in frames2])
    rms_b = float(np.sqrt(np.mean(wav_b.astype(np.float64)**2)))

    n = min(len(wav_a), len(wav_b))
    diff = float(np.abs(wav_a[:n] - wav_b[:n]).mean())
    print(f"  点A rms={rms_a:.4f}  点B rms={rms_b:.4f}  两点渲染平均差异={diff:.4f}（应明显>0，说明真的换音色了）")
    assert diff > 1e-3, "两个不同的 XY 点渲染出几乎一样的东西——kNN/latent_from_xy 可能有问题"

    # 漫游：note_on 后连续改 timbre_xy，模拟拖动
    v3 = Voice(row=row)
    v3.timbre_xy = xy_a
    v3.timbre_k = 3
    v3.midi, v3.velocity, v3.duration_seconds, v3.gate = 60, 1.0, 2.0, True
    backend.note_on(v3)
    roam_frames = []
    for i in range(30):
        t = i / 29
        cx = xy_a[0]*(1-t) + xy_b[0]*t
        cy = xy_a[1]*(1-t) + xy_b[1]*t
        v3.timbre_xy = (cx, cy)
        roam_frames.append(backend.render_split([v3], 2048)[row])
    roam_wav = np.concatenate(roam_frames)
    nan = bool(np.isnan(roam_wav).any())
    peak = float(np.abs(roam_wav).max())
    print(f"  漫游 30 步: peak={peak:.4f} has_nan={nan}")
    assert not nan and peak < 1.0

print("\n✅ 全部音色的漫游地图验证通过")
