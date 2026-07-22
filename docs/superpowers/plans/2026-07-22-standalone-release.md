# Standalone Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `beta` 整理为可独立部署的 `intelligent_jungle`：神经音源一键安装与启动，浏览器只访问同源服务，并通过一份无密钥配置在外部本地 LLM、云端 LLM 和确定性规则间切换。

**Architecture:** `flock-voice-engine` 的 aiohttp 服务同时提供静态前端、神经音频 WebSocket 和 OpenAI 兼容 Agent 反向代理。仓库跟踪前后端、vendor 源码与音色校准资源；四个神经音源权重由固定 GitHub Release 下载并校验；vLLM 与 LLM 权重始终是仓库外部依赖。

**Tech Stack:** JavaScript ES modules、Node.js 20 `node:test`、Python 3.12、aiohttp、Docker、NVIDIA Container Toolkit、DGX Spark CUDA 13、POSIX shell、GitHub Releases。

## Global Constraints

- 首要验收平台为 NVIDIA DGX Spark（aarch64、CUDA 13）；普通电脑仅保证前端与 WebAudio 回退可运行。
- `config/runtime.json` 是唯一需要编辑的运行配置，`agent.mode` 只允许 `local`、`cloud`、`rules`。
- local 模式沿用当前 `bird_agent` 与 OpenAI `/v1` 契约；仓库不包含 vLLM 镜像、框架源码或任何 LLM 权重。
- cloud 密钥只从 `LCS_AGENT_API_KEY` 读取，不得进入 Git、JSON、浏览器、状态接口或日志。
- 神经音源生产参数固定为 `brave-voices`、`cuda`、`poolSize=5`、`blockSamples=4096`。
- 四个 `.pt` 音源权重不进入 Git 历史，只能从 `neural-audio-v1` Release 下载且必须通过 SHA-256。
- 所有宿主机路径从仓库根目录推导；运行代码不得依赖 `/srv/deploy`、`/home/rolf` 或宿主机 `/data/model_weights`。
- 不修改远程 DGX 现有 8081、8083 或其他用户容器；本任务只生成独立发行版。
- 文档和新增注释使用中文；每个行为变化先看到测试按预期失败，再写最小实现。

---

## File Responsibility Map

- `config/runtime.json`：公开、无密钥的 HTTP、音频和 Agent 模式配置。
- `config/model-assets.json`：音源 Release tag、文件大小和 SHA-256 的机器可读清单。
- `flock-voice-engine/server/runtime_config.py`：严格解析配置并解析当前 Agent 上游。
- `flock-voice-engine/server/agent_proxy.py`：同源 OpenAI 兼容代理与脱敏状态。
- `flock-voice-engine/server/paths.py`：模型和日志的项目相对路径。
- `flock-voice-engine/server/app.py`：装配音频、静态站点、Agent 路由和状态接口。
- `scripts/assemble_web.py`：确定性生成 `runtime/web/`。
- `scripts/model_assets.py`：curl 断点续传、大小/SHA 校验和原子落盘。
- `scripts/doctor.sh`：DGX、Docker、NVIDIA runtime、宿主 Torch/CUDA 前置检查。
- `scripts/setup.sh`：doctor、权重下载、web 组装和镜像构建。
- `scripts/start.sh`、`stop.sh`、`status.sh`、`logs.sh`：项目相对的容器生命周期。
- `scripts/verify_runtime.py`、`scripts/verify.sh`：HTTP、静态资源、配置与真实 PCM 验收。
- `test/release-layout.test.js`：公开发行树、禁止产物和无秘密约束。
- `flock-voice-engine/tests/test_runtime_config.py`：三种 Agent 模式配置契约。
- `flock-voice-engine/tests/test_agent_proxy.py`：本地/云端代理、流式响应、超时与脱敏。
- `scripts/tests/test_model_assets.py`：权重下载器的续传、校验和原子性。
- `scripts/tests/test_assemble_web.py`：前端组装内容与同源配置。

---

### Task 1: Release tree and production asset inventory

**Files:**
- Create: `test/release-layout.test.js`
- Create: `config/model-assets.json`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `.gitignore`
- Track: `flock-voice-engine/vendor/{midibrave,midibrave-v2,trajectorybrave}`
- Track: `flock-voice-engine/assets/timbre/voice_defaults/*.npy`
- Track: `flock-voice-engine/model_weights/midiBrave/SHA256SUMS`

