from __future__ import annotations

import numpy as np


def describe(samples: np.ndarray, sample_rate: int) -> dict[str, float]:
    x = np.asarray(samples, dtype=np.float64)
    if len(x) == 0 or not np.all(np.isfinite(x)):
        return {"valid": 0.0}
    rms = float(np.sqrt(np.mean(x * x) + 1e-12))
    peak = float(np.max(np.abs(x)))
    windowed = x * np.hanning(len(x))
    spectrum = np.abs(np.fft.rfft(windowed)) + 1e-12
    power = spectrum * spectrum
    frequencies = np.fft.rfftfreq(len(x), 1 / sample_rate)
    centroid = float(np.sum(frequencies * power) / np.sum(power) / (sample_rate / 2))
    flatness = float(np.exp(np.mean(np.log(spectrum))) / np.mean(spectrum))
    crest = peak / max(rms, 1e-9)
    zcr = float(np.mean(np.signbit(x[1:]) != np.signbit(x[:-1]))) if len(x) > 1 else 0.0
    correlation_input = x[: min(len(x), 8192)]
    fft_size = 1 << max(1, (len(correlation_input) * 2 - 1).bit_length())
    transformed = np.fft.rfft(correlation_input, fft_size)
    autocorr = np.fft.irfft(transformed * np.conj(transformed), fft_size)[: len(correlation_input)]
    min_lag = max(1, sample_rate // 1200)
    max_lag = min(len(autocorr), sample_rate // 40)
    harmonicity = 0.0
    if max_lag > min_lag and autocorr[0] > 1e-9:
        harmonicity = float(np.max(autocorr[min_lag:max_lag]) / autocorr[0])
    return {
        "valid": float(rms > 1e-4 and peak < 0.999),
        "rms": rms,
        "peak": peak,
        "brightness": centroid,
        "noisiness": flatness,
        "transientness": float(np.clip((crest - 1) / 12, 0, 1)),
        "roughness_proxy": float(np.clip(zcr * 8, 0, 1)),
        "harmonicity": float(np.clip(harmonicity, 0, 1)),
    }
