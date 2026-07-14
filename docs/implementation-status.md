# Implementation status

## Playable Web MVP

- Species → Flock/Voice → Boid world model.
- Three initial species, 3–6 dynamic audio voices and 2–32 boids per flock.
- Add boid, place obstacle, guide, erase and add source tools.
- Deterministic 200 Hz simulation and edit-session replay.
- Live BRAVE streaming TorchScript decoder with explicit streaming-model SHA in the UI.
- Flock controls continuously move 4D latent paths; generated PCM streams to an AudioWorklet ring buffer.
- Closed-loop buffer pacing holds browser underruns at zero in the measured 3- and 6-voice runs.
- Browser regression passes with six world voices and six audio voices.
- Asset failure is explicit and silent; the fixed-pitch oscillator fallback has been removed.
- Per-voice post-mix dB metering, mute and solo are available; endpoint RMS trim and equal-power crossfade reduce level masking.

## Model pipeline

- BRAVE Phase 1 completed at 1,000,000 steps on qgpu.
- Best/final offline and streaming TorchScript exports completed.
- Reconstruction, traversal, repeatability and amplitude safety probe completed.
- Apple M4 1/6-voice bake-off completed.

## Open gates

- Raw model renders can exceed full scale; the Web MVP uses pair-wise safety gain.
- Human listening and semantic-direction gates are not passed.
- Six-voice native hard realtime is not passed because rare deadline misses remain.
- JUCE currently contains the previous object-level world and a silent production decoder; it is not the delivered playable MVP.
- XY is not a learned latent projection; the current explicit perceptual-to-4D mapping does perform online latent control and decoding.
- Harmony/MIDI note does not yet retune BRAVE textures, and most perceptual dimensions are not fully audible.