**Interfaces:**
- Produces model manifest shape `{version, releaseTag, baseUrl, assets[]}` where every asset has `filename`, `bytes`, and `sha256`.
- Produces a Git tree in which production calibration `.npy` files are tracked but `.pt`, fixture audio, caches, `.pyc`, `.wav`, and vendor `.npz` are not.

- [ ] **Step 1: Write the failing release-layout test**

  Assert that the manifest contains exactly the four production files and fixed hashes, notices name all three vendors, voice defaults are not ignored, `.pt` files are ignored, and `git ls-files` contains none of `vendor/**/{__pycache__,fixtures/generated}` or `*.{pt,wav,npz,pyc}`.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/release-layout.test.js`

  Expected: FAIL because `config/model-assets.json` and `THIRD_PARTY_NOTICES.md` do not exist.

- [ ] **Step 3: Add the exact asset manifest**

  Use release tag `neural-audio-v1`, base URL `https://github.com/Twiddle-AI-China/intelligent_jungle/releases/download/neural-audio-v1`, and these records:

  | filename | bytes | sha256 |
  |---|---:|---|
  | `bass_latest.pt` | 98348246 | `3b507d98d898022ac27175048094fb48b31f70aad77b9c452b69b3ed32a39165` |
  | `lead_latest.pt` | 98338102 | `90d2b33316bbdcda7d1d35280f8c9c06a80b57499b7db26daef2c3ab587f10e9` |
  | `pluck_latest.pt` | 98338102 | `7176c0a84fd179c70d669867f77b741a64237c27c90b782232b28bc1343ca0ab` |
  | `trajectorybrave-pad-v1-step-035000.pt` | 101808480 | `644bf99d2463af136e2819b780657d9502bbbb7b2f0f055a4a9c7da46c7f4b1b` |

- [ ] **Step 4: Tighten ignore rules and write provenance**

  Ignore `runtime/`, `.env*`, local logs, all audio `.pt`, vendor binary fixtures/caches, and explicitly unignore `voice_defaults/*.npy` plus `model_weights/midiBrave/SHA256SUMS`. In `THIRD_PARTY_NOTICES.md`, record the three production snapshots, snapshot date `2026-07-22`, purpose, preserved upstream filenames, and the user-confirmed authorization to publish these snapshots.

- [ ] **Step 5: Verify GREEN and commit**

  Run: `node --test test/release-layout.test.js`

  Expected: PASS with no forbidden tracked artifact.

  Commit: `chore: add standalone release asset inventory`

---

### Task 2: Strict single-file runtime configuration

**Files:**
- Create: `config/runtime.json`
- Create: `flock-voice-engine/server/runtime_config.py`
- Create: `flock-voice-engine/server/paths.py`
- Create: `flock-voice-engine/tests/test_runtime_config.py`
- Modify: `flock-voice-engine/server/config.py`
- Modify: `flock-voice-engine/server/backends/midibrave_backend.py`
- Modify: `flock-voice-engine/server/backends/midibrave_backend_v2.py`
- Modify: `flock-voice-engine/server/backends/trajectorybrave_pad.py`

**Interfaces:**
- Produces `load_runtime_config(path: str | Path, environ: Mapping[str, str] | None = None) -> RuntimeSettings`.
- Produces immutable `ResolvedAgent(mode, base_url, model, api_key)`; `RuntimeSettings.agent` is `None` in rules mode.
- Produces `ENGINE_ROOT`, `MODEL_DIR`, and `LOAD_LOG_PATH` from environment overrides or repository-relative defaults.

- [ ] **Step 1: Write failing config tests**

  Cover: initial local config resolves `bird_agent`; rules accepts empty local/cloud sections; cloud without `LCS_AGENT_API_KEY` fails; cloud with key resolves but `repr()` omits it; unknown keys fail; non-HTTP URL fails; `poolSize=0`, `blockSamples<64`, and invalid mode fail.

- [ ] **Step 2: Verify RED**

  Run: `python -m unittest flock-voice-engine/tests/test_runtime_config.py -v`

  Expected: ERROR importing `server.runtime_config`.

- [ ] **Step 3: Implement strict dataclasses and parser**

  Define `RuntimeConfigError(ValueError)`, `ResolvedAgent`, and `RuntimeSettings(engine: EngineConfig, agent: ResolvedAgent | None, timeout_seconds: float)`. Reject unknown keys at every object level. Resolve only the selected provider. Normalize `baseUrl` by removing trailing `/`; require scheme `http` or `https` and a network location. Store `api_key` with `repr=False`.

