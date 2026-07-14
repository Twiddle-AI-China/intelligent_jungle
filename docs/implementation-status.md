# Implementation status

## Playable Web MVP

- Species → Flock/Voice → Boid world model.
- Three initial species, 3–6 dynamic audio voices and 2–32 boids per flock.
- Add boid, place obstacle, guide, erase and add source tools.
- Deterministic 200 Hz simulation and edit-session replay.
- Real BRAVE-derived safety-scaled texture trajectories with explicit model SHA in the UI.
- Browser regression passes with six world voices and six audio voices.

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
