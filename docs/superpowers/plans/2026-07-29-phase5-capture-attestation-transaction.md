# Phase 5 Capture-and-Attest 本地事务实施计划

> 状态：待实施。本文把已经冻结的
> `2026-07-29-phase5-signed-fault-evidence-design.md` 及其 13.4.2 安全勘误收敛成可逐项
> 评审的代码任务；不授权任何生产发布、8081/8090 操作或同机正式验收。

**目标：** 把一次性 candidate capture、原始 session 持久化、staging machine
attestation、composite 验证和 summary 构建收进 release controller 所拥有的一个
append-only、可恢复、失败关闭的本地事务。

**公开边界：** 唯一新增命令为：

```text
python deploy/release_control.py capture-and-attest-local --release-dir <release-root>
```

除 `--release-dir` 外不接受 attempt、container、PID/UID、socket、nonce、SPKI、
raw manifest、session、profile、attestation role/output、host evidence、runner 或 Node
路径等输入。上述值只能由已验证 release bytes、append-only admission、Docker exact
inspect 和固定 controller policy 推导。

**事务顺序：**

```text
全部可重试 preflight
→ capture-intent.json（O_EXCL/0400/fsync）
→ 一次 UDS request
→ fault-session-attestation.json（verifier 从 response.session 固定的 exact canonical
  sessionRaw，不是 channel response wrapper；O_EXCL/0400/fsync）
→ staging machine attestation
→ external full-9 composite validation
→ attestation-commit.json（O_EXCL/0400/fsync）
→ phase5-summary.json
```

`capture-intent.json` 一旦存在就永久禁止再次连接 signer。已知 channel 失败写固定枚举的
`capture-failure.json`；channel 已消费但 session 尚未落盘的崩溃是 indeterminate 终态；
machine capture 失败则保留 session，重试只能继续 attestation。任何 success/failure 冲突、
未知 inventory、symlink/hardlink/目录 ABA 或既有输出漂移均 fail closed。

**实施方法：** 每个任务严格 RED → 最小 GREEN → 聚焦回归 → 独立 spec/code review →
单独 commit。共享生产图 digest 只由生产图重绑定任务更新，本计划不得顺手重算或扩大图。

---

## Task 1：拆出 session-only capture primitive，并固定 full-9 trust boundary

**修改文件：**

- `flock-voice-engine/tests/test_phase5_capture_channel_client.py`
- `flock-voice-engine/tests/test_phase5_capture_proof_boundary.py`
- `flock-voice-engine/tests/test_machine_attestation.py`
- `flock-voice-engine/tools/phase5_capture_channel_client.py`
- `flock-voice-engine/tools/validate_phase5_acceptance.py`
- `flock-voice-engine/release/machine-attestation.schema.json`

### Step 1：先写 RED

新增测试证明：

1. `capture_phase5_candidate_session_linux(...)` 只消费固定 Linux UDS，返回 owned
   `sessionRaw`、`captureBoundary` 和 full `runBinding`，不读取或验证 summary。
2. `sessionRaw` 是 verifier 实际验证的 canonical v2 原始 bytes；返回值不能由调用方输入
   mutation 或后续 response mutation 改写。
3. peer mismatch、listener 未 unlink、超时、trickle、oversize、malformed response 均在
   session 返回前失败；每次调用最多发送一个 canonical request。
4. `validate_staging_attestation_composite_evidence(..., expected_full_run_binding)` 只接受
   exact full-9：
   `runId/challenge/release/geometry/profile/signerSpkiSha256/`
   `faultSessionEvidenceSha256/captureNonce/rawManifestSha256`。
5. legacy 7-field 输入、额外字段、同步替换 session 与 attestation、从 evidence 自导 trust
   root 均失败；`phase5_fault_run_binding_projection()` 仍独立地产生 summary 所需 7-field
   projection。
6. 现有 `capture_phase5_candidate_summary_linux()` 不再作为 controller 正式路径；测试不允许
   新入口先消费 signer 再读取 summary。
7. `machine-attestation.schema.json` 在本任务同步 hard-bump：staging `runBinding` 必须是
   exact full-9，production `runBinding` 必须为 null。这样本任务的 machine/composite
   聚焦套件可以独立 GREEN，不留下 schema 与 validator 的中间不一致。

