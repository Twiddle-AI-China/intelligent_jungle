"""对 1822 个 Serum preset 各取一条代表单音，算音色画像（谱质心/起音/800ms 留存）。纯 numpy+soundfile。"""
import json, os, re, sys
from collections import defaultdict
import numpy as np, soundfile as sf

ROOT = '/data/datasets/latent-cosmos-synth/serum-dataset'
CLAP_DIR = '/data/midibrave/cache/serum_strict_1822/clap'
SR = 44100

# --- preset 元数据（看看有没有类别字段）---
pres = {}
pp = os.path.join(ROOT, 'metadata', 'presets.jsonl')
with open(pp) as f:
    for l in f:
        d = json.loads(l)
        pres[d.get('preset_id')] = d
k0 = sorted(next(iter(pres.values())).keys())
print("presets.jsonl 字段:", k0, flush=True)

# --- 每个 preset 选一条代表样本：优先 note 60 / v127，否则取中位 note 的 v127 ---
samples = defaultdict(list)
with open(os.path.join(ROOT, 'metadata', 'samples.jsonl')) as f:
    for l in f:
        d = json.loads(l)
        samples[d['preset_id']].append(d)

have_clap = {re.match(r'(serum_s\d+)_', x).group(1) for x in os.listdir(CLAP_DIR)}
pids = sorted(have_clap)
print("presets with clap:", len(pids), flush=True)

def pick(pid):
    ss = [s for s in samples[pid] if s['velocity'] == 127]
    if not ss: ss = samples[pid]
    ss.sort(key=lambda s: (abs(s['midi_note'] - 60), s['midi_note']))
    return ss[0]

def descriptors(x, sr=SR):
    x = np.asarray(x, np.float64)
    n = len(x)
    # --- RMS 包络 (10ms hop) ---
    hop = int(0.010 * sr); win = int(0.020 * sr)
    nf = max(1, (n - win) // hop + 1)
    rms = np.array([np.sqrt(np.mean(x[i*hop:i*hop+win]**2) + 1e-20) for i in range(nf)])
    peak_i = int(np.argmax(rms)); peak = rms[peak_i]
    # 起音时间：从 10% 峰值 到 90% 峰值
    thr_lo, thr_hi = 0.1 * peak, 0.9 * peak
    try:
        i_lo = int(np.argmax(rms >= thr_lo))
        i_hi = i_lo + int(np.argmax(rms[i_lo:] >= thr_hi))
        attack_ms = (i_hi - i_lo) * hop / sr * 1000.0
    except Exception:
        attack_ms = float('nan')
    # 800ms 留存：起音后 800ms 处 RMS / 峰值
    i800 = i_lo + int(0.800 * sr / hop)
    ret800 = float(rms[i800] / peak) if i800 < len(rms) else 0.0
    # 2s 留存（区分 pad 与 pluck 更稳）
    i2000 = i_lo + int(2.000 * sr / hop)
    ret2000 = float(rms[i2000] / peak) if i2000 < len(rms) else 0.0
    # --- 谱质心（对能量最强的 1s 段算，功率加权）---
    seg0 = max(0, peak_i * hop); seg = x[seg0:seg0 + sr]
    if len(seg) < 2048: seg = x[:sr]
    w = np.hanning(len(seg)); S = np.abs(np.fft.rfft(seg * w)) ** 2
    fr = np.fft.rfftfreq(len(seg), 1 / sr)
    cen = float((S * fr).sum() / (S.sum() + 1e-20))
    # 谱衰减点 rolloff85 与 高频能量占比
    cs = np.cumsum(S); roll = float(fr[int(np.argmax(cs >= 0.85 * cs[-1]))])
    hf = float(S[fr > 4000].sum() / (S.sum() + 1e-20))
    # 谱平坦度（噪声/嘈杂度）
    Sp = S + 1e-20
    flat = float(np.exp(np.mean(np.log(Sp))) / np.mean(Sp))
    return dict(attack_ms=float(attack_ms), retention_800ms=ret800, retention_2s=ret2000,
                centroid_hz=cen, rolloff85_hz=roll, hf_ratio=hf, flatness=flat,
                peak_rms=float(peak))

out = {}
for i, pid in enumerate(pids):
    s = pick(pid)
    wav = os.path.join(ROOT, s['audio_path'])
    try:
        x, sr = sf.read(wav, dtype='float64', always_2d=False)
        if x.ndim > 1: x = x.mean(1)
        d = descriptors(x, sr)
    except Exception as e:
        print("FAIL", pid, e, flush=True); continue
    d['sample_id'] = s['sample_id']; d['midi_note'] = s['midi_note']
    d['velocity'] = s['velocity']; d['audio_path'] = s['audio_path']
    meta = pres.get(pid, {})
    for kk in ('category', 'preset_category', 'name', 'preset_name', 'bank', 'path'):
        if kk in meta: d[kk] = meta[kk]
    out[pid] = d
    if i % 300 == 0: print("  ..", i, pid, flush=True)

json.dump(out, open('/home/rolf/staging/descriptors.json', 'w'), ensure_ascii=False, indent=1)
print("wrote /home/rolf/staging/descriptors.json  n=", len(out))
c = np.array([v['centroid_hz'] for v in out.values()])
a = np.array([v['attack_ms'] for v in out.values()])
r = np.array([v['retention_800ms'] for v in out.values()])
for nm, v in (('centroid_hz', c), ('attack_ms', a), ('retention_800ms', r)):
    q = np.nanpercentile(v, [5, 25, 50, 75, 95])
    print(f"{nm}: p5={q[0]:.3f} p25={q[1]:.3f} p50={q[2]:.3f} p75={q[3]:.3f} p95={q[4]:.3f}")