- [ ] **Step 4: Add the initial public config**

  Set HTTP `0.0.0.0:8090`; audio `brave-voices/cuda/poolSize=5/blockSamples=4096`; agent `mode=local`, timeout 60; local endpoint `http://host.docker.internal:8081/v1`, model `bird_agent`; cloud base/model empty and `apiKeyEnv=LCS_AGENT_API_KEY`.

- [ ] **Step 5: Remove machine-specific model paths**

  Default `MODEL_DIR` to `<flock-voice-engine>/model_weights/midiBrave`, permit `LCS_MODEL_DIR`, and use it in all three backend modules. Default load log to `<repo>/runtime/logs/flock-voice-load.jsonl`, permit `LCS_LOAD_LOG_PATH`. Add `strict_backend: bool = False` to `EngineConfig`; runtime JSON always sets it `True` so a missing neural backend cannot silently become synth.

- [ ] **Step 6: Verify GREEN and commit**

  Run: `python -m unittest flock-voice-engine/tests/test_runtime_config.py -v`

  Expected: all config/path tests PASS and no secret appears in assertion output.

  Commit: `feat: add strict standalone runtime configuration`

---

### Task 3: Same-origin local/cloud Agent proxy

**Files:**
- Create: `flock-voice-engine/server/agent_proxy.py`
- Create: `flock-voice-engine/tests/test_agent_proxy.py`
- Modify: `flock-voice-engine/server/app.py`

**Interfaces:**
- Produces `register_agent_routes(app: web.Application, agent: ResolvedAgent | None, timeout_seconds: float) -> AgentProxyState`.
- Registers `GET /api/agent/v1/models`, `POST /api/agent/v1/chat/completions`, and exposes `AgentProxyState.public_status() -> dict[str, object]` without URL or key.
- Preserves request `messages`, `temperature`, `max_tokens`, and `response_format`; replaces only `model` with the selected configured model.

- [ ] **Step 1: Write failing proxy tests with a real local aiohttp upstream**

  Test local forwarding without `Authorization`; cloud forwarding with `Authorization: Bearer test-cloud-key`; model replacement; JSON response pass-through; SSE bytes and `text/event-stream` pass-through; rules mode returns 503 so the existing browser client falls back; timeout returns 504; runtime status never contains endpoint or key.

- [ ] **Step 2: Verify RED**

  Run: `python -m unittest flock-voice-engine/tests/test_agent_proxy.py -v`

  Expected: ERROR importing `server.agent_proxy`.

- [ ] **Step 3: Implement the bounded proxy**

  Use one `aiohttp.ClientSession` owned by the application cleanup context, `ClientTimeout(total=timeout_seconds)`, a 2 MiB request-body limit, and chunked response copying. For cloud only, inject the bearer header. Return sanitized JSON errors `{error:{type,message}}`; never include the caught exception text if it can contain a URL or header.

- [ ] **Step 4: Integrate runtime boot and status**

  When `LCS_RUNTIME_CONFIG` is set, `app.main()` loads `RuntimeSettings`; `LCS_STATIC_ROOT` selects static web. Change `build_app` to accept resolved Agent settings, register proxy routes before the static catch-all, and add `GET /api/runtime-status` with audio backend, `neural|fallback`, Agent mode, availability, and sanitized last error class. If `strict_backend` is true and the loaded backend ID differs from the requested ID, raise before binding the port.

- [ ] **Step 5: Verify GREEN and regressions; commit**

  Run: `python -m unittest flock-voice-engine/tests/test_runtime_config.py flock-voice-engine/tests/test_agent_proxy.py -v`

  Run: `npm run test:mvp`

  Expected: Python proxy/config tests PASS; all 404 MVP tests PASS.

  Commit: `feat: proxy local and cloud agents through one runtime config`

---

### Task 4: Deterministic web assembly and browser endpoint isolation