运行：

```powershell
python -m pytest `
  flock-voice-engine/tests/test_phase5_capture_channel_client.py `
  flock-voice-engine/tests/test_phase5_capture_proof_boundary.py `
  flock-voice-engine/tests/test_machine_attestation.py `
  -q -p no:cacheprovider
```

预期：新增用例因 session-only API 和 full-9 composite 尚不存在而失败。

### Step 2：实现最小 GREEN

在 capture client 中新增 session-only public function；复用现有
`_capture_phase5_candidate_response_linux()` 和固定 response verifier，不新增
transport/socket/path 注入 seam。返回前对 verifier 结果做 canonical owned snapshot。

在 validator 中：

- 保留 `validate_fault_session_binding()` 作为 legacy 7-field projection validator；
- 新增独立的 full-9 owned validator；
- 把 `validate_staging_attestation_composite_evidence()` 切到 full-9；
- evidence integrity 层仍只复算磁盘内容，external composite 层必须与 controller 固定
  full-9 完全相等。
- 同步更新 machine schema 的 role 条件约束；不提供 legacy 7-field staging 兼容分支。

### Step 3：GREEN 与提交

重复上面的三文件测试，再运行：

```powershell
python -m pytest flock-voice-engine/tests/test_phase5_acceptance.py `
  -q -p no:cacheprovider
git diff --check
```

提交范围仅限本任务六个文件：

```text
feat(acceptance): expose session-only capture boundary
```

---

## Task 2：重开并持有唯一 admitted attempt，增加 append-only capture 状态

**修改文件：**

- `flock-voice-engine/tests/test_phase5_candidate_attempt.py`
- `flock-voice-engine/deploy/phase5_candidate_attempt.py`

### Step 1：先写 RED

新增测试覆盖：

1. `open_unique_admitted_phase5_candidate_attempt(...)` 扫描固定
   `<release-parent>/.p5c/a`，只能按完整 64-hex container ID、PID、UID 和
   release-manifest SHA 选择；0 个或多个匹配均失败。
2. 多个历史 attempt 存在时不按 mtime、目录名或调用者 attempt ID 选择。
3. reopen 重新验证 canonical `intent.json` / `admission.json`、record digest、完整 bind
   source、owner/mode/nlink/inode 和 exact inventory，并在整个事务期间持有
   anchor/registry/attempt/candidate dirfd 与 inode snapshots。
4. intent/admission symlink、hardlink、registry/attempt/candidate 目录替换、case alias、
   bind-source swap、record swap 和 post-open ABA 均失败。
5. append API 只允许以下状态：

   ```text
   intent.json
   admission.json
   capture-intent.json
     ├─ capture-failure.json
     └─ fault-session-attestation.json
          └─ attestation-commit.json
   ```

6. 所有 append 均为 dirfd-relative `O_NOFOLLOW|O_CREAT|O_EXCL`、0400，先 fsync file，
   再 fsync 完整目录链；失败留下 append-only poison，不覆盖、不删除、不重签。
7. `capture-failure.json` 只接受固定错误枚举，不接受 response bytes、异常文本或任意字段。
8. success/failure 并存、intent-only retry、未知 inventory、session/commit drift 均返回固定
   fail-closed 状态。
9. `capture-intent.json` exact schema 固定为：

   ```text
   schemaVersion, kind, attemptId, intentSha256, admissionRecordSha256,
   admissionSha256, releaseManifestSha256, candidate, identity,
   captureNonce, signerSpkiSha256, rawManifestSha256
   ```

   其中 `candidate` exact 为完整 `containerId/pid/uid`，`identity` exact 为
   `runId/challenge/release/geometry/profile`；`captureNonce/signerSpkiSha256` 必须与
   immutable admission 相等，受信 SPKI DER 仍只从 admission 读取并按 digest 复验。
10. `attestation-commit.json` exact schema 固定为：

    ```text
    schemaVersion, kind, attemptId, captureIntentSha256, sessionSha256,
    rawManifestSha256, profileDigests, stagingMachineAttestationSha256,
    evidenceInventorySha256
    ```

    `profileDigests` exact 为 normal/burst 两份 preflight bytes 的 SHA；
    `evidenceInventorySha256` 是 stable-sorted exact `{name,sha256}` 列表的 canonical SHA。
    commit 不是布尔 marker，任一被绑定文件漂移都会使重跑失败。
11. persisted session 的 resume trust root 只能由 immutable admission + capture intent +
    session bytes 重建：先用 admission 中 SPKI DER 重验 session，再由 admission identity/
    nonce/SPKI、intent raw-manifest SHA 和 controller-computed session SHA 构造 full-9。
    禁止从 session 的自声明 binding 或 machine attestation 反推 expected binding。
12. candidate bind-source inventory 必须按 append-only state 精确验证，不能全局放宽：

    - admission commit 在 append-only `admission.json` 内新增 exact
      `captureSocketState={device,inode,type,mode,uid,gid,nlink}`；写 admission 前后都必须
      从 held candidate dirfd 对同一 `capture.sock` 做 no-follow fstat 并证明 snapshot 未变；
    - pre-arm：恰好包含 admission 持久化 snapshot 对应的 `capture.sock`；
    - intent-only：只允许同一受验 `capture.sock` 或空目录，两者都是 indeterminate 终态，
      controller 永不 reconnect；
    - failure：`channelDisposition="not-connected"` 时只允许同一 socket，
      `"consumed"` 时只允许空目录；
    - session、attestation 或 commit：必须为空目录；
    - 任一状态出现额外 entry、不同 socket inode、symlink/reparse 或状态与 disposition
      不一致均失败。

    `capture-failure.json` exact 为
    `schemaVersion/kind/attemptId/captureIntentSha256/errorCode/channelDisposition`；
    后两者都来自固定枚举，仍禁止 response bytes 和自由文本。
13. socket-replacement RED 必须覆盖：admission fsync 前后 inode swap、stage 关闭 live handle
    后同路径新 socket、reopen 后 pre-arm swap，以及 failure
    `channelDisposition="not-connected"` 时的 replacement；这些攻击都不得连接或写后续 record。

运行：

```powershell
python -m pytest flock-voice-engine/tests/test_phase5_candidate_attempt.py `
  -q -p no:cacheprovider
```

