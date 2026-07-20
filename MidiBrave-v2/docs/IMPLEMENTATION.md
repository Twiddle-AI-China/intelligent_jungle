# MidiBrave implementation contract

This repository implements the approved 44.1 kHz dual-branch sustain-synthesis design.

- Raw Serum renders retain silence, attack, sustain, note-off, and release. CLAP and QA use the
  full render. Decoder targets are 49,152-sample windows containing at least 75% frames with
  CREPE periodicity >= 0.5 and pitch error <= 50 cents; the remaining waveform is still rebuilt,
  while unreliable frames are masked only from differentiable pitch loss. This matches the
  published dataset's sparse voiced-frame contract without discarding modulation-heavy timbres.
- MIDI conditioning is exactly note and velocity. The neural decoder has no gate, pitch bend,
  ADSR, onset/offset, legato, release, or take field. The host owns the performance envelope.
- The 32-D frame condition enters an explicit 160->1024->1024 fusion projection and every
  decoder block through an independent, identity-initialized temporal FiLM.
- MIDI note deterministically renders a fixed-RMS harmonic excitation (no learned envelope or
  extra label). The matched 16-band PQMF representation is causally downsampled and injected by
  a separate identity-initialized FiLM at all BRAVE rates `[2x, 4x, 8x, 8x]`; this supplies the
  waveform phase clock that a constant sustain condition cannot provide. Velocity is not baked
  into excitation gain and remains learned from the two rendered velocity endpoints.
- Both branches are phase-agnostic. Sample waveform and voiced losses are absent by design.
- Reconstruction uses fullband plus true 16-band PQMF MR-STFT, multi-scale envelope/delta,
  generated-waveform dB RMS, and frozen differentiable CREPE pitch. The pitch objective combines
  soft-bin cents, optional relative KL, absolute target-bin activation matched to real target
  confidence, a hard-negative margin, and a one-sided target-period autocorrelation deficit.
  CREPE frame normalization has a detached 0.01 scale floor so near-silent decoder output cannot
  create unbounded pitch gradients. Autocorrelation is target matched and is not a gate/voicing
  label.
- Envelope windows are 1024/4096/16384 samples; the shortest exceeds one MIDI-36 period, so
  independently cropped oscillator phase is not accidentally reintroduced as a waveform loss.
- Velocity ranking is computed only for same-note, different-velocity pairs with a valid real
  loudness direction. Equal-velocity and different-note pairs contribute exactly zero.
- Phase 2 uses the three-scale BRAVE Conv1d discriminator (1,940,451 parameters); the former
  33,529,288-parameter scale+period discriminator has been removed. Feature matching compares each
  layer's temporal mean, log-standard-deviation, and log-delta-energy rather than pointwise
  activations, so it cannot silently reintroduce target phase alignment. Its outer weight is 2.0
  (not the pointwise-FM value 10.0) because these log-statistics start around 2-3. G and D accumulate the
  same microbatches. Generator feature-matching forwards concatenate self/cross batches to avoid
  duplicate discriminator launches. Checkpoint format 3 preserves per-rank RNG, exact sampler
  position, effective G/D update counters, hashes, and the discriminator architecture ID.
- AMP overflow is an atomic G/D decision across every DDP rank. A skipped loop changes neither
  optimizer, does not consume the requested update budget, and lowers the shared scaler. Learning
  rate, adversary ramp, and checkpoints are indexed by effective generator updates.
- The published Serum release is sparse. Training uses final audited `midi_note`, accepts valid
  repeated observations, never treats missing cells as negatives, and samples exact 50/25/25
  pitch-only, velocity-only, and pitch+velocity modes without arbitrary fallback pairs.
- Cache outputs are written atomically. The frozen eligible-manifest metadata records source,
  manifest, CLAP checkpoint, CLAP cache, and pitch cache SHA-256 values.
- Boids is intentionally absent from training and will replace the timbre-latent source only at
  inference.

The strict published view filters five-second renders whose sent notes are MIDI 36-71, but final
audited labels span MIDI 21-109 and the surviving grid is intentionally sparse. Run preprocessing,
freeze cache eligibility, generate the final config, then validate:

```bash
midibrave preprocess --config configs/quality300.yaml --stage all --device cuda
midibrave finalize-cache --config configs/quality300.yaml \
  --output-manifest /data/midibrave/manifests/serum_quality300_eligible_optimized.jsonl \
  --output-metadata /data/midibrave/manifests/serum_quality300_eligible_optimized.meta.json
python scripts/generate_quality_config.py --base configs/quality300.yaml \
  --manifest /data/midibrave/manifests/serum_quality300_eligible_optimized.jsonl \
  --metadata /data/midibrave/manifests/serum_quality300_eligible_optimized.meta.json \
  --output configs/quality300_c9_optimized.yaml
midibrave validate --config configs/quality300_c9_optimized.yaml
```

`configs/full_c9_optimized.yaml` and `configs/quality300_c9_optimized.yaml`
share the exact validated C9 loss. The quality-first full-compute profile is
isolated under `training_profiles/pre_time_optimization_c9/`. It retains
algebra-preserving runtime optimizations while restoring Self on every update
and the 1,000,000 + 250,000 update budget, so A/B comparisons isolate compute
and exposure-budget changes.

Architecture reference lock: BRAVE commit `4a5f290fc464ebb85e519f2c0dad4a4d3a08624a` and
`acids-rave==2.3.1`. The decoder remains self-contained to avoid the incompatible RAVE runtime
dependency set.
