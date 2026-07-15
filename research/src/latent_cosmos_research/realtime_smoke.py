from __future__ import annotations

import argparse
import asyncio
import json

import numpy as np


async def run(url: str) -> dict:
    from aiohttp import ClientSession, WSMsgType

    async with ClientSession() as session:
        async with session.ws_connect(url, heartbeat=15) as ws:
            ready = json.loads((await ws.receive(timeout=15)).data)
            if ready.get("engine") != "neural-streaming-decoder":
                raise RuntimeError(f"unexpected decoder: {ready}")

            chord = [{"id": f"note-{index}", "pitchSemitones": pitch, "velocity": 0.85} for index, pitch in enumerate((0, 4, 7))]
            base = {"objectId": 0, "decoderId": ready["modelId"], "relationState": [-0.7, -0.5, -0.3, -0.4, -0.2, -0.6, -0.5, -1.0], "gate": True, "gateSerial": 1, "velocity": 1.0, "pitchSemitones": 0, "notes": chord, "latentStep": 0.5, "attackSeconds": 0.005, "releaseSeconds": 0.05, "maxDurationSeconds": 0}

            async def phase(voice: dict, revision: int) -> tuple[np.ndarray, dict]:
                await ws.send_json({"type": "control", "voices": [voice]})
                blocks: list[np.ndarray] = []
                telemetry = None
                while len(blocks) < 16 or telemetry is None or telemetry.get("revision", 0) < revision:
                    message = await ws.receive(timeout=5)
                    if message.type == WSMsgType.BINARY:
                        blocks.append(np.frombuffer(message.data, dtype="<f4").reshape(-1, 2))
                    elif message.type == WSMsgType.TEXT:
                        value = json.loads(message.data)
                        if value.get("type") == "telemetry":
                            telemetry = value
                return np.concatenate(blocks), telemetry

            low_audio, low = await phase(base, 1)
            high_audio, high = await phase(dict(base, relationState=[0.7, 0.6, 0.4, 0.8, 0.35, 0.55, 0.5, 0.7]), 2)
            raised = [{**note, "pitchSemitones": min(12, note["pitchSemitones"] + 5)} for note in chord]
            pitched_audio, pitched = await phase(dict(base, relationState=[0.7, 0.6, 0.4, 0.8, 0.35, 0.55, 0.5, 0.7], notes=raised), 3)
            drone_audio, drone = await phase(dict(base, relationState=[0.7, 0.6, 0.4, 0.8, 0.35, 0.55, 0.5, 0.7], gate=True, velocity=0.8, pitchSemitones=0, notes=[]), 4)

    low_latent = np.asarray(low["voices"][0]["latentMean"], dtype=np.float32)
    high_latent = np.asarray(high["voices"][0]["latentMean"], dtype=np.float32)
    latent_delta = float(np.linalg.norm(high_latent - low_latent))
    audio_delta = float(np.sqrt(np.mean((high_audio[: len(low_audio)] - low_audio[: len(high_audio)]) ** 2)))
    output_rms = float(np.sqrt(np.mean(high_audio**2)))
    pitch_pcm_delta = float(np.sqrt(np.mean((pitched_audio[: len(high_audio)] - high_audio[: len(pitched_audio)]) ** 2)))
    drone_tail_rms = float(np.sqrt(np.mean(drone_audio[-4096:] ** 2)))
    result = {
        "engine": ready["engine"], "modelId": ready["modelId"], "latentSize": ready["latentSize"],
        "renderMs": high["renderMs"], "audioBlockMs": ready["framesPerDecode"] * ready["samplesPerFrame"] / ready["sampleRate"] * 1000,
        "latentControlDelta": latent_delta, "pcmDeltaRms": audio_delta, "outputRms": output_rms,
        "droneTailRms": drone_tail_rms, "pitchPcmDelta": pitch_pcm_delta, "polyphony": high["voices"][0]["polyphony"], "dronePolyphony": drone["voices"][0]["polyphony"], "atlasNodes": [low["voices"][0]["atlasNode"], high["voices"][0]["atlasNode"]], "atlasDistances": [low["voices"][0]["atlasDistance"], high["voices"][0]["atlasDistance"]], "relationState": high["voices"][0]["relationState"],
    }
    result["checks"] = {
        "liveDecoder": result["engine"] == "neural-streaming-decoder",
        "fullLatentVector": len(high_latent) == ready["latentSize"] and ready["latentSize"] >= 8,
        "rendererFasterThanAudio": result["renderMs"] < result["audioBlockMs"],
        "relationsMoveLatent": latent_delta > 0.03,
        "relationsChangePcm": audio_delta > 1e-4,
        "relationsCrossAtlasNodes": low["voices"][0]["atlasNode"] != high["voices"][0]["atlasNode"],
        "keyboardPitchChangesPcm": pitch_pcm_delta > 1e-4,
        "threeNotePolyphony": high["voices"][0]["polyphony"] == 3,
        "gateProducesAudio": output_rms > 1e-4,
        "emptyKeyboardReturnsToDrone": drone_tail_rms > 1e-4 and drone["voices"][0]["polyphony"] == 1,
    }
    result["passed"] = all(result["checks"].values())
    if not result["passed"]:
        raise RuntimeError(json.dumps(result, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test the XY latent streaming decoder service.")
    parser.add_argument("--url", default="http://127.0.0.1:4174/decoder?model=fsl10k-16d")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.url)), indent=2))


if __name__ == "__main__":
    main()
