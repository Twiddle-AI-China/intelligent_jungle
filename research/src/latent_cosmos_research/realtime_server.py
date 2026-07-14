from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


SPECIES = ("pulse", "resonance", "texture")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class VoiceControl:
    object_id: int
    species: str
    perceptual: np.ndarray
    pan: float
    energy: float
    muted: bool
    solo: bool


@dataclass
class ClientState:
    voices: list[VoiceControl] = field(default_factory=list)
    phases: dict[int, float] = field(default_factory=dict)
    previous_offsets: dict[int, np.ndarray] = field(default_factory=dict)
    latent_means: dict[int, list[float]] = field(default_factory=dict)
    revision: int = 0
    buffered_frames: int = 0
    underruns: int = 0


class BraveRealtimeDecoder:
    def __init__(self, streaming_model: Path, offline_model: Path, corpus: Path, frames: int = 8) -> None:
        import soundfile as sf
        import torch
        import torchaudio

        torch.set_num_threads(2)
        self.torch = torch
        self.frames = frames
        self.sample_rate = 44_100
        self.model_path = streaming_model
        self.model_sha = sha256(streaming_model)
        self.model = torch.jit.load(str(streaming_model), map_location="cpu").eval()
        self.sample_rate = int(self.model.sr)
        self.latent_size = int(self.model.latent_size)
        if self.latent_size != 4:
            raise RuntimeError(f"expected 4D BRAVE latent, got {self.latent_size}")

        encoder = torch.jit.load(str(offline_model), map_location="cpu").eval()
        self.paths: dict[str, object] = {}
        self.scales: dict[str, object] = {}
        with torch.inference_mode():
            for species in SPECIES:
                audio, source_rate = sf.read(corpus / f"{species}.wav", dtype="float32")
                audio = np.asarray(audio)
                if audio.ndim > 1:
                    audio = audio.mean(axis=1)
                tensor = torch.from_numpy(audio)[None, :]
                if source_rate != self.sample_rate:
                    tensor = torchaudio.functional.resample(tensor, source_rate, self.sample_rate)
                # Two seconds provide a non-static latent trajectory while keeping
                # local startup fast enough for an instrument workflow.
                tensor = tensor[:, : self.sample_rate * 2]
                latent = encoder.encode(tensor[None, :]).squeeze(0).contiguous()
                if latent.shape[0] != self.latent_size or latent.shape[-1] < self.frames * 2:
                    raise RuntimeError(f"invalid latent path for {species}: {tuple(latent.shape)}")
                self.paths[species] = latent
                self.scales[species] = latent.std(dim=-1).clamp_min(0.05)
        del encoder

    def new_session(self) -> "BraveRealtimeDecoder":
        session = object.__new__(BraveRealtimeDecoder)
        session.torch = self.torch
        session.frames = self.frames
        session.sample_rate = self.sample_rate
        session.model_path = self.model_path
        session.model_sha = self.model_sha
        session.latent_size = self.latent_size
        session.paths = self.paths
        session.scales = self.scales
        session.model = self.torch.jit.load(str(self.model_path), map_location="cpu").eval()
        return session

    def _voice_latent(self, control: VoiceControl, state: ClientState) -> object:
        torch = self.torch
        path = self.paths.get(control.species, self.paths["texture"])
        scale = self.scales.get(control.species, self.scales["texture"])
        length = path.shape[-1]
        phase = state.phases.get(control.object_id, float((control.object_id * 97) % length))
        speed = 0.65 + float(np.clip(control.energy, 0.0, 1.0)) * 1.35
        positions = (phase + np.arange(self.frames, dtype=np.float32) * speed) % length
        left = np.floor(positions).astype(np.int64)
        right = (left + 1) % length
        fraction = torch.from_numpy(positions - left).to(dtype=path.dtype)[None, :]
        base = path[:, left] * (1.0 - fraction) + path[:, right] * fraction
        state.phases[control.object_id] = float((phase + self.frames * speed) % length)

        p = np.pad(control.perceptual.astype(np.float32), (0, max(0, 6 - len(control.perceptual))), constant_values=0.5)
        raw_offset = np.asarray([
            p[0] - 0.5,
            (p[1] + p[2]) * 0.5 - 0.5,
            p[4] - 0.5,
            p[5] - 0.5,
        ], dtype=np.float32)
        target_offset = torch.from_numpy(raw_offset).to(dtype=path.dtype) * scale * 0.55
        previous = state.previous_offsets.get(control.object_id)
        if previous is None:
            previous = target_offset.detach().cpu().numpy()
        ramp = np.linspace(0.0, 1.0, self.frames, dtype=np.float32)[None, :]
        offset = torch.from_numpy(previous[:, None] * (1.0 - ramp) + target_offset.cpu().numpy()[:, None] * ramp)
        state.previous_offsets[control.object_id] = target_offset.detach().cpu().numpy()
        latent = base + offset.to(dtype=base.dtype)
        state.latent_means[control.object_id] = latent.mean(dim=-1).detach().cpu().tolist()
        return latent

    def decode(self, state: ClientState) -> tuple[np.ndarray, list[dict[str, float]], float]:
        torch = self.torch
        controls = state.voices[:6]
        if not controls:
            samples = self.frames * 128
            return np.zeros((samples, 2), dtype=np.float32), [], 0.0
        latent = torch.stack([self._voice_latent(control, state) for control in controls])
        started = time.perf_counter()
        with torch.inference_mode():
            decoded = self.model.decode(latent).detach().cpu().numpy()[:, 0]
        decode_ms = (time.perf_counter() - started) * 1000.0

        any_solo = any(control.solo for control in controls)
        mix = np.zeros((decoded.shape[-1], 2), dtype=np.float32)
        levels: list[dict[str, float]] = []
        for audio, control in zip(decoded, controls, strict=True):
            raw_rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
            target_gain = float(np.clip(0.08 / max(raw_rms, 1e-5), 0.15, 12.0))
            # Decoder loudness is calibrated per block; musical dynamics are
            # applied afterwards from Flock energy, so source identity cannot
            # dominate merely because its training anchor is 20 dB louder.
            calibration = target_gain
            audio = audio * calibration
            rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
            levels.append({"rms": rms, "rawRms": raw_rms, "calibrationGain": calibration})
            audible = not control.muted and (not any_solo or control.solo)
            if not audible:
                continue
            # Slow musical energy remains in the control mapping; the limiter only
            # protects the output and does not synthesize or replace model audio.
            level = 0.35 + float(np.clip(control.energy, 0.0, 1.0)) * 0.65
            pan = float(np.clip(control.pan, -1.0, 1.0))
            left = math.cos((pan + 1.0) * math.pi * 0.25)
            right = math.sin((pan + 1.0) * math.pi * 0.25)
            mix[:, 0] += audio * level * left
            mix[:, 1] += audio * level * right
        mix = np.tanh(mix * (0.9 / math.sqrt(max(1, len(controls))))).astype(np.float32)
        return mix, levels, decode_ms


