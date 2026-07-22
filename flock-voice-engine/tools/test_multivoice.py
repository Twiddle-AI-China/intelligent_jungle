"""端到端测试 MultiVoiceBraveBackend：四音色一起 load()，逐轨渲染，检查响度标定。"""
import sys, numpy as np
sys.path.insert(0, ".")
from server.backends.brave_voices import MultiVoiceBraveBackend, ROW_VOICES
from server.voices import Voice

backend = MultiVoiceBraveBackend(sample_rate=44100, pool_size=len(ROW_VOICES), block_samples=2048)
backend.load()
print("加载完成，行→音色:", ROW_VOICES)
print("响度标定增益:", [round(g, 3) for g in backend._row_gain])

voices = [Voice(row=i) for i in range(len(ROW_VOICES))]
notes = [43, 55, 67, 60, 62, 65, 69][:len(ROW_VOICES)]  # 够 7 行；pad 增补行随手给个和弦音
for v, n in zip(voices, notes):
    v.midi = n
    v.velocity = 1.0
    v.duration_seconds = 1.0
    v.gate = True
    backend.note_on(v)

frames = []
for _ in range(22):  # 22 块 * 2048 = 45056 样本 ≈ 1.02s，贴合声明的 1.0s duration
    frames.append(backend.render_split(voices, 2048))
tracks = np.concatenate(frames, axis=1)  # (4, N)

for row, name in enumerate(ROW_VOICES):
    rms = float(np.sqrt(np.mean(tracks[row].astype(np.float64) ** 2)))
    peak = float(np.abs(tracks[row]).max())
    nan = bool(np.isnan(tracks[row]).any())
    print(f"  row{row} {name:6s}: rms={rms:.4f} peak={peak:.4f} has_nan={nan}")

mix = tracks.sum(0)
print(f"混合: peak={np.abs(mix).max():.4f} (应 < 1.0，OUTPUT_TRIM+软限幅生效)")

info = backend.info()
print("\ninfo():", {k: v for k, v in info.items() if k != "voices"})
print("voices meta:", info["voices"])