预期：reopen/append API 缺失，新增测试失败。

### Step 2：实现最小 GREEN

新增不可变 `HeldAttempt`，复用现有 `_NodeState`、dirfd、canonical record 和 fsync
机制；同步 hard-bump admission record schema，将当时受验的 capture socket state durable
绑定进 record。公开给 controller 的最小 API：

- `open_unique_admitted_phase5_candidate_attempt(...)`
- `append_phase5_capture_intent(...)`
- `append_phase5_capture_failure(...)`
- `append_phase5_capture_session_raw(...)`
- `append_phase5_attestation_commit(...)`
- `inspect_phase5_capture_state(...)`

所有 API 要求 live held handle；不得接受 registry root、attempt ID 或自由 record path。
session API 原样写入 verifier 固定的 `response.session` canonical bytes，禁止写整个 response
wrapper 或 reserialize。controller 在持有 `HeldAttempt` 的同时另行持有 verified
release-root dirfd/inode snapshot；后续 session、machine evidence、commit 和 summary 发布都
必须 fd-relative，禁止消费 signer 后按用户给出的 `release_dir` pathname 重新打开。

### Step 3：GREEN 与提交

```powershell
python -m pytest flock-voice-engine/tests/test_phase5_candidate_attempt.py `
  -q -p no:cacheprovider