**Files:**
- Create: `scripts/assemble_web.py`
- Create: `scripts/tests/test_assemble_web.py`
- Modify: `mvp/runtime-config.js`
- Modify: `mvp/runtime-config.example.js`
- Modify: `mvp/src/main.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces `assemble(root: Path, output: Path) -> None`.
- Generated `runtime/web/runtime-config.js` contains only `window.LCS_RUNTIME = { stepfunBase: '/api/agent' };`.
- Copies `mvp/index.html`, `src/`, `eval/`, `assets/` and maps `flock-voice-engine/client/` to `_client/`.

- [ ] **Step 1: Write failing assembly tests**

  Build into a temporary directory and assert `index.html`, `src/main.js`, `_client/voice-client.js`, `_client/pcm-player-worklet.js`, and `runtime-config.js` exist. Assert generated JavaScript has `/api/agent` and contains neither `8081`, `apiKey`, `Authorization`, `deepseek`, nor a provider URL.

- [ ] **Step 2: Verify RED**

  Run: `python -m unittest scripts/tests/test_assemble_web.py -v`

  Expected: ERROR because `scripts.assemble_web` does not exist.

- [ ] **Step 3: Implement atomic assembly**

  Copy into `<output>.tmp`, write the fixed same-origin runtime config in UTF-8, then replace the output directory. Resolve both paths and reject an output outside the repository root. Do not copy `mvp/local-config.js`, test files, screenshots, or generated assets.

- [ ] **Step 4: Point source runtime config to the same-origin proxy**

  Keep provider selection out of JavaScript. Preserve the current `BirdAgentClient` schemas and fallback chain; only replace the deployment base URL with `/api/agent`. Health failure must continue to choose deterministic rules without blocking simulation startup.

- [ ] **Step 5: Verify GREEN and commit**

  Run: `python -m unittest scripts/tests/test_assemble_web.py -v`

  Run: `npm run test:mvp`

  Expected: assembly tests and 404 MVP tests PASS.

  Commit: `feat: assemble same-origin standalone web runtime`

---

### Task 5: Resumable verified neural-audio model installer

**Files:**
- Create: `scripts/model_assets.py`
- Create: `scripts/tests/test_model_assets.py`

**Interfaces:**
- Produces `install_assets(manifest_path: Path, output_dir: Path, base_url: str | None = None, runner: Callable = subprocess.run) -> list[Path]`.
- CLI: `python scripts/model_assets.py install --manifest config/model-assets.json --output flock-voice-engine/model_weights/midiBrave`.

- [ ] **Step 1: Write failing downloader tests**

  Use a temporary manifest and runner that writes deterministic bytes. Assert valid existing files skip curl; partial files invoke `curl -fL -C -`; wrong byte count or SHA leaves no final file; successful verification uses `os.replace`; `LCS_MODEL_RELEASE_BASE_URL` overrides only the base URL and never the checksum.

- [ ] **Step 2: Verify RED**

  Run: `python -m unittest scripts/tests/test_model_assets.py -v`

  Expected: ERROR importing `scripts.model_assets`.

- [ ] **Step 3: Implement download and verification**

  Download each asset to `<filename>.part` with curl arguments `-fL -C - --retry 5 --retry-delay 2`; validate exact byte count and SHA-256; atomically replace the final file. On a range-resume error, retry that `.part` once from byte zero. Re-validate all final files before returning success.

- [ ] **Step 4: Verify against the production files already present**

  Run: `python scripts/model_assets.py verify --manifest config/model-assets.json --output flock-voice-engine/model_weights/midiBrave`

  Expected: four `OK` lines and exit code 0.

- [ ] **Step 5: Run unit tests and commit**

  Run: `python -m unittest scripts/tests/test_model_assets.py -v`

  Expected: all installer tests PASS.

  Commit: `feat: install verified neural audio release assets`

---

### Task 6: DGX setup and project-relative container lifecycle

**Files:**
- Create: `scripts/common.sh`
- Create: `scripts/doctor.sh`
- Create: `scripts/setup.sh`
- Create: `scripts/start.sh`
- Create: `scripts/stop.sh`
- Create: `scripts/status.sh`
- Create: `scripts/logs.sh`
- Modify: `flock-voice-engine/deploy/Dockerfile`
- Replace: `flock-voice-engine/deploy/docker-run.sh`
- Create: `test/release-scripts.test.js`

**Interfaces:**
- `common.sh` exports repository-relative `LCS_ROOT`, container name `latent-cosmos-synth`, image `latent-cosmos-synth:local`, host port `8090`, and host site-packages path `/usr/local/lib/python3.12/dist-packages`, each overridable by an `LCS_*` environment variable.
- `setup.sh` runs doctor, model install, web assembly, then Docker build.
- `start.sh` validates model hashes, starts one container, waits for `/healthz`, and prints recent logs on failure.

- [ ] **Step 1: Write failing script contract tests**

  Assert all scripts exist and pass `bash -n`; scan runtime scripts and `server/` for `/srv/deploy`, `/home/rolf`, hard-coded UID `1005`, or host `/data/model_weights`; assert Docker launch includes `--gpus all`, `host.docker.internal:host-gateway`, read-only repository mounts, `OMP_NUM_THREADS=16`, CPU shares `262144`, runtime config, local model directory, and static web directory.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/release-scripts.test.js`

  Expected: FAIL because root lifecycle scripts do not exist and old deploy paths are present.

