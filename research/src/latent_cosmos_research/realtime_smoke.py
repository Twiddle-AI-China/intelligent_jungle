from __future__ import annotations

import argparse
import asyncio
import json

import numpy as np


async def run(url: str) -> dict:
    from aiohttp import ClientSession, WSMsgType

    async with ClientSession() as session:
        async with session.ws_connect(url, heartbeat=15) as ws:
            ready_message = await ws.receive(timeout=15)
            ready = json.loads(ready_message.data)
            if ready.get("engine") != "brave-streaming-decoder":
                raise RuntimeError(f"unexpected decoder: {ready}")

            base_voices = [
                {
                    "objectId": index,
                    "species": species,
                    "latentPosition": [0.2, 0.25, 0.3, 0.35],
                    "pan": index - 1,
                    "energy": 0.6,
                    "muted": False,
                    "solo": False,
                }
                for index, species in enumerate(("pulse", "resonance", "texture"))
            ]

            async def phase(voices: list[dict], revision: int) -> tuple[np.ndarray, dict]:
                await ws.send_json({"type": "control", "voices": voices})
                blocks: list[np.ndarray] = []
                telemetry = None
                while len(blocks) < 12 or telemetry is None or telemetry.get("revision", 0) < revision:
                    message = await ws.receive(timeout=5)
                    if message.type == WSMsgType.BINARY:
                        blocks.append(np.frombuffer(message.data, dtype="<f4").reshape(-1, 2))
                    elif message.type == WSMsgType.TEXT:
                        value = json.loads(message.data)
                        if value.get("type") == "telemetry":
                            telemetry = value
                return np.concatenate(blocks), telemetry

            low_audio, low = await phase(base_voices, 1)
            high_voices = [dict(voice, latentPosition=[0.8, 0.75, 0.7, 0.65]) for voice in base_voices]
            high_audio, high = await phase(high_voices, 2)

    low_latent = np.asarray([voice["latentMean"] for voice in low["voices"]], dtype=np.float32)
    high_latent = np.asarray([voice["latentMean"] for voice in high["voices"]], dtype=np.float32)
    latent_delta = float(np.linalg.norm(high_latent - low_latent, axis=1).mean())
    audio_delta = float(np.sqrt(np.mean((high_audio[: len(low_audio)] - low_audio[: len(high_audio)]) ** 2)))
    rms = float(np.sqrt(np.mean(high_audio**2)))
    low_magnitude = np.abs(np.fft.rfft(low_audio.mean(axis=1))) + 1e-7
    high_magnitude = np.abs(np.fft.rfft(high_audio.mean(axis=1))) + 1e-7
    spectral_log_delta = float(np.sqrt(np.mean((np.log(high_magnitude) - np.log(low_magnitude)) ** 2)))
    voice_db = [float(voice["db"]) for voice in high["voices"]]
    result = {
        "engine": ready["engine"],
        "modelSha256": ready["modelSha256"],
        "latentSize": ready["latentSize"],
        "decodeMs": high["decodeMs"],
        "audioBlockMs": ready["framesPerDecode"] * 128 / ready["sampleRate"] * 1000,
        "latentControlDelta": latent_delta,
        "pcmDeltaRms": audio_delta,
        "spectralLogDelta": spectral_log_delta,
        "outputRms": rms,
        "voiceDbSpread": max(voice_db) - min(voice_db),
    }
    checks = {
        "liveDecoder": result["engine"] == "brave-streaming-decoder",
        "fourDimensionalLatent": result["latentSize"] == 4,
        "decoderFasterThanAudio": result["decodeMs"] < result["audioBlockMs"],
        "controlsMoveLatent": latent_delta > 0.03,
        "controlsChangePcm": audio_delta > 1e-4,
        "controlsChangeSpectrum": spectral_log_delta > 0.1,
        "nonSilentOutput": rms > 1e-4,
        "voicesLevelMatched": result["voiceDbSpread"] < 1.0,
    }
    result["checks"] = checks
    result["passed"] = all(checks.values())
    if not result["passed"]:
        raise RuntimeError(json.dumps(result, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test the running BRAVE realtime decoder service.")
    parser.add_argument("--url", default="http://127.0.0.1:4173/decoder")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.url)), indent=2))


if __name__ == "__main__":
    main()
