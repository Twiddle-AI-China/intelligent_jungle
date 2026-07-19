# Headless mechanism evaluation

Run the deterministic 24-day scoreboard:

```sh
node mvp/eval/run.js
```

Optional flags are `--seed <integer>`, `--days <integer>` (minimum acceptance run is 20),
and `--json`. The three tiers use the same seeded PRNG: R freezes autonomous behavior and
randomly drives public perch/unperch APIs; C runs the world species instincts without agent or
master; F additionally attaches the existing economy observers and rule/master conductor, with
no LLM pipeline.

All measurements are derived from the emitted perch/unperch/dawn stream. Primary scores are
higher-is-better proxies: rescaled harmony mean/consistency, preference-band behavior score,
beat-grid adherence, density complementarity (half-beat bins with one or two active voices), and
pitch-motion balance. The diagnostic table retains raw variance, grid error, conflict/blank ratios,
and same/step/leap interval proportions so a composite score cannot hide a regression.