- [ ] **Step 3: Implement doctor and setup**

  `doctor.sh` must require Linux `aarch64`, Docker daemon, NVIDIA runtime, the configured host Python 3.12 site-packages directory, and a CUDA-enabled Torch whose CUDA major version is 13. It must print one actionable Chinese failure per missing prerequisite. `setup.sh` must not install vLLM or LLM weights.

- [ ] **Step 4: Implement project-relative lifecycle**

  Mount repository paths to `/app/server`, `/app/vendor`, `/app/assets`, `/app/model_weights/midiBrave`, `/app/web`, `/app/config`, and `/app/runtime`; mount host Torch at `/opt/host-site-packages`; use the current user ID/group; set `LCS_RUNTIME_CONFIG=/app/config/runtime.json`, `LCS_STATIC_ROOT=/app/web`, `LCS_MODEL_DIR=/app/model_weights/midiBrave`, and a runtime log path. Map host port to container 8090 and never probe alternative ports.

- [ ] **Step 5: Verify GREEN and commit**

  Run: `node --test test/release-scripts.test.js`

  Run: `bash -n scripts/*.sh flock-voice-engine/deploy/docker-run.sh`

  Expected: all contract tests PASS and shell parsing exits 0.

  Commit: `feat: add turnkey DGX setup and lifecycle scripts`

---

### Task 7: End-to-end release verification

**Files:**
- Create: `scripts/verify_runtime.py`
- Create: `scripts/verify.sh`
- Create: `flock-voice-engine/tests/test_synth_runtime.py`
- Modify: `package.json`

**Interfaces:**
- `verify_runtime.py BASE_URL` verifies HTTP JSON/static assets and opens `/decoder?split=1`, sends a note event, and requires a finite non-zero float32 PCM block.
- `verify.sh` validates hashes, container state, runtime status, `brave-voices`, pool 5, block 4096, pad rows `[1,4]`, static assets, Agent route behavior, and neural PCM.
- `npm run test:release` runs release layout/scripts plus all new Python unit tests.

- [ ] **Step 1: Write failing synth runtime smoke test**

  Start `build_app(EngineConfig(backend='synth', port=0))` through aiohttp test utilities; assert `/healthz`, `/api/decoder-status`, `/api/runtime-status`; open WebSocket, send one legal note, and assert at least one returned PCM frame has a non-zero finite sample.

- [ ] **Step 2: Verify RED**

  Run: `python -m unittest flock-voice-engine/tests/test_synth_runtime.py -v`

  Expected: FAIL because the new runtime-status/verification contract is incomplete.

- [ ] **Step 3: Implement reusable verifier and release command**

  Use aiohttp and NumPy already present in the server image. `verify.sh` runs the Python verifier inside the running container so the DGX host needs no extra pip packages. For rules mode, require Agent models route 503 and runtime status `mode=rules`; for local/cloud, require same-origin route reachability without exposing credentials.

- [ ] **Step 4: Add package scripts and verify GREEN**

  Add `test:release` and `verify:release` without changing legacy commands.

  Run: `npm run test:release`

  Run: `npm test && npm run test:mvp`

  Expected: release tests pass; legacy 34 and MVP 404 remain green.

- [ ] **Step 5: Commit**

  Commit: `test: add standalone release verification`

---

### Task 8: Operator documentation and public-repository security gate

**Files:**
- Modify: `README.md`
- Create: `docs/deployment.md`
- Create: `docs/local-llm.md`
- Create: `docs/cloud-llm.md`
- Create: `.env.example`
- Modify: `test/release-layout.test.js`

