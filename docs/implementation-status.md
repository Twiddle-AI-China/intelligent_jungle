# Implementation status

## Playable Web MVP

- Species → Flock/Voice → Boid world model.
- Three initial species, 3–6 dynamic audio voices and 2–32 boids per flock.
- Add boid, place obstacle, guide, erase and add source tools.
- Deterministic 200 Hz simulation and edit-session replay.
- Live BRAVE streaming TorchScript decoder with explicit streaming-model SHA in the UI.
- Flock XY and mean VX/VY directly control the four decoder latent dimensions; generated PCM streams to an AudioWorklet ring buffer.
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

- Raw model renders can exceed full scale; the Web MVP uses per-block voice calibration plus a safety limiter.
- Human listening and semantic-direction gates are not passed.
- Six-voice native hard realtime is not passed because rare deadline misses remain.
- JUCE currently contains the previous object-level world and a silent production decoder; it is not the delivered playable MVP.
- XY is not a learned PCA/UMAP view: it directly controls Z0/Z1, while mean velocity controls Z2/Z3.
- Harmony/MIDI note does not yet retune BRAVE output; direct latent-axis musicality still needs human listening.