git diff --check
```

提交：

```text
feat(release): persist append-only capture attempts
```

---

## Task 3：把 staging machine attestation 变成 controller-owned 内部 API

**修改文件：**

- `flock-voice-engine/tests/test_machine_attestation.py`
- `flock-voice-engine/tools/capture_machine_attestation.py`

### Step 1：先写 RED

新增测试证明：

1. staging capture 只能通过 Python 内部 API
   `capture_staging_machine_attestation(...)`；CLI 只保留
   `production-baseline`，拒绝 `--attestation-role`、
   `--fault-session-attestation` 及所有 host/session/path 注入。
2. 内部 API 的 session bytes、full-9 binding、normal/burst profile bytes 和 raw manifest
   bundle 由 controller 传入；不再读取固定 `/run/flock-phase5-candidate` 或用户指定路径。
3. evidence 内 session 与 controller session byte-for-byte 相同；profile evidence 使用
   preflight 固定 bytes，源文件在 capture 中途变化不能静默重绑定。
4. publication 使用 held release-root dirfd 下的 controller-owned transaction marker、
   私有 temporary tree 与固定 quarantine tree；final evidence 只在完整写入并 fsync 后
   exclusive no-replace rename，final output 最后以 O_EXCL/0400/fsync 写入。marker 绑定
   `captureIntentSha256/sessionSha256` 与 held release-root dev/inode，并在完整 composite
   通过后才删除。
5. crash matrix exact 固定为：

   - final evidence 与 output 都不存在：仅正确 transaction marker 单独存在，或该 marker
     与已知私有 partial temp/fixed quarantine 共存时可恢复；marker 必须绑定同一
     `captureIntentSha256/sessionSha256` 与 held release-root dev/inode。temp 必须先
     no-replace 移入 quarantine 再逐 leaf 删除并 fsync，未知 temp/quarantine 一律失败且
     不动，然后才可重采；
   - evidence-only：必须同时存在正确 transaction marker 与已完整 fsync、exact inventory
     的 final evidence；从它重建并 O_EXCL 写 output，不重采、不删除 final evidence；
   - output-only：按规定顺序不可能，fail closed；
   - evidence + output：逐字节和 composite 验证后幂等返回，不覆盖；若存在正确的遗留
     transaction marker，只能在完整验证后删除；
   - partial final evidence、symlink/reparse/hardlink、父目录替换或未知 inventory：
     fail closed。

   永不删除或覆盖 final evidence/output；允许删除的只有通过 held dirfd/inode 和 exact
   transaction marker 证明属于本 attempt 的私有 partial/quarantine 与 marker 本身。
   删除模型要求 controller 独占同 UID 写权限、candidate `/release` 只读；不宣称抵御持续
   恶意的同 UID 并发 unlink/rename。
6. 本 Task 先执行 internal held-fd owned composite：它直接消费 exact evidence bytes 与
   controller-fixed full-9，并使用 schema-v2 normal/burst profiles。现有 Path-based
   `validate_staging_attestation_composite_evidence(...)` 仍要求 legacy profile arrays，
   不能作为本 Task 的成功门禁，也不得为迁就它转换已被 raw manifest 绑定的 profile bytes。
   Task 5 把 held-fd owned composite 迁入 validator-owned public API；synchronized
   session+attestation mutation 只能通过 integrity 层，不能通过 external composite 层。

运行：

```powershell
python -m pytest flock-voice-engine/tests/test_machine_attestation.py `
  -q -p no:cacheprovider
```

### Step 2：实现最小 GREEN

把通用 host evidence capture 与 role policy 分开：

- CLI 固定生产基线，不允许 role/session seam；
- staging 私有 API 接收 controller-owned immutable bytes；
- staging output 使用 exact inventory、exclusive publish 和 fsync；
- recovery 只处理已证明属于本事务的 private partial/quarantine，逐 leaf 删除并持久化，
  永不 `rmtree()` 或删除 final evidence/output。

### Step 3：GREEN 与提交

```powershell
python -m pytest `
  flock-voice-engine/tests/test_machine_attestation.py `
  flock-voice-engine/tests/test_phase5_acceptance.py `
  -q -p no:cacheprovider