**Interfaces:**
- Documents the only supported fresh-DGX path: `./scripts/setup.sh`, `./scripts/start.sh`, `./scripts/verify.sh`.
- Documents local LLM as an external OpenAI-compatible service at `/v1`, default model `bird_agent`; includes vLLM as an optional external dependency reference, not bundled software.
- Documents cloud switch as editing `agent.mode`, `baseUrl`, `model`, exporting `LCS_AGENT_API_KEY`, then restarting.

- [ ] **Step 1: Extend the failing security test**

  Scan tracked text files for GitHub tokens, Hugging Face tokens, DeepSeek keys, private-key headers, embedded Bearer values, known workspace sudo secrets, and non-example `.env` files. Assert `runtime-config.js` and status fixtures contain no upstream URL or API key.

- [ ] **Step 2: Verify RED against the candidate public tree**

  Run: `node --test test/release-layout.test.js`

  Expected: FAIL if any existing tracked credential or unsafe deployment instruction remains; otherwise fail because the required deployment/LLM docs are absent.

- [ ] **Step 3: Write exact operator documentation**

  Explain DGX prerequisites, Release download override, local/cloud/rules JSON examples, secret environment variable, start/stop/status/log commands, WebAudio fallback, vLLM non-bundling boundary, troubleshooting, and the fact that changing config requires `./scripts/start.sh restart` or stop/start.

- [ ] **Step 4: Verify security and docs**

  Run: `node --test test/release-layout.test.js`

  Run: `git diff --check`

  Expected: PASS; no whitespace errors or secret findings.

- [ ] **Step 5: Commit**

  Commit: `docs: add standalone local and cloud LLM operations guide`

---

### Task 9: Final release, remote publication, and neural-audio assets

**Files:**
- Modify only generated Git metadata and GitHub Release state; `.pt` files remain ignored.

**Interfaces:**
- Publishes source branch `main` to `https://github.com/Twiddle-AI-China/intelligent_jungle`.
- Publishes Release tag `neural-audio-v1` containing exactly the four manifest assets.

- [ ] **Step 1: Run the full verification gate from a clean Git index**

  Run: `npm run test:release && npm test && npm run test:mvp && git diff --check`

  Expected: every test PASS and no diff errors.

- [ ] **Step 2: Verify public-tree hygiene**

  Run: `git status --short --ignored`

  Expected: only the four local `.pt` files, `runtime/`, local logs, and caches are ignored; all required source/config/calibration files are tracked.

- [ ] **Step 3: Add and verify the new remote through the required proxy**

  Add remote `release` with URL `https://github.com/Twiddle-AI-China/intelligent_jungle.git`. Use `HTTP_PROXY=http://127.0.0.1:7890` and `HTTPS_PROXY=http://127.0.0.1:7890` for GitHub network operations. Confirm `release` is empty before the first push.

- [ ] **Step 4: Push source and publish assets**

  Push the tested commit to `release/main`. Create GitHub Release `neural-audio-v1` and upload the four files from `flock-voice-engine/model_weights/midiBrave/` with clobber disabled. Do not upload any LLM weight or vLLM artifact.

- [ ] **Step 5: Verify the public result independently**

  Query GitHub for repository visibility, default branch, tag, Release asset names/sizes, and download URLs. Download the small source archive metadata and confirm no `.pt`, `.env`, token, `/srv/deploy`, or `/home/rolf` path is present in the published source tree.

- [ ] **Step 6: Record release commit**

  Commit any final documentation-only URL correction as `chore: finalize intelligent jungle release`, rerun the full gate, and push that commit to `release/main`.

---

## Plan Self-Review

- Spec coverage: Tasks 1/5 cover production neural assets; 2/3 cover one config and local/cloud/rules; 4 covers browser isolation; 6/7 cover DGX setup and runtime; 8 covers public safety and operator use; 9 covers the new repository and Release.
- Local LLM boundary: no task installs vLLM or an LLM checkpoint; only the existing OpenAI-compatible `bird_agent` contract and dependency guide are retained.
- Secret boundary: only the server reads `LCS_AGENT_API_KEY`; tests scan the tracked tree and public browser artifacts.
- Type consistency: Tasks 2 and 3 use the same `RuntimeSettings`/`ResolvedAgent`; Tasks 4, 6, and 7 all use `/api/agent`, `/api/runtime-status`, `/app/model_weights/midiBrave`, and `runtime/web`.
- Placeholder scan: all files, commands, modes, ports, hashes, tag names, paths, expected failures, and commit messages are explicit.