def parse_controls(payload: dict) -> list[VoiceControl]:
    controls = []
    for index, item in enumerate(payload.get("voices", [])[:6]):
        controls.append(VoiceControl(
            object_id=int(item.get("objectId", index)),
            species=str(item.get("species", "texture")),
            perceptual=np.asarray(item.get("perceptual", [0.5] * 6), dtype=np.float32)[:6],
            pan=float(item.get("pan", 0.0)),
            energy=float(item.get("energy", 0.5)),
            muted=bool(item.get("muted", False)),
            solo=bool(item.get("solo", False)),
        ))
    return controls


async def run_server(args: argparse.Namespace) -> None:
    from aiohttp import WSMsgType, web

    root = args.root.resolve()
    print(f"Loading BRAVE streaming decoder: {args.model}", flush=True)
    decoder = BraveRealtimeDecoder(args.model, args.offline_model, args.corpus, args.frames)
    print(f"BRAVE ready: {decoder.model_sha[:8]} · {decoder.sample_rate} Hz · {decoder.latent_size}D", flush=True)

    async def status(_request: web.Request) -> web.Response:
        return web.json_response({
            "engine": "brave-streaming-decoder",
            "modelSha256": decoder.model_sha,
            "sampleRate": decoder.sample_rate,
            "latentSize": decoder.latent_size,
            "framesPerDecode": decoder.frames,
            "samplesPerDecode": decoder.frames * 128,
            "liveDecoder": True,
        })

    async def index(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(root / "index.html")

    async def favicon(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(root / "favicon.svg")

    async def websocket(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=15.0, max_msg_size=64 * 1024)
        await ws.prepare(request)
        state = ClientState()
        session_model = decoder.new_session()
        await ws.send_json({
            "type": "ready",
            "engine": "brave-streaming-decoder",
            "modelSha256": session_model.model_sha,
            "sampleRate": session_model.sample_rate,
            "latentSize": session_model.latent_size,
            "framesPerDecode": session_model.frames,
        })

        async def receive() -> None:
            async for message in ws:
                if message.type == WSMsgType.TEXT:
                    try:
                        payload = json.loads(message.data)
                        if payload.get("type") == "control":
                            state.voices = parse_controls(payload)
                            state.revision += 1
                        elif payload.get("type") == "buffer":
                            state.buffered_frames = max(0, int(payload.get("bufferedFrames", 0)))
                            state.underruns = max(0, int(payload.get("underruns", 0)))
                    except (ValueError, TypeError):
                        await ws.send_json({"type": "error", "message": "invalid control frame"})
                elif message.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break

        receiver = asyncio.create_task(receive())
        block_seconds = session_model.frames * 128 / session_model.sample_rate
        block_index = 0
        try:
            while not ws.closed:
                if not state.voices:
                    await asyncio.sleep(0.005)
                    continue
                started = time.perf_counter()
                audio, levels, decode_ms = session_model.decode(state)
                await ws.send_bytes(audio.astype("<f4", copy=False).tobytes())
                block_index += 1
                if block_index % 8 == 0:
                    await ws.send_json({
                        "type": "telemetry",
                        "decodeMs": decode_ms,
                        "voices": [
                            {
                                **value,
                                "db": 20 * math.log10(max(value["rms"], 1e-7)),
                                "latentMean": state.latent_means.get(control.object_id, []),
                            }
                            for value, control in zip(levels, state.voices[:6], strict=True)
                        ],
                        "revision": state.revision,
                        "bufferedFrames": state.buffered_frames,
                        "underruns": state.underruns,
                    })
                elapsed = time.perf_counter() - started
                if state.buffered_frames < 4096:
                    pacing = 0.35
                elif state.buffered_frames > 12288:
                    pacing = 1.2
                else:
                    pacing = 0.97
                await asyncio.sleep(max(0.0, block_seconds * pacing - elapsed))
        finally:
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass
        return ws

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    app.router.add_get("/favicon.svg", favicon)
    app.router.add_get("/api/decoder-status", status)
    app.router.add_get("/decoder", websocket)
    app.router.add_static("/src/", root / "src", show_index=False)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()
    print(f"Realtime MVP: http://{args.host}:{args.port}", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Web MVP with a live BRAVE streaming decoder.")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--offline-model", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--frames", type=int, default=8)
    args = parser.parse_args()
    try:
        asyncio.run(run_server(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