git diff --check
```

提交：

```text
feat(acceptance): capture controller-owned staging attestation
```

---

## Task 4：把 capture client 加入 release execution closure

**修改文件：**

- `flock-voice-engine/tests/test_phase5_deploy_contract.py`
- `flock-voice-engine/runtime/test/audio/release-manifest.test.js`
- `flock-voice-engine/deploy/release_control.py`
- `flock-voice-engine/deploy/import-release.sh`
- `flock-voice-engine/runtime/src/audio/release-manifest.js`

### Step 1：先写 RED

更新 exact closure 断言，使以下文件成为 release-owned verified execution leaf：

```text
phase5_capture_channel_client.py
```

测试必须证明：

1. build 只从捕获 revision 的 Git blob materialize 该文件；
2. release manifest、import allowlist、nested execution closure 和 JS release reader 对同一
   exact name/digest 达成一致；
3. leaf 缺失、digest tamper、symlink/reparse、source path replacement 或 import 后替换时，
   在 Docker/socket/output 前失败；
4. verified loader 从 release bytes compile，不 import 工作树同名模块；
5. closure 变更会修改 production graph 中的 runtime release reader；本任务只做 closure
   聚焦 GREEN，不更新 graph pin，也不声称 broad production-graph gate 已完成。Tasks 1–5
   代码稳定后由 Task 6 从 committed blobs 双重重建并最后重绑，禁止在中间提交接受未解释
   漂移。

运行：

```powershell
python -m pytest flock-voice-engine/tests/test_phase5_deploy_contract.py `
  -k "summary_tooling or execution_closure or summary_materializer or capture" `
  -q -p no:cacheprovider
node --test flock-voice-engine/runtime/test/audio/release-manifest.test.js
```

### Step 2：实现最小 GREEN

同步更新：

- `PHASE5_SUMMARY_DEPLOY_SOURCES`
- `DEPLOY_EXECUTION_NAMES`
- verified controller module loader/materializer
- `import-release.sh` exact allowlist
- runtime release manifest exact deploy names

不得新增第二份源码、工作树 fallback 或可选 leaf。

### Step 3：GREEN 与提交

```powershell
python -m pytest flock-voice-engine/tests/test_phase5_deploy_contract.py `
  -k "not production_graph" -q -p no:cacheprovider
node --test flock-voice-engine/runtime/test/audio/release-manifest.test.js
git diff --check
```

此处若 production-graph selector 因预期 stale pin 为 RED，必须在报告中记录 derived/pinned
摘要；不得修改 consumer pin。最终 broad GREEN 在 Task 6 完成。

提交：

```text
fix(release): bind capture client into execution closure
```

---

## Task 5：实现 controller 单入口、因果顺序和 crash resume

**修改文件：**

- `flock-voice-engine/tests/test_phase5_deploy_contract.py`
- `flock-voice-engine/tests/test_phase5_capture_channel_client.py`
- `flock-voice-engine/tests/test_machine_attestation.py`
- `flock-voice-engine/tests/test_phase5_raw_manifest.py`
- `flock-voice-engine/tests/test_phase5_summary_nonfault_boundary.py`
- `flock-voice-engine/deploy/release_control.py`
- `flock-voice-engine/tools/validate_phase5_acceptance.py`

### Step 1：先写 RED

为
`capture-and-attest-local --release-dir <release-root>` 建立 event-recording fakes 和 Linux
真实 UDS integration，覆盖：

1. parser 只暴露 `--release-dir`；全部身份、socket、session、profile、role、output、
   runner/Node override 参数均被 argparse 拒绝。
2. `require_local_scope()`、Linux gate、production-address rejection 和 verified execution
   closure 在任何 Docker inspect、socket、record 或 output 前执行。
3. controller 从 release manifest、sidecar、raw manifest、raw leaves/profile 做 single-read
   preflight；raw manifest/profile/output 可修复错误发生在 `capture-intent.json` 前。
   同时打开并持有 release-root dirfd/inode snapshot，之后所有读取和发布均 fd-relative。
4. locator 根据 Docker exact full ID/PID/UID/mount 找到唯一 admitted attempt；发送前再次
   exact inspect，任一 name→ID/PID/UID/mount ABA 时发送 0 bytes。
5. 严格事件序列为：

   ```text
   verified preflight
   → fsynced capture intent
   → one channel exchange
   → fsynced raw session
   → machine capture
   → full-9 composite validation
   → fsynced attestation commit
   → summary build/reread/composite validation
   ```

6. peer mismatch、timeout、malformed response 写固定 `capture-failure.json`，不生成
   attestation/summary；重跑不再连接。
7. 模拟 channel 后、session write 前崩溃：仅有 intent，重跑返回 indeterminate，绝不重签。
8. 模拟 machine capture 失败：session 保留；重跑只续做 attestation，不连接 signer。
9. 模拟 attestation publish 后、commit 前崩溃：重跑验证既有 output/evidence 后仅补 commit，
   不覆盖、不重签。
10. session 或 attestation drift、conflicting records、未知 inventory 均 fail closed。
11. summary 只在 commit 后构建，并使用 session 的 legacy 7-field projection；machine
    composite 始终使用 controller-fixed full-9。
12. Linux 真 UDS 测试证明 `SO_PEERCRED`、单 request、listener unlink、session fsync 早于
    attestation；Windows 只运行纯状态机测试，不声称 authority 覆盖。
13. 新 controller 进程 resume 时从 admission 的 identity/nonce/SPKI DER、capture intent 的
    raw-manifest SHA 和 persisted session 的 controller-computed SHA 重建 full-9，并用
    admission SPKI DER 重新验 session；从 session/attestation 自导 expected binding必须失败。
14. summary 的唯一 owner 是 controller：commit 后在 held release-root 下以 canonical
    O_EXCL/0400/fsync 写固定 `phase5-summary.json`。重跑只允许读取一次并完成全量 composite
    验证后幂等接受；内容冲突不覆盖。soak 只生产 raw/manifest，不写 summary。
15. signer 消费后的 validator 路径不再接受 `Path` reopen：raw manifest、staging evidence
    和 summary composite 都使用 held release-root dirfd 读取的 single-read owned bundles。
    测试在每个阶段替换原 pathname，证明 validator 始终读取 held inode 或 fail closed。
16. validator 提供 owned summary builder，概念 API 为
    `build_phase5_summary_from_owned_bundle(...) -> (value, canonical_bytes)`；它从已固定 raw/
    session/attestation bundles 重算所有字段并立即执行 composite validation。controller
    不接受 soak 提供的待签 summary，也不把现有“只验证调用方 value”的 API伪装成 builder。

运行：

```powershell
python -m pytest `
  flock-voice-engine/tests/test_phase5_deploy_contract.py `
  flock-voice-engine/tests/test_phase5_capture_channel_client.py `
  flock-voice-engine/tests/test_machine_attestation.py `
  flock-voice-engine/tests/test_phase5_raw_manifest.py `
  flock-voice-engine/tests/test_phase5_summary_nonfault_boundary.py `
  -k "capture or attest or attempt or parser or owned_bundle or summary_builder" `
  -q -p no:cacheprovider
```

### Step 2：实现最小 GREEN

在 controller 内新增私有：

```python
_prepare_capture_and_attest_local(release_dir) -> PreparedCapture
_execute_capture_and_attest_local(prepared) -> CaptureAttestationCommit
```

`PreparedCapture` 只持有 owned immutable bytes、verified module callables、held attempt、
held release-root dirfd/inode snapshot 和 exact Docker identity；不持有用户可变 path claims。
execute 首先判断 append-only state：

- 无 intent：完成所有 preflight 后 arm + consume；
- intent only：indeterminate，拒绝；
- failure：终态，拒绝；
- session present / no commit：先按 admission SPKI 重验 persisted session，并从
  admission+intent+session SHA 重建 external full-9，再只 capture/validate attestation；
- attestation present / no commit：验证既有内容后 append commit；
- commit present：验证完整事务后仅允许幂等 summary recovery；
- 任一冲突：拒绝。

`tools/validate_phase5_acceptance.py` 同时增加 fd-relative/owned-bundle API：

- raw manifest loader 从 held dirfd 以 `openat/O_NOFOLLOW` single-read 固定所有 leaves；
- machine composite 直接消费 collector 返回或从 held dirfd 固定的 exact evidence blobs；
- summary builder 只消费这些 owned snapshots，返回 canonical bytes；
- 原有 Path API 只保留在尚未武装 signer 的 production-baseline/bundle 离线验证路径，不得被
  capture transaction 调用。

### Step 3：聚焦 GREEN

```powershell
python -m pytest `
  flock-voice-engine/tests/test_phase5_candidate_attempt.py `
  flock-voice-engine/tests/test_phase5_capture_channel_client.py `
  flock-voice-engine/tests/test_phase5_capture_proof_boundary.py `
  flock-voice-engine/tests/test_machine_attestation.py `
  flock-voice-engine/tests/test_phase5_raw_manifest.py `
  flock-voice-engine/tests/test_phase5_summary_nonfault_boundary.py `
  flock-voice-engine/tests/test_phase5_acceptance.py `
  flock-voice-engine/tests/test_phase5_deploy_contract.py `
  -k "not production_graph" -q -p no:cacheprovider
node --test flock-voice-engine/runtime/test/audio/release-manifest.test.js
git diff --check
```

### Step 4：隔离 Linux/Spark 工程预检

仅在本地全绿、独立 review 通过且 controlled artifacts/base image 已具备后执行。使用
`yfhuang@192.168.9.140`，在 `/tmp` 下创建唯一私有临时树和唯一 disposable container/
network，宿主仅发布 `127.0.0.1:18090`。先断言现有 8081/8090 container ID、状态和端口，
测试后再次断言完全未变；只按事先记录的完整 ID 清理本次资源。

这一步只能证明最终 Spark 上的 engineering candidate transaction 可运行，不能生成正式
equivalent-host acceptance，因为 production 与 staging stable identities 必须不相交。

### Step 5：提交

```text
feat(release): own capture and attestation transaction
```

---

## Task 6：所有代码稳定后最终重绑 production graph

**修改文件：**

- `flock-voice-engine/deploy/release_control.py`
- `flock-voice-engine/tools/validate_phase5_acceptance.py`

从 Task 5 的 committed HEAD 创建两个空的独立 snapshot，只用
`materialize_revision_snapshot()` 从 exact Git blobs 物化，并在各自 snapshot 中用 committed
lockfile 离线安装依赖、运行 committed graph builder。两份 canonical graph bytes、inner SHA、
files/edges/routes counts 必须完全相等；再逐项用独立
`git --no-replace-objects show <revision>:<path>` 验证全部 file/route digest。

只有两份结果和独立 blob 复算全一致，才更新两个 consumer pin；counts 仅在实测变化时更新，
不得从旧断言复制。

```powershell
node --test `
  flock-voice-engine/runtime/test/production-graph.test.js `
  flock-voice-engine/runtime/test/api/static-ui.test.js
python -m pytest flock-voice-engine/tests/test_phase5_acceptance.py `
  -k production_graph -q -p no:cacheprovider
python -m pytest flock-voice-engine/tests/test_phase5_deploy_contract.py `
  -k production_graph -q -p no:cacheprovider
git diff --check
```

提交：

```text
fix(release): rebind graph after capture transaction
```

---

## 完成门禁

以下条件全部满足，本计划才算完成：

- 唯一 CLI 只有 `--release-dir`；
- release-owned capture client/validator/collector/attempt modules 全部 digest-attested；
- signer 最多消费一次，且 session 原始 bytes 在 machine capture 前 durable；
- append-only attempt 状态对所有 crash point都有 fail-closed、无重签恢复语义；
- staging machine binding 是 external controller-fixed full-9；
- legacy 7-field projection 只用于 fault summary，不再充当 machine trust root；
- summary 只能在 attestation commit 后生成；
- Python 聚焦套件、JS release-manifest 套件、`git diff --check` 全绿；
- 最终 production graph 从 Tasks 1–5 的 committed blobs 双重独立重建并通过全部 consumer；
- 独立 spec reviewer 与 code-quality reviewer 均无未解决 finding；
- Spark 预检若执行，8081/8090 前后 identity/state 完全一致，且不被描述为正式验收。

## 后续独立计划

本计划不同时改写 `runtime/tools/soak-phase5.mjs`，避免把 controller 事务、七故障 actuator、
四客户端观测和 30 分钟 soak 混成一个不可评审提交。事务完成后另写并执行
“Phase 5 v2 七故障 soak orchestration”计划：soak 先落 raw + canonical raw manifest，再调用
本计划的 controller 单入口；controller 独占 session、staging attestation 和 summary 的生成与
恢复，soak 随后只触发 acceptance/package validator，不得另写 summary。正式门禁仍需另一台
稳定身份与生产不相交的等价 GB10 主机。
