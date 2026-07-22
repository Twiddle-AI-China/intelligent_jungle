# 生产基线收编与 Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改动线上 8090 运行内容的前提下，把可重建的 Git-controlled 生产代码基线放到 `refactor/backend-owned-runtime`，并对尚不可由 Git 重建的 vendor/runtime config 建立独立完整性证据；同时建立生产 manifest、可信测试门禁、release 身份和仅使用 `yfhuang` 的后续部署入口，为后端权威运行时重构消除错误基线。

**Architecture:** Git-controlled 生产源码不从 `/srv/deploy/flock-voice-engine` 整棵反拷，而以已验证可重建线上 active tree 的 `origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a` 为 Git 基线；线上只读快照仅作为证据输入。`mvp/` 继续是前端 canonical source，`flock-voice-engine/server/` 继续是当前 Python 音频服务 canonical source。容器另行挂载的 vendor 只有内容指纹和来源声明、runtime config 只有私有 HMAC 前后证明，两者在 Phase 0 都不伪称可由 Git 重建。Phase 0 只改 Git 与本地运维文档，不重启容器、不覆盖 `/srv/deploy`、不抢占 8090。

**Tech Stack:** Git、Node.js 20+、原生 `node:test`、Python 3.12、`pytest`、`aiohttp`、PowerShell/Git Bash、SHA-256 JSON manifest、Docker 部署脚本。

## Global Constraints

- 所有 Spark SSH 命令只允许 `yfhuang@192.168.9.140`；不得用其它服务器账号登录、同步或重启服务。
- 若 GitHub 抓取超时，只对单次 Git 命令使用 `-c http.proxy=http://127.0.0.1:7890`；不得写全局或仓库级 proxy 配置。
- Phase 0 禁止写 `/srv/deploy/flock-voice-engine`、禁止运行远端 `docker-run.sh restart/start/stop`、禁止改变 8090、8081 或任何容器状态。
- 不触碰同事的 `llama-gpu2:8083` 或其它不属于本任务的进程、容器、端口与权重。
- 线上内容快照只允许包含 repository-owned 源码和非权重资产；排除 runtime config、secret、`.venv/`、vendor 内容、checkpoint、`.npy`、缓存、备份和 staging。实际挂载的 vendor 必须记录聚合 SHA-256/文件数/来源并前后核对；runtime config 内容不得落盘，只在私有 `.audit` 保存 HMAC-SHA256 完整性标记，HMAC key 只以 CurrentUser DPAPI blob 落盘。
- 不把部署目录中的 `web/` 复制成 Git 中第二份手工维护源码；部署 `web/` 必须由 `mvp/` 生成。
- 每个行为变更先写失败测试，再写最小实现，再运行相关测试；历史重放与纯文档步骤不强造单元测试。
- 所有文档、测试说明和代码注释使用中文；接口字段名保持英文。
- 每个任务单独提交；不得夹带用户的无关修改。
- 任何新发现的、未列入本计划的生产差异必须停在 manifest 的 `unreviewed` 状态，不能凭猜测复制或忽略。

---

## Scope Check：为什么本计划只做 Phase 0

批准的设计文档是 [`2026-07-22-backend-owned-runtime-design.md`](../specs/2026-07-22-backend-owned-runtime-design.md)。它包含四个可以独立评审和回滚的实施域：

1. 生产事实收编与发布门禁；
2. Node 控制面、共享世界与外部协议；
3. species/master agent 与潜空间运行时下沉；
4. Python audio worker、PCM fan-out、legacy 兼容与 8090 原子切换。

后 3 个实施域依赖第 1 个域提供的正确源码、测试门禁和 release 身份。因此本文件只执行设计中的 Phase 0。Phase 0 完成后，再分别编写控制面、Agent/潜空间、音频 worker/切换三个实施计划；不得在本计划中顺手开始业务迁移。

## 已验证的溯源事实

Git-controlled mapping 比较时已统一 CRLF/LF，并忽略 `__pycache__`、`._*`、部署 `runtime-config.js`、vendor 内容、`.npy` 和备份文件；vendor/runtime config 不因此消失，而是走独立的聚合 SHA/HMAC 证据链。

| 候选 | `web/src` S/D/P/B | `server` S/D/P/B | `client` S/D/P/B | `deploy` S/D/P/B |
|---|---:|---:|---:|---:|
| `origin/feat/survival-economy@604f3d06` | 24/11/0/0 | 10/3/1/0 | 2/2/0/1 | 3/1/0/0 |
| `origin/feat/agent-feedback-loop@e2065010` | 19/13/3/0 | 10/3/1/0 | 2/2/0/1 | 3/1/0/0 |
| `origin/feat/ambient-mix-roamer@3fa71708` | 35/0/0/0 | 13/0/1/0 | 2/2/0/1 | 4/0/0/0 |
| `origin/feat/unconstrained-pca-roam@4e639efc` | 5/23/7/0 | 9/3/2/0 | 2/2/0/1 | 3/1/0/0 |
| `origin/beta@3cf686eb` | 35/0/0/0 | 13/0/1/0 | 2/2/0/1 | 4/0/0/0 |

其中 S/D/P/B 分别表示相同、内容不同、线上独有、分支独有。结论已经冻结：

- active `web/src` 35/35 精确等于 `origin/beta`；`web/index.html` 也相同。
- active `server` 的 13 个受控文件精确等于 `origin/beta`；线上独有 `server/brave.py` 是无引用、导入路径已失效的死副本，不进入 package。
- active `deploy` 4/4 精确等于 `origin/beta`。
- 部署根 `client/` 是旧版本混合副本，不能反灌；真正被同源站点提供的 `web/_client` 五个标准文件与 `origin/beta:flock-voice-engine/client` 5/5 相同，仅线上多 `vc2.html`、`vctest.html` 两个临时诊断页。
- `origin/beta` 包含 ambient、survival、agent-feedback、flock voice 与 PCA 历史；当前分支与它的 merge-base 是 `468410266a481d85c205475e91299443b905d662`。

---

### Task 1：把 refactor 分支重放到真实生产 Git 基线

**Files:**

- Preserve: `docs/superpowers/specs/2026-07-22-backend-owned-runtime-design.md`
- Preserve: `docs/superpowers/plans/2026-07-22-production-baseline-reconciliation.md`
- History base: `origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a`

- [ ] **Step 1: 先确认设计/计划已提交、工作树干净并保存恢复指针，再记录只读生产证据**

```powershell
git status --short --branch
$porcelain = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $porcelain.Count -ne 0) { $porcelain; throw 'worktree must be clean before any Phase 0 evidence is created' }
foreach ($document in @(
  'docs/superpowers/specs/2026-07-22-backend-owned-runtime-design.md',
  'docs/superpowers/plans/2026-07-22-production-baseline-reconciliation.md'
)) {
  git cat-file -e ('HEAD:' + $document)
  if ($LASTEXITCODE -ne 0) { throw "required implementation document is not committed: $document" }
}
$oldHead = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'cannot resolve current HEAD' }
$backup = 'backup/refactor-backend-owned-runtime-pre-beta'
git show-ref --verify --quiet "refs/heads/$backup"
if ($LASTEXITCODE -eq 0) {
  if ((git rev-parse $backup) -ne $oldHead) { throw 'backup ref already points elsewhere' }
} else {
  git branch $backup $oldHead
  if ($LASTEXITCODE -ne 0) { throw 'cannot create pre-beta backup ref' }
}
$auditRoot = 'D:\workspace\spark_hackrothon\.audit'
$startDir = Join-Path $auditRoot 'phase0-start'
if (Test-Path -LiteralPath $startDir) {
  $startDir
  throw 'Phase 0 start evidence already exists; never overwrite a baseline'
}
$gitSsh = 'C:\Program Files\Git\usr\bin\ssh.exe'
if (-not (Test-Path $gitSsh)) { throw 'Git for Windows ssh not found' }
$mountJson = & $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  "docker inspect flock-voice-engine --format '{{json .Mounts}}'"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($mountJson -join "`n"))) { throw 'cannot capture production mounts' }
try { $mounts = @(($mountJson -join "`n") | ConvertFrom-Json) }
catch { throw 'production mount payload is not valid JSON' }
foreach ($expectedMount in @(
  @('/srv/deploy/flock-voice-engine/server', '/app/server'),
  @('/srv/deploy/flock-voice-engine/vendor', '/app/vendor'),
  @('/srv/deploy/flock-voice-engine/assets', '/app/assets'),
  @('/srv/deploy/flock-voice-engine/web', '/app/web')
)) {
  $matchingMounts = @($mounts | Where-Object {
    $_.Source -eq $expectedMount[0] -and $_.Destination -eq $expectedMount[1] -and $_.RW -eq $false
  })
  if ($matchingMounts.Count -ne 1) { throw "missing expected read-only mount: $($expectedMount -join ' -> ')" }
}
$marker = & $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  "docker inspect flock-voice-engine --format '{{.Id}} {{.State.StartedAt}}'"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($marker)) { throw 'cannot capture production marker' }
$coreSourceHashCommand = @'
bash -o pipefail -c \"cd /srv/deploy/flock-voice-engine && find . -type f ! -path './deploy/sync.sh' ! -path './docs/deploy.md' ! -path './docs/HANDOFF.md' ! -path './docs/model-notes.md' ! -path './web/runtime-config.js' ! -path './logs/*' ! -path '*/__pycache__/*' ! -path '*/.venv/*' ! -path '*/vendor/*' ! -path '*/staging/*' ! -path '*/checkpoint/*' ! -path '*.bak_[0-9]*/*' ! -path '*.bak.[0-9]*/*' ! -name '.env' ! -name '.env.*' ! -name '*.pem' ! -name '*.key' ! -name '*.ckpt' ! -name '*.safetensors' ! -name '*.pyc' ! -name '*.npy' ! -name '._*' ! -name '*.bak' ! -name '*.bak.[0-9]*' ! -name '*.bak_[0-9]*' -print0 | sort -z | xargs -0 sha256sum\"
'@
$coreSourceHashes = & $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  $coreSourceHashCommand
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($coreSourceHashes -join "`n"))) { throw 'cannot capture production core source hashes' }
$vendorCommand = @'
bash -o pipefail -c \"cd /srv/deploy/flock-voice-engine && find vendor -type f -printf x | wc -c && find vendor -type l -printf x | wc -c && LC_ALL=C find vendor -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f1\"
'@
$vendorFacts = @(& $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  $vendorCommand)
if ($LASTEXITCODE -ne 0 -or $vendorFacts.Count -ne 3) { throw 'cannot capture production vendor fingerprint' }
$vendorFileCount = [int]$vendorFacts[0]
$vendorSymlinkCount = [int]$vendorFacts[1]
$vendorTreeSha256 = $vendorFacts[2].Trim()
if ($vendorFileCount -ne 460 -or $vendorSymlinkCount -ne 0 -or
    $vendorTreeSha256 -ne '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049') {
  throw 'production vendor changed since the read-only planning audit'
}
$runtimeConfigByteLines = @(& $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  "stat -c '%s' /srv/deploy/flock-voice-engine/web/runtime-config.js")
if ($LASTEXITCODE -ne 0 -or $runtimeConfigByteLines.Count -ne 1) {
  throw 'cannot read runtime config byte count'
}
$runtimeConfigByteCount = [int]$runtimeConfigByteLines[0]
if ($runtimeConfigByteCount -ne 171) {
  throw 'runtime config is missing or changed size since the planning audit'
}
Add-Type -AssemblyName System.Security
function ConvertTo-NativeArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $backslashes += 1; continue }
    if ($character -eq '"') {
      [void]$builder.Append((('\' * (2 * $backslashes + 1)) -join ''))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append((('\' * $backslashes) -join ''))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append((('\' * (2 * $backslashes)) -join ''))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}
function Invoke-SshWithBinaryInput([byte[]]$InputBytes, [string]$RemoteCommand) {
  if ($InputBytes.Length -ne 32) { throw 'binary SSH input must be exactly 32 bytes' }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $gitSsh
  $nativeArguments = @(
    '-T', '-i', 'D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa',
    '-o', 'BatchMode=yes', 'yfhuang@192.168.9.140', $RemoteCommand
  )
  $startInfo.Arguments = (($nativeArguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw 'cannot start binary-input SSH process' }
    $stdin = $process.StandardInput.BaseStream
    $stdin.Write($InputBytes, 0, $InputBytes.Length)
    $stdin.Flush()
    $stdin.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $null = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StandardOutput = $stdout }
  } finally {
    $process.Dispose()
  }
}
$runtimeHmacCommand = @'
python3 -c 'import hashlib,hmac,sys; payload=sys.stdin.buffer.read(); key=payload[3:] if len(payload)==35 and payload[:3]==bytes((239,187,191)) else payload; assert len(key)==32; data=open("/srv/deploy/flock-voice-engine/web/runtime-config.js","rb").read(); print(hmac.new(key,data,hashlib.sha256).hexdigest())'
'@
$rawKey = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($rawKey) } finally { $rng.Dispose() }
try {
  $runtimeHmacResult = Invoke-SshWithBinaryInput $rawKey $runtimeHmacCommand
  $runtimeConfigHmacLines = @($runtimeHmacResult.StandardOutput -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($runtimeHmacResult.ExitCode -ne 0 -or $runtimeConfigHmacLines.Count -ne 1) {
    throw 'cannot capture private runtime config integrity marker'
  }
  $runtimeConfigHmac = $runtimeConfigHmacLines[0].Trim()
  if ($runtimeConfigHmac -notmatch '^[0-9a-f]{64}$') {
    throw 'cannot capture private runtime config integrity marker'
  }
  $protectedKey = [System.Security.Cryptography.ProtectedData]::Protect(
    $rawKey,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
} finally {
  [Array]::Clear($rawKey, 0, $rawKey.Length)
}
$vendorRecord = [ordered]@{
  schemaVersion = 1
  regularFileCount = $vendorFileCount
  symlinkCount = $vendorSymlinkCount
  treeSha256 = $vendorTreeSha256
  treeHashAlgorithm = 'sha256 of LC_ALL=C path-sorted sha256sum lines'
  contentCaptured = $false
} | ConvertTo-Json -Compress
$runtimeConfigRecord = [ordered]@{
  schemaVersion = 1
  byteCount = $runtimeConfigByteCount
  integrityScheme = 'HMAC-SHA256'
  hmac = $runtimeConfigHmac
  contentCaptured = $false
} | ConvertTo-Json -Compress
$stageDir = Join-Path $auditRoot ('.phase0-start-' + [Guid]::NewGuid().ToString('N'))
$resolvedAuditRoot = [IO.Path]::GetFullPath($auditRoot).TrimEnd('\')
$resolvedStageDir = [IO.Path]::GetFullPath($stageDir)
if ((Split-Path -Parent $resolvedStageDir) -cne $resolvedAuditRoot -or
    (Split-Path -Leaf $resolvedStageDir) -notlike '.phase0-start-*') {
  throw 'unsafe Phase 0 evidence staging path'
}
[IO.Directory]::CreateDirectory($resolvedStageDir) | Out-Null
try {
  [IO.File]::WriteAllText((Join-Path $resolvedStageDir 'container.txt'), $marker.Trim() + "`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $resolvedStageDir 'core-source.sha256'), ($coreSourceHashes -join "`n").Trim() + "`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $resolvedStageDir 'vendor.json'), $vendorRecord + "`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $resolvedStageDir 'runtime-config.json'), $runtimeConfigRecord + "`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllBytes((Join-Path $resolvedStageDir 'runtime-config-key.dpapi'), $protectedKey)
  [IO.Directory]::Move($resolvedStageDir, $startDir)
  $resolvedStageDir = $null
} finally {
  if ($null -ne $resolvedStageDir -and (Test-Path -LiteralPath $resolvedStageDir)) {
    Remove-Item -LiteralPath $resolvedStageDir -Recurse -Force
  }
}
```

Expected: 设计与计划已在当前 HEAD，工作树在创建任何不可覆盖证据前干净，备份分支指向该实施前 HEAD。最终 `phase0-start/` 原先不存在，五份 start evidence 先写入同卷唯一 staging 目录，全部成功后才以目录原子改名发布；中途失败只清理已验证位于 `.audit` 下的 staging 目录，不会留下会被误当成基线的半套 final evidence。本地 audit 保存容器 ID + StartedAt、按路径排序的 Git-controlled core source hash、vendor 的 460/0/聚合 SHA，以及 runtime config 的私有 HMAC 和 CurrentUser DPAPI key blob。runtime config 原文不离开服务器；HMAC key 只经 SSH stdin 存在于两端进程内存，既不进入命令行/字符串也不明文落盘；Windows PowerShell 5.1 pipe 自动添加的固定 UTF-8 BOM 只在 payload 精确为 35 字节时剥离，随后强制 key 恰为 32 字节。vendor 内容也不复制。远端命令只有 `docker inspect/find/sort/sha256sum/stat/python3` 读取，没有写操作。若 key 因 ACL/agent 配置不可用，停下来修复 `yfhuang` 公钥访问；不得改用密码自动应答或其它账号。

- [ ] **Step 2: 证据创建后复核工作树与恢复指针未变化**

```powershell
git status --short --branch
$porcelain = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $porcelain.Count -ne 0) { $porcelain; throw 'worktree changed while capturing Phase 0 evidence' }
$oldHead = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'cannot resolve current HEAD' }
$backup = 'backup/refactor-backend-owned-runtime-pre-beta'
git show-ref --verify --quiet "refs/heads/$backup"
if ($LASTEXITCODE -ne 0) { throw 'pre-beta backup ref disappeared after evidence capture' }
if ((git rev-parse $backup) -ne $oldHead) { throw 'pre-beta backup ref no longer matches the implementation HEAD' }
```

Expected: 只读证据采集没有改变 Git；`git status --short` 没有文件行，备份分支仍精确指向包含设计与计划的实施前 HEAD。

- [ ] **Step 3: 用 7890 单次代理刷新精确 refs**

```powershell
$fetchOutput = git -c http.proxy=http://127.0.0.1:7890 fetch origin `
  beta `
  feat/flock-voice-engine `
  feat/ambient-mix-roamer `
  feat/survival-economy `
  feat/agent-feedback-loop `
  feat/unconstrained-pca-roam 2>&1
if ($LASTEXITCODE -ne 0) { $fetchOutput; throw 'cannot fetch pinned refs through one-shot proxy' }
$betaRevision = git rev-parse origin/beta
if ($LASTEXITCODE -ne 0 -or $betaRevision -ne '3cf686eb1dd2ed356594904e2f366805ae7dd11a') {
  throw "unexpected beta revision: $betaRevision"
}
$betaRevision
```

Expected: 最后一行是 `3cf686eb1dd2ed356594904e2f366805ae7dd11a`。不得执行 `git config --global http.proxy` 或 `git config http.proxy`。

- [ ] **Step 4: 先做不改工作树的冲突预检**

```powershell
$base = git merge-base HEAD origin/beta
if ($LASTEXITCODE -ne 0) { throw 'cannot resolve merge base' }
if ($base -ne '468410266a481d85c205475e91299443b905d662') { throw "unexpected merge base: $base" }
$mergeTree = git merge-tree --write-tree HEAD origin/beta 2>&1
if ($LASTEXITCODE -ne 0) { $mergeTree; throw 'rebase conflict predicted by merge-tree' }
```

Expected: `merge-tree` exit 0；工作树不变。该命令只可能在 Git object database 写入不可达 tree 对象，不修改 index 或工作树；非零即视为冲突并停止。

- [ ] **Step 5: 将本分支独有文档提交重放到 beta，而不是合并部署目录**

```powershell
git rebase --onto origin/beta 468410266a481d85c205475e91299443b905d662 refactor/backend-owned-runtime
if ($LASTEXITCODE -ne 0) {
  git rebase --abort
  throw 'rebase failed and was aborted'
}
git merge-base --is-ancestor origin/beta HEAD
if ($LASTEXITCODE -ne 0) { throw 'origin/beta is not an ancestor after rebase' }
git status --short --branch
$porcelain = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $porcelain.Count -ne 0) { $porcelain; throw 'worktree is not clean after rebase' }
```

Expected: `merge-base --is-ancestor` exit 0；设计与计划文件仍存在；工作树干净。若 rebase 出现任何冲突，执行 `git rebase --abort`，从备份分支恢复并复核，不得用 `theirs` 整体覆盖。

- [ ] **Step 6: 证明重放只改变基线，没有丢失本分支文档**

```powershell
$oldHead = git rev-parse backup/refactor-backend-owned-runtime-pre-beta
git range-diff 468410266a481d85c205475e91299443b905d662..$oldHead origin/beta..HEAD
git log --oneline --decorate -8
```

Expected: range-diff 显示原设计/计划提交被等价重放；`origin/beta` 是 HEAD 祖先。

- [ ] **Step 7: 在新基线上记录原始测试事实**

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw 'root baseline tests failed' }
npm run test:mvp
if ($LASTEXITCODE -ne 0) { throw 'MVP baseline tests failed' }
python flock-voice-engine/server/app.py --selftest
if ($LASTEXITCODE -ne 0) { throw 'voice selftest baseline failed' }
python -m pytest flock-voice-engine/tests/test_streaming_consistency.py -q
if ($LASTEXITCODE -ne 0) { throw 'voice streaming baseline failed' }
$checkOutput = npm run check 2>&1
$checkExit = $LASTEXITCODE
if ($checkExit -eq 0) { throw 'known JS gate defect unexpectedly disappeared; re-audit baseline' }
if (-not ($checkOutput | Select-String -SimpleMatch 'src/instrument/live-session.js')) {
  $checkOutput
  throw 'JS gate failed for an unexpected reason'
}
```

Expected: 前四条 exit 0；`npm run check` 仍因不存在的 `src/instrument/live-session.js` 非零退出。这是本计划要修复的已知门禁缺陷，不得用创建空文件来蒙混通过。

---

### Task 2：以测试驱动实现生产快照 manifest 工具

**Files:**

- Create: `flock-voice-engine/tools/production_manifest.py`
- Create: `flock-voice-engine/tests/test_production_manifest.py`

**Public interface:**

```python
def build_manifest(
    snapshot_root: Path,
    repository_root: Path,
    metadata: dict[str, object],
    decisions: dict[str, object],
) -> dict[str, object]:
    """返回稳定排序、可 JSON 序列化的生产差异 manifest。"""

def write_manifest(manifest: dict[str, object], output: Path) -> None:
    """UTF-8、indent=2、sort_keys=True，并以换行结尾原子写入。"""
```

CLI 契约：

```text
python flock-voice-engine/tools/production_manifest.py \
  --snapshot-root <只读快照目录> \
  --repository-root <Git worktree> \
  --metadata <metadata.json> \
  [--decisions <decisions.json>] \
  --output <manifest.json> \
  --fail-unreviewed
```

`argparse` 中 `--decisions` 必须是非 required、默认 `None`；省略时直接使用 `{"decisions": {}}`，用于第一次暴露完整差异，不能把缺参 usage error 当成 discovery。即使最终因 `--fail-unreviewed` exit 2，也必须先原子写出 output JSON。正式基线必须显式传入 decisions 文件。`--fail-unreviewed` 在存在没有 disposition 的 `changed`/`production-only` 项、`unmapped` 文件、mapping overlap 或未命中任何 entry 的 unused decision 时 exit 2；`repository-only` 默认 disposition 是 `retain-repository`，不阻塞。

- [ ] **Step 1: 先写换行归一、排除规则和未评审差异的失败测试**

在 `test_production_manifest.py` 建立临时 snapshot/repo，并写出下列完整行为：

```python
from __future__ import annotations

import tempfile
import unittest
import importlib.util
import hashlib
import json
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load_manifest_module():
    path = Path(__file__).resolve().parents[1] / "tools" / "production_manifest.py"
    spec = importlib.util.spec_from_file_location("production_manifest", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ProductionManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.snapshot = self.root / "snapshot"
        self.repository = self.root / "repository"
        (self.snapshot / "web/src").mkdir(parents=True)
        (self.repository / "mvp/src").mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_normalizes_text_but_not_binary_and_never_hashes_runtime_config(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/main.js").write_bytes(b"export const x = 1;\r\n")
        (self.repository / "mvp/src/main.js").write_bytes(b"export const x = 1;\n")
        (self.snapshot / "web/src/backup-policy.js").write_text("export const safe = true;\n", encoding="utf-8")
        (self.repository / "mvp/src/backup-policy.js").write_text("export const safe = true;\n", encoding="utf-8")
        (self.snapshot / ".gitignore").write_bytes(b"logs/\r\n")
        (self.repository / "flock-voice-engine").mkdir(exist_ok=True)
        (self.repository / "flock-voice-engine/.gitignore").write_bytes(b"logs/\n")
        (self.snapshot / "web/assets").mkdir()
        (self.repository / "mvp/assets").mkdir()
        production_binary = b"\x89PNG\r\n\xff"
        repository_binary = b"\x89PNG\n\xff"
        (self.snapshot / "web/assets/icon.png").write_bytes(production_binary)
        (self.repository / "mvp/assets/icon.png").write_bytes(repository_binary)
        (self.snapshot / "web/runtime-config.js").write_text("window.SECRET='hidden'", encoding="utf-8")
        repository_runtime = self.repository / "mvp/runtime-config.js"
        repository_runtime.write_text("window.SECRET='repository-hidden'", encoding="utf-8")
        (self.snapshot / "deploy").mkdir()
        remote_secret_text = "REMOTE_" + "PASS=hidden"
        repository_remote_secret_text = "REMOTE_" + "PASS=repository-hidden"
        historical_credential_text = "密" + "码: historical-hidden"
        repository_credential_text = "pass" + "word=repository-hidden"
        (self.snapshot / "deploy/sync.sh").write_text(remote_secret_text, encoding="utf-8")
        (self.repository / "flock-voice-engine/deploy").mkdir(parents=True)
        repository_sync = self.repository / "flock-voice-engine/deploy/sync.sh"
        repository_sync.write_text(repository_remote_secret_text, encoding="utf-8")
        (self.snapshot / "docs").mkdir()
        snapshot_deploy_doc = self.snapshot / "docs/deploy.md"
        snapshot_deploy_doc.write_text(historical_credential_text, encoding="utf-8")
        snapshot_handoff = self.snapshot / "docs/HANDOFF.md"
        snapshot_handoff.write_text(historical_credential_text, encoding="utf-8")
        snapshot_model_notes = self.snapshot / "docs/model-notes.md"
        snapshot_model_notes.write_text(historical_credential_text, encoding="utf-8")
        (self.repository / "flock-voice-engine/docs").mkdir(parents=True)
        repository_deploy_doc = self.repository / "flock-voice-engine/docs/deploy.md"
        repository_deploy_doc.write_text(repository_credential_text, encoding="utf-8")
        repository_handoff = self.repository / "flock-voice-engine/docs/HANDOFF.md"
        repository_handoff.write_text(repository_credential_text, encoding="utf-8")
        repository_model_notes = self.repository / "flock-voice-engine/docs/model-notes.md"
        repository_model_notes.write_text(repository_credential_text, encoding="utf-8")
        (self.snapshot / "server").mkdir()
        (self.repository / "flock-voice-engine/server").mkdir(parents=True)
        snapshot_env = self.snapshot / "server/.env"
        repository_env = self.repository / "flock-voice-engine/server/.env"
        snapshot_key = self.snapshot / "server/private.pem"
        repository_key = self.repository / "flock-voice-engine/server/private.pem"
        snapshot_weight = self.snapshot / "server/model.ckpt"
        repository_weight = self.repository / "flock-voice-engine/server/model.ckpt"
        snapshot_env.write_text("should-not-read", encoding="utf-8")
        repository_env.write_text("should-not-read", encoding="utf-8")
        snapshot_key.write_bytes(b"should-not-read")
        repository_key.write_bytes(b"should-not-read")
        snapshot_weight.write_bytes(b"should-not-read")
        repository_weight.write_bytes(b"should-not-read")
        (self.snapshot / "checkpoint").mkdir()
        snapshot_checkpoint = self.snapshot / "checkpoint/model.bin"
        snapshot_checkpoint.write_bytes(b"should-not-read")
        sensitive_paths = {
            (self.snapshot / "web/runtime-config.js").resolve(),
            repository_runtime.resolve(),
            (self.snapshot / "deploy/sync.sh").resolve(),
            repository_sync.resolve(),
            snapshot_deploy_doc.resolve(),
            repository_deploy_doc.resolve(),
            snapshot_handoff.resolve(),
            repository_handoff.resolve(),
            snapshot_model_notes.resolve(),
            repository_model_notes.resolve(),
            snapshot_env.resolve(),
            repository_env.resolve(),
            snapshot_key.resolve(),
            repository_key.resolve(),
            snapshot_weight.resolve(),
            repository_weight.resolve(),
            snapshot_checkpoint.resolve(),
        }
        original_read = module.read_file_bytes

        def guarded_read(path: Path, root: Path) -> bytes:
            if path.resolve() in sensitive_paths:
                raise AssertionError(f"敏感文件不允许被读取: {path.name}")
            return original_read(path, root)

        with patch.object(module, "read_file_bytes", side_effect=guarded_read):
            report = module.build_manifest(self.snapshot, self.repository, {}, {})
        entries = {entry["repositoryPath"]: entry for entry in report["entries"]}
        self.assertEqual(entries["mvp/src/main.js"]["status"], "same")
        self.assertEqual(entries["mvp/src/backup-policy.js"]["status"], "same")
        self.assertEqual(entries["flock-voice-engine/.gitignore"]["status"], "same")
        self.assertEqual(entries["mvp/assets/icon.png"]["status"], "changed")
        self.assertEqual(
            entries["mvp/assets/icon.png"]["productionSha256"],
            hashlib.sha256(production_binary).hexdigest(),
        )
        self.assertEqual(
            entries["mvp/assets/icon.png"]["repositorySha256"],
            hashlib.sha256(repository_binary).hexdigest(),
        )
        self.assertNotIn("window.SECRET", str(report))
        self.assertNotIn(remote_secret_text, str(report))
        excluded = {item["productionPath"] for item in report["excluded"]}
        self.assertIn("web/runtime-config.js", excluded)
        self.assertIn("deploy/sync.sh", excluded)
        self.assertIn("docs/deploy.md", excluded)
        self.assertIn("docs/HANDOFF.md", excluded)
        self.assertIn("docs/model-notes.md", excluded)
        self.assertIn("server/.env", excluded)
        self.assertIn("server/private.pem", excluded)
        self.assertIn("server/model.ckpt", excluded)
        self.assertIn("checkpoint/model.bin", excluded)

    def test_rejects_snapshot_and_repository_links_before_reading_target(self) -> None:
        module = load_manifest_module()
        fake_reparse = SimpleNamespace(
            st_mode=stat.S_IFREG,
            st_file_attributes=getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400),
        )
        with patch.object(Path, "lstat", return_value=fake_reparse):
            with self.assertRaisesRegex(module.UnsafeManifestPathError, "link|reparse"):
                module.read_file_bytes(self.snapshot / "web/src/main.js", self.snapshot)

        outside = self.root / "outside-secret.js"
        outside.write_text("must-not-open", encoding="utf-8")
        cases = (
            self.snapshot / "web/src/linked.js",
            self.repository / "mvp/src/linked.js",
        )
        for link in cases:
            with self.subTest(link=link):
                try:
                    link.symlink_to(outside)
                except (OSError, NotImplementedError) as error:
                    self.skipTest(f"当前平台不能创建测试 symlink: {error}")
                try:
                    with self.assertRaisesRegex(module.UnsafeManifestPathError, "link|reparse|root"):
                        module.build_manifest(self.snapshot, self.repository, {}, {})
                finally:
                    link.unlink(missing_ok=True)

        outside_snapshot = self.root / "outside-snapshot"
        outside_repository = self.root / "outside-repository"
        outside_snapshot.mkdir()
        outside_repository.mkdir()
        root_cases = (
            (self.root / "snapshot-root-link", outside_snapshot, self.repository),
            (self.root / "repository-root-link", outside_repository, self.snapshot),
        )
        for root_link, target, other_root in root_cases:
            with self.subTest(root_link=root_link):
                try:
                    root_link.symlink_to(target, target_is_directory=True)
                except (OSError, NotImplementedError) as error:
                    self.skipTest(f"当前平台不能创建 root symlink: {error}")
                try:
                    roots = (
                        (root_link, other_root)
                        if "snapshot" in root_link.name
                        else (other_root, root_link)
                    )
                    with self.assertRaisesRegex(module.UnsafeManifestPathError, "link|reparse|root"):
                        module.build_manifest(*roots, {}, {})
                finally:
                    root_link.unlink(missing_ok=True)

    def test_marks_changed_and_production_only_as_unreviewed(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/main.js").write_text("old", encoding="utf-8")
        (self.repository / "mvp/src/main.js").write_text("new", encoding="utf-8")
        (self.snapshot / "server").mkdir()
        (self.snapshot / "server/brave.py").write_text("dead", encoding="utf-8")
        report = module.build_manifest(self.snapshot, self.repository, {}, {})
        self.assertEqual(report["summary"]["unreviewed"], 2)

    def test_applies_explicit_decision_and_sorts_entries(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/z.js").write_text("old", encoding="utf-8")
        (self.repository / "mvp/src/z.js").write_text("new", encoding="utf-8")
        decisions = {
            "decisions": {
                "mvp-src:changed:mvp/src/z.js": {
                    "disposition": "retain-repository",
                    "reason": "Git 版本来自已验证的后继提交",
                }
            }
        }
        report = module.build_manifest(self.snapshot, self.repository, {}, decisions)
        self.assertEqual(report["summary"]["unreviewed"], 0)
        self.assertEqual(
            report["entries"],
            sorted(
                report["entries"],
                key=lambda item: (item["mapping"], item["repositoryPath"], item["productionPath"]),
            ),
        )

    def test_unmapped_file_is_a_blocking_coverage_error(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "mystery.txt").write_text("unclaimed", encoding="utf-8")
        report = module.build_manifest(self.snapshot, self.repository, {}, {})
        self.assertEqual(report["summary"]["unmapped"], 1)
        self.assertEqual(report["summary"]["unreviewed"], 1)
        self.assertEqual(report["unmapped"][0]["productionPath"], "mystery.txt")

    def test_unused_decision_is_a_blocking_configuration_error(self) -> None:
        module = load_manifest_module()
        decisions = {
            "decisions": {
                "engine-server:changed:flock-voice-engine/server/missing.py": {
                    "disposition": "retain-repository",
                    "reason": "这个 key 故意不存在",
                }
            }
        }
        report = module.build_manifest(self.snapshot, self.repository, {}, decisions)
        self.assertEqual(report["summary"]["unusedDecisions"], 1)
        self.assertEqual(report["summary"]["unreviewed"], 1)
        self.assertEqual(
            report["unusedDecisions"],
            ["engine-server:changed:flock-voice-engine/server/missing.py"],
        )

    def test_output_bytes_are_stable_across_creation_order(self) -> None:
        module = load_manifest_module()
        metadata = {
            "capturedAt": "2026-07-22T16:32:54+08:00",
            "externalRuntimeInputs": {
                "vendor": {"treeSha256": "a" * 64, "regularFileCount": 3}
            },
        }
        roots = []
        for name, order in (("first", ("z.js", "a.js")), ("second", ("a.js", "z.js"))):
            snapshot = self.root / name / "snapshot"
            repository = self.root / name / "repository"
            (snapshot / "web/src").mkdir(parents=True)
            (repository / "mvp/src").mkdir(parents=True)
            for filename in order:
                (snapshot / "web/src" / filename).write_text(filename, encoding="utf-8")
                (repository / "mvp/src" / filename).write_text(filename, encoding="utf-8")
            output = self.root / name / "manifest.json"
            module.write_manifest(
                module.build_manifest(snapshot, repository, metadata, {}),
                output,
            )
            roots.append(output.read_bytes())
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8"))["metadata"],
                metadata,
            )
        self.assertEqual(roots[0], roots[1])
        self.assertEqual(
            metadata,
            {
                "capturedAt": "2026-07-22T16:32:54+08:00",
                "externalRuntimeInputs": {
                    "vendor": {"treeSha256": "a" * 64, "regularFileCount": 3}
                },
            },
        )

    def test_cli_without_decisions_writes_discovery_manifest_and_exits_two(self) -> None:
        module = load_manifest_module()
        (self.snapshot / "web/src/main.js").write_text("deployed", encoding="utf-8")
        (self.repository / "mvp/src/main.js").write_text("canonical", encoding="utf-8")
        metadata = self.root / "metadata.json"
        output = self.root / "discovery.json"
        metadata.write_text("{}\n", encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(Path(module.__file__)),
                "--snapshot-root", str(self.snapshot),
                "--repository-root", str(self.repository),
                "--metadata", str(metadata),
                "--output", str(output),
                "--fail-unreviewed",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("usage:", result.stderr.lower())
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["summary"]["unreviewed"], 1)
```

辅助器通过 `sys.modules` 注册临时模块是为了让 `dataclass` 能解析模块命名空间；它不修改 `sys.path`。

- [ ] **Step 2: 运行测试确认因模块不存在而失败**

```powershell
$manifestRed = python -m pytest flock-voice-engine/tests/test_production_manifest.py -q 2>&1
$manifestRedExit = $LASTEXITCODE
if ($manifestRedExit -eq 0 -or -not ($manifestRed | Select-String -SimpleMatch 'production_manifest')) {
  $manifestRed
  throw 'manifest red test did not fail for the expected missing module'
}
```

Expected: FAIL，错误明确指向缺少 `tools/production_manifest.py`。

- [ ] **Step 3: 实现固定 canonical mapping 与排除规则**

`production_manifest.py` 必须定义以下 mapping；标签也写进输出，后续门禁按标签判断：

```python
import os
import stat
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Mapping:
    label: str
    production: str
    repository: str
    kind: str = "tree"


class UnsafeManifestPathError(RuntimeError):
    """候选文件通过 link/reparse point 逃出可信根，必须在读取前终止。"""


def validate_trusted_root(root: Path) -> Path:
    """拒绝 root 自身的 link/reparse，并返回未跟随链接的绝对根。"""
    lexical_root = Path(os.path.abspath(root))
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    root_stat = lexical_root.lstat()
    root_attributes = getattr(root_stat, "st_file_attributes", 0)
    if stat.S_ISLNK(root_stat.st_mode) or root_attributes & reparse_flag:
        raise UnsafeManifestPathError(f"trusted root is a link/reparse point: {root}")
    if not stat.S_ISDIR(root_stat.st_mode):
        raise UnsafeManifestPathError(f"trusted root is not a directory: {root}")
    return lexical_root


def read_file_bytes(path: Path, root: Path) -> bytes:
    """验证整条路径链后读取；这是 manifest 内容读取的唯一入口。"""
    lexical_root = validate_trusted_root(root)
    lexical_path = Path(os.path.abspath(path))
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    try:
        relative = lexical_path.relative_to(lexical_root)
    except ValueError as error:
        raise UnsafeManifestPathError(f"path is outside lexical root: {path}") from error

    cursor = lexical_root
    final_stat = None
    for component in relative.parts:
        cursor = cursor / component
        final_stat = cursor.lstat()
        attributes = getattr(final_stat, "st_file_attributes", 0)
        if stat.S_ISLNK(final_stat.st_mode) or attributes & reparse_flag:
            raise UnsafeManifestPathError(f"link/reparse point is forbidden: {cursor}")

    resolved_root = lexical_root.resolve(strict=True)
    resolved_path = lexical_path.resolve(strict=True)
    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as error:
        raise UnsafeManifestPathError(f"resolved path escapes root: {path}") from error
    if final_stat is None or not stat.S_ISREG(final_stat.st_mode):
        raise UnsafeManifestPathError(f"manifest input is not a regular file: {path}")
    return lexical_path.read_bytes()


MAPPINGS = (
    Mapping("mvp-src", "web/src", "mvp/src"),
    Mapping("mvp-index", "web/index.html", "mvp/index.html", "file"),
    Mapping("mvp-runtime-example", "web/runtime-config.example.js", "mvp/runtime-config.example.js", "file"),
    Mapping("mvp-readme", "web/README.md", "mvp/README.md", "file"),
    Mapping("mvp-assets", "web/assets", "mvp/assets"),
    Mapping("mvp-eval", "web/eval", "mvp/eval"),
    Mapping("mvp-tests", "web/test", "mvp/test"),
    Mapping("mvp-tools", "web/tools", "mvp/tools"),
    Mapping("served-timbre-assets", "web/assets/timbre", "flock-voice-engine/assets/timbre"),
    Mapping("active-legacy-client", "web/_client", "flock-voice-engine/client"),
    Mapping("engine-gitignore", ".gitignore", "flock-voice-engine/.gitignore", "file"),
    Mapping("engine-server", "server", "flock-voice-engine/server"),
    Mapping("engine-deploy", "deploy", "flock-voice-engine/deploy"),
    Mapping("engine-docs", "docs", "flock-voice-engine/docs"),
    Mapping("engine-tools", "tools", "flock-voice-engine/tools"),
    Mapping("engine-assets", "assets", "flock-voice-engine/assets"),
    Mapping("engine-brief", "BRIEF.md", "flock-voice-engine/BRIEF.md", "file"),
    Mapping("engine-readme", "README.md", "flock-voice-engine/README.md", "file"),
)
```

排除必须基于相对 production path，且输出只记录路径与 reason，不读取、不哈希 excluded 文件：

```python
EXCLUDE_RULES = (
    ("runtime-config.js", "部署配置/可能含凭证"),
    ("deploy/sync.sh", "已废弃且含明文凭证的脚本；绝不读取或 hash"),
    ("docs/deploy.md", "历史部署文档含凭证形态文本；从审计输入和 hash 中精确排除"),
    ("docs/HANDOFF.md", "历史交接文档含凭证形态文本；从审计输入和 hash 中精确排除"),
    ("docs/model-notes.md", "历史模型说明含凭证形态文本；从审计输入和 hash 中精确排除"),
    (".env", "环境凭证文件"),
    (".env.", "环境凭证文件变体"),
    (".pem", "私钥/证书材料"),
    (".key", "私钥材料"),
    (".ckpt", "模型权重文件"),
    (".safetensors", "模型权重文件"),
    ("checkpoint", "模型 checkpoint/权重目录"),
    ("__pycache__", "生成缓存"),
    (".pyc", "生成缓存"),
    ("._", "AppleDouble"),
    (".npy", "生成的数值资产"),
    (".bak", "符合精确备份命名规则的文件或目录"),
    ("staging", "临时产物"),
    ("vendor", "外部依赖"),
    (".venv", "虚拟环境"),
)
```

匹配语义固定为：目录名规则（含 `checkpoint`）按完整 path component 匹配；扩展/前缀规则按 basename 匹配；`.env` 是精确 basename、`.env.*` 是前缀，`.pem/.key/.ckpt/.safetensors` 是后缀。备份只匹配 basename 后缀 `.bak`，或 `\.bak[_.]\d{8}_?\d{6}` 形式的文件或目录，因此 `voice_maps.bak_20260721_221035/` 被排除，但合法源码 `backup-policy.py` 必须继续进入 mapping/coverage。`deploy/sync.sh`、`docs/{deploy,HANDOFF,model-notes}.md`（production 与 repository 对应路径）、`web/runtime-config.js` 与 `mvp/runtime-config.js` 必须在打开文件前按完整路径排除。`build_manifest()` 入口必须先对 snapshot/repository 两个 root 分别调用 `validate_trusted_root()`，即使目录为空也不能跳过。所有文件读取与 hash 必须统一调用 `read_file_bytes(path, trusted_root)`，遍历代码不能直接使用 `Path.read_bytes()/read_text()/open()`；测试会 monkeypatch 该唯一入口，任何敏感路径读取都会立即失败。遍历和 mapping root 检查必须使用 `lstat`，不得 follow symlink；snapshot/repository trusted root 本身、其下任一父组件或候选文件是 symlink、junction 或其它 reparse point 时，在读取目标前抛 `UnsafeManifestPathError`，root 还必须是实际目录。解析后的路径也必须位于对应 trusted root；不能把 link 当普通 `production-only`/`unmapped` 项继续 hash。额外规则：

- `web/assets/timbre/` 在 `mvp-assets` mapping 中跳过，但必须由 `served-timbre-assets` mapping 实际比较到 `flock-voice-engine/assets/timbre/`；不能只写一条“由别处管理”的 exclude 就让 active 浏览器副本逃离 hash 门禁。
- `web/_client` 只由 `active-legacy-client` mapping 管理，不能同时归入其它 mapping。
- 部署根 `client/` 是未被容器提供的 stale tree，放入 `IGNORED_TREES = {"client": "未被当前容器提供的旧混合副本"}`；其每个文件进入 `excluded`，不能静默跳过。
- 全量遍历 snapshot 后，任何既未被恰好一个 mapping claim、也未被排除规则/`IGNORED_TREES` 解释的文件进入 `unmapped`。同一 production file 被两个 mapping claim 也属于 coverage error。

文本扩展名 `.py/.js/.mjs/.html/.css/.md/.json/.sh/.txt/.service/.svg/.xml`，以及文件名 `.gitignore`、`Dockerfile`、`LICENSE`，在 SHA-256 前统一 `CRLF/CR -> LF`；其它文件逐字节 hash。这个规则用于消除 Windows/Linux checkout 换行差异，不能对 `.wav/.mp3/.png/.jpg` 做文本解码。每个 entry 至少包含：

```json
{
  "mapping": "mvp-src",
  "productionPath": "web/src/main.js",
  "repositoryPath": "mvp/src/main.js",
  "productionSha256": "hex-or-null",
  "repositorySha256": "hex-or-null",
  "status": "same|changed|production-only|repository-only",
    "disposition": "matched|unreviewed|retain-repository|ignore-deployed-artifact|deduplicate"
}
```

- [ ] **Step 4: 实现稳定输出、显式 decision 和原子写入**

decision key 格式固定为 `<mapping>:<status>:<repositoryPath>`，因为 `engine-assets` 与 `served-timbre-assets` 可以合法指向同一个 canonical repository path；不得按 repository path 去重 entry。`write_manifest()` 先在 output 同目录写 `<name>.tmp`，再用 `Path.replace()` 原子替换；不得把 secret 内容写进报表。

Manifest 顶层结构固定为：

```json
{
  "schemaVersion": 1,
  "metadata": {},
  "mappings": [],
  "summary": {
    "same": 0,
    "changed": 0,
    "productionOnly": 0,
    "repositoryOnly": 0,
    "excluded": 0,
    "unmapped": 0,
    "unusedDecisions": 0,
    "unreviewed": 0
  },
  "entries": [],
  "excluded": [],
  "unmapped": [],
  "unusedDecisions": []
}
```

输出只能包含 mapping-relative 的 POSIX 路径，不能包含 `D:\workspace`、本机用户名、SSH key 路径或其它绝对路径；这样同一快照在另一台机器上仍生成同一 JSON。

稳定排序固定为：`mappings` 保持 `MAPPINGS` 常量顺序；`entries` 按 `(mapping, repositoryPath, productionPath)`；`excluded` 按 `(productionPath, reason)`；`unmapped` 按 `productionPath`；`unusedDecisions` 按 key 字典序。`build_manifest()` 原样复制调用者 metadata，禁止注入 `datetime.now()`。

- [ ] **Step 5: 运行新增测试和脚本语法检查**

```powershell
python -m pytest flock-voice-engine/tests/test_production_manifest.py -q
if ($LASTEXITCODE -ne 0) { throw 'production manifest tests failed' }
python -m py_compile flock-voice-engine/tools/production_manifest.py
if ($LASTEXITCODE -ne 0) { throw 'production manifest syntax check failed' }
```

Expected: 8 tests passed；其中 snapshot/repository trusted root 本身以及内部 link/reparse 测试都在读取根外目标前失败，CLI 省略 decisions 的测试明确写出 discovery JSON 后才 exit 2（不是 argparse usage error）；`py_compile` exit 0。

- [ ] **Step 6: 提交工具与测试**

```powershell
git add flock-voice-engine/tools/production_manifest.py flock-voice-engine/tests/test_production_manifest.py
git commit -m "test: add production snapshot manifest contract"
```

---

### Task 3：生成生产证据、逐项 disposition，并提交 Git-controlled 基线

**Files:**

- Create: `docs/production-manifests/2026-07-22-metadata.json`
- Create: `docs/production-manifests/2026-07-22-decisions.json`
- Create: `docs/production-manifests/2026-07-22-production.json`
- Read only: `D:/workspace/spark_hackrothon/.audit/production-20260722-plan/`
- Generated audit archives/trees: unique `git-beta-3cf686eb-<guid>` paths under `D:/workspace/spark_hackrothon/.audit/`

- [ ] **Step 1: 验证审计快照存在且没有被放进 Git**

```powershell
$snapshot = 'D:\workspace\spark_hackrothon\.audit\production-20260722-plan'
$startDir = 'D:\workspace\spark_hackrothon\.audit\phase0-start'
$vendorStartPath = Join-Path $startDir 'vendor.json'
$runtimeConfigStartPath = Join-Path $startDir 'runtime-config.json'
$runtimeConfigKeyPath = Join-Path $startDir 'runtime-config-key.dpapi'
if (-not (Test-Path "$snapshot\server\app.py")) { throw 'production snapshot missing' }
if (-not (Test-Path "$snapshot\web\src\main.js")) { throw 'production web snapshot missing' }
if (Test-Path "$snapshot\web\runtime-config.js") { throw 'sanitized snapshot must not retain runtime-config.js' }
$snapshotItem = Get-Item -LiteralPath $snapshot -Force
if (-not $snapshotItem.PSIsContainer -or
    ($snapshotItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'production snapshot root is not a real directory'
}
$snapshotReparsePoints = @()
$pendingSnapshotDirectories = [Collections.Generic.Stack[string]]::new()
$pendingSnapshotDirectories.Push($snapshotItem.FullName)
while ($pendingSnapshotDirectories.Count -gt 0) {
  foreach ($child in Get-ChildItem -LiteralPath $pendingSnapshotDirectories.Pop() -Force) {
    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $snapshotReparsePoints += $child.FullName
    } elseif ($child.PSIsContainer) {
      $pendingSnapshotDirectories.Push($child.FullName)
    }
  }
}
if ($snapshotReparsePoints.Count -ne 0) { throw 'production snapshot contains a symlink/junction/reparse point' }
$capturedAt = $snapshotItem.CreationTime.ToString('yyyy-MM-ddTHH:mm:sszzz')
if ($capturedAt -ne '2026-07-22T16:32:54+08:00') { throw "unexpected snapshot creation time: $capturedAt" }
$sanitizedSync = Join-Path $snapshot 'deploy\sync.sh'
if (Test-Path -LiteralPath $sanitizedSync) { throw 'sanitized snapshot must not contain deploy/sync.sh' }
$sanitizedDeployDoc = Join-Path $snapshot 'docs\deploy.md'
if (Test-Path -LiteralPath $sanitizedDeployDoc) { throw 'sanitized snapshot must not contain credential-bearing docs/deploy.md' }
$sanitizedHandoff = Join-Path $snapshot 'docs\HANDOFF.md'
if (Test-Path -LiteralPath $sanitizedHandoff) { throw 'sanitized snapshot must not contain credential-bearing docs/HANDOFF.md' }
$sanitizedModelNotes = Join-Path $snapshot 'docs\model-notes.md'
if (Test-Path -LiteralPath $sanitizedModelNotes) { throw 'sanitized snapshot must not contain credential-bearing docs/model-notes.md' }
if (-not (Test-Path -LiteralPath $vendorStartPath) -or
    -not (Test-Path -LiteralPath $runtimeConfigStartPath) -or
    -not (Test-Path -LiteralPath $runtimeConfigKeyPath)) {
  throw 'private external-runtime start evidence is incomplete'
}
$vendorStart = Get-Content -Raw -Encoding UTF8 $vendorStartPath | ConvertFrom-Json
if ($vendorStart.schemaVersion -ne 1 -or $vendorStart.regularFileCount -ne 460 -or
    $vendorStart.symlinkCount -ne 0 -or
    $vendorStart.treeSha256 -ne '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049' -or
    $vendorStart.contentCaptured -ne $false) {
  throw 'private vendor start evidence does not match the planning audit'
}
$runtimeConfigStart = Get-Content -Raw -Encoding UTF8 $runtimeConfigStartPath | ConvertFrom-Json
if ($runtimeConfigStart.schemaVersion -ne 1 -or $runtimeConfigStart.byteCount -ne 171 -or
    $runtimeConfigStart.integrityScheme -ne 'HMAC-SHA256' -or
    $runtimeConfigStart.hmac -notmatch '^[0-9a-f]{64}$' -or
    $runtimeConfigStart.contentCaptured -ne $false -or
    (Get-Item -LiteralPath $runtimeConfigKeyPath).Length -eq 0) {
  throw 'private runtime config start evidence is invalid'
}
$revision = git rev-parse origin/beta
if ($LASTEXITCODE -ne 0) { throw 'cannot resolve origin/beta' }
if ($revision -ne '3cf686eb1dd2ed356594904e2f366805ae7dd11a') { throw "unexpected beta revision: $revision" }
$betaSymlinkEntries = @(git ls-tree -r $revision | Select-String '^120000 ')
if ($LASTEXITCODE -ne 0 -or $betaSymlinkEntries.Count -ne 0) { throw 'pinned beta contains a symlink entry' }
git status --short --ignored | Select-String '\.audit'
```

Expected: 生产两个 core 文件存在，快照目录创建时间与审计记录一致，快照 root 本身及其整棵子树都没有 reparse point，冻结 beta tree 没有 symlink mode；runtime config 及已知含凭证形态文本的 `deploy/sync.sh`、`docs/deploy.md`、`docs/HANDOFF.md`、`docs/model-notes.md` 在内容快照中均不存在；vendor 460/0/聚合 SHA 私有证据、runtime config HMAC/DPAPI 私有证据完整；beta ref 是冻结 SHA；`.audit` 不出现在本 worktree 的待提交文件中。每次 manifest 运行都从这个 SHA 新建覆盖整个安全 beta tree 的 archive/tree，不能复用可能被污染的旧展开目录，也不能对持续变化的当前 HEAD 重算“生产基线”。

- [ ] **Step 2: 写入不含凭证的 metadata**

`2026-07-22-metadata.json` 内容固定采用以下事实；`capturedAt` 使用快照实际抓取时间的 ISO-8601 +08:00 值：

```json
{
  "schemaVersion": 1,
  "sourceHost": "192.168.9.140",
  "sourceRoot": "/srv/deploy/flock-voice-engine",
  "capturedVia": "yfhuang-read-only",
  "capturedAt": "2026-07-22T16:32:54+08:00",
  "productionEndpoint": "http://192.168.9.140:8090",
  "containerName": "flock-voice-engine",
  "effectiveContract": {
    "sampleRate": 44100,
    "blockSamples": 4096,
    "poolSize": 5,
    "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
    "speciesModelEndpoint": "http://127.0.0.1:8081/v1",
    "speciesModel": "bird_agent"
  },
  "gitProvenance": {
    "selectedBase": "origin/beta",
    "selectedRevision": "3cf686eb1dd2ed356594904e2f366805ae7dd11a",
    "webSrcMatch": "35/35",
    "serverControlledMatch": "13/13",
    "deployMatch": "4/4",
    "activeLegacyClientMatch": "5/5"
  },
  "externalRuntimeInputs": {
    "vendor": {
      "productionPath": "vendor",
      "mountedAt": "/app/vendor",
      "mountMode": "ro",
      "contentCaptured": false,
      "regularFileCount": 460,
      "symlinkCount": 0,
      "treeSha256": "21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049",
      "treeHashAlgorithm": "sha256 of LC_ALL=C path-sorted sha256sum lines",
      "reconstructability": "content-fingerprinted-only",
      "sources": [
        {
          "component": "midibrave",
          "documentedOrigin": "Octopus:/home/jyhu/MidiBrave",
          "revision": "unknown"
        },
        {
          "component": "midibrave-v2",
          "documentedOrigin": "Octopus:/home/jyhu/MidiBrave-v2",
          "revision": "unknown"
        },
        {
          "component": "trajectorybrave",
          "documentedOrigin": "jyhu-trajectorybrave-demo:/opt/trajectorybrave/src/trajectorybrave",
          "revision": "unknown"
        }
      ]
    },
    "runtimeConfig": {
      "productionPath": "web/runtime-config.js",
      "mountedAt": "/app/web/runtime-config.js",
      "mountMode": "ro",
      "servedBy": "mvp/index.html",
      "byteCount": 171,
      "contentCaptured": false,
      "integrityScheme": "private HMAC-SHA256 start/end comparison",
      "integrityValueCommitted": false
    }
  },
  "ignoredDeploymentTrees": {
    "client": "部署根 client 是未被容器提供的旧混合副本",
    "vendor": "实际只读运行输入；内容不进入快照/manifest entry，由 externalRuntimeInputs.vendor 固定聚合指纹并声明 revision 缺口",
    "web/runtime-config.js": "实际页面运行输入；内容不捕获、不提交，由私有 HMAC-SHA256 做 Phase 0 前后完整性证明",
    "web/assets/timbre": "作为 served-timbre-assets 副本单独校验到 engine canonical assets",
    "deploy/sync.sh": "含明文凭证的废弃脚本；审计快照和 Git archive 均按精确路径清除，不读取、不 hash",
    "docs/deploy.md": "历史部署文档含凭证形态文本；两侧证据包按精确路径清除，不读取、不 hash",
    "docs/HANDOFF.md": "历史交接文档含凭证形态文本；两侧证据包按精确路径清除，不读取、不 hash",
    "docs/model-notes.md": "历史模型文档含凭证形态文本；两侧证据包按精确路径清除，不读取、不 hash"
  },
  "credentialsCaptured": false
}
```

`capturedAt` 必须等于 Step 1 从快照目录读取并断言的值，不得使用当前时间重写；其它字段必须与已验证生产事实一致。写入后执行：

```powershell
$metadata = Get-Content -Raw -Encoding UTF8 docs/production-manifests/2026-07-22-metadata.json | ConvertFrom-Json
$vendorStart = Get-Content -Raw -Encoding UTF8 D:\workspace\spark_hackrothon\.audit\phase0-start\vendor.json | ConvertFrom-Json
if ($metadata.externalRuntimeInputs.vendor.regularFileCount -ne $vendorStart.regularFileCount -or
    $metadata.externalRuntimeInputs.vendor.symlinkCount -ne $vendorStart.symlinkCount -or
    $metadata.externalRuntimeInputs.vendor.treeSha256 -ne $vendorStart.treeSha256 -or
    $metadata.externalRuntimeInputs.vendor.reconstructability -ne 'content-fingerprinted-only') {
  throw 'committed vendor metadata differs from private start evidence'
}
if ($metadata.externalRuntimeInputs.runtimeConfig.contentCaptured -ne $false -or
    $metadata.externalRuntimeInputs.runtimeConfig.integrityValueCommitted -ne $false -or
    $metadata.externalRuntimeInputs.runtimeConfig.integrityScheme -ne 'private HMAC-SHA256 start/end comparison') {
  throw 'runtime config metadata leaks or overstates private integrity evidence'
}
```

- [ ] **Step 3: 写入已知差异的显式 decisions**

`2026-07-22-decisions.json` 必须包含以下 disposition：

```json
{
  "schemaVersion": 1,
  "decisions": {
    "engine-server:production-only:flock-voice-engine/server/brave.py": {
      "disposition": "ignore-deployed-artifact",
      "reason": "无引用且相对导入失效的历史死副本"
    },
    "active-legacy-client:production-only:flock-voice-engine/client/vc2.html": {
      "disposition": "ignore-deployed-artifact",
      "reason": "线上临时诊断页，不属于标准 client"
    },
    "active-legacy-client:production-only:flock-voice-engine/client/vctest.html": {
      "disposition": "ignore-deployed-artifact",
      "reason": "线上临时诊断页，不属于标准 client"
    },
    "engine-docs:production-only:flock-voice-engine/docs/ecological-latent-control.md": {
      "disposition": "deduplicate",
      "reason": "内容已由 Git 根 docs/ecological-latent-control.md 管理"
    },
    "engine-assets:production-only:flock-voice-engine/assets/timbre_bank.json": {
      "disposition": "ignore-deployed-artifact",
      "reason": "生成资产，不作为 canonical 输入"
    },
    "mvp-runtime-example:changed:mvp/runtime-config.example.js": {
      "disposition": "retain-repository",
      "reason": "Git beta 是已验证的后继配置模板；真实 runtime-config 被排除"
    },
    "mvp-readme:changed:mvp/README.md": {
      "disposition": "retain-repository",
      "reason": "部署说明副本落后于 beta；保留 Git 后继"
    },
    "mvp-tools:changed:mvp/tools/serve-nocache.py": {
      "disposition": "retain-repository",
      "reason": "部署工具副本落后于 beta；工具不参与在线请求路径"
    },
    "engine-brief:changed:flock-voice-engine/BRIEF.md": {
      "disposition": "retain-repository",
      "reason": "线上说明是旧热拷贝；保留 Git beta 后继"
    },
    "engine-readme:changed:flock-voice-engine/README.md": {
      "disposition": "retain-repository",
      "reason": "线上说明是旧热拷贝；保留 Git beta 后继并在 Phase 0 校正文档"
    },
    "engine-docs:changed:flock-voice-engine/docs/client-integration.md": {
      "disposition": "retain-repository",
      "reason": "线上文档是旧热拷贝；保留 Git 后继并在 Phase 0 重写身份信息"
    },
    "engine-docs:changed:flock-voice-engine/docs/protocol.md": {
      "disposition": "retain-repository",
      "reason": "线上文档是旧热拷贝；保留 Git 后继并补 release identity"
    },
    "mvp-tests:changed:mvp/test/agent.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/audio.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/ecological-latent.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/economy.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/eval-harness.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/harmony.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/jungle.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/latent-roamer-control.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/llm-openai-client.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/master-external.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/master-llm.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/master-policy.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/product-surface.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/scene-layout.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/timeline.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/ui-ring-a11y.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    },
    "mvp-tests:changed:mvp/test/world.test.js": {
      "disposition": "retain-repository",
      "reason": "部署测试副本落后于 beta；测试不参与在线运行"
    }
  }
}
```

如果工具报告的 key 与这里不一致，修正工具的 canonical path 计算；不得添加模糊 glob decision。

- [ ] **Step 4: 先无 decisions 暴露完整差异，再应用逐项 disposition**

```powershell
$snapshot = 'D:\workspace\spark_hackrothon\.audit\production-20260722-plan'
$revision = '3cf686eb1dd2ed356594904e2f366805ae7dd11a'
$auditRoot = 'D:\workspace\spark_hackrothon\.audit'
$runId = [Guid]::NewGuid().ToString('N')
$gitZip = Join-Path $auditRoot "git-beta-3cf686eb-$runId.zip"
$gitSnapshot = Join-Path $auditRoot "git-beta-3cf686eb-$runId"
$remotePassPattern = 'REMOTE_' + 'PASS='
$cnPasswordPattern = ('密' + '码') + '.{0,12}[:=：]'
$gitCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|' + $remotePassPattern + '|password[[:space:]]*[:=]|passwd[[:space:]]*[:=]|' + $cnPasswordPattern
$credentialBlobs = @(git grep -Iil -E $gitCredentialPattern $revision -- .)
if ($LASTEXITCODE -gt 1) { throw 'cannot scan pinned beta credential paths' }
$credentialPaths = @($credentialBlobs | ForEach-Object { $_.Substring($revision.Length + 1) } | Sort-Object)
$expectedCredentialPaths = @(
  'docs/melody-lattice-handoff.md',
  'flock-voice-engine/deploy/sync.sh',
  'flock-voice-engine/docs/HANDOFF.md',
  'flock-voice-engine/docs/deploy.md',
  'flock-voice-engine/docs/model-notes.md',
  'spark-docs/docs/melody-lattice-handoff.md',
  'spark-docs/flock-voice-engine/docs/HANDOFF.md',
  'spark-docs/flock-voice-engine/docs/deploy.md',
  'spark-docs/flock-voice-engine/docs/model-notes.md'
) | Sort-Object
$credentialPathDifference = @(Compare-Object $credentialPaths $expectedCredentialPaths)
if ($credentialPathDifference.Count -ne 0) { $credentialPathDifference | Format-Table; throw 'pinned beta credential path set changed' }
$forbiddenArchivePaths = @('mvp/runtime-config.js') + $expectedCredentialPaths
$archiveExcludes = @($forbiddenArchivePaths | ForEach-Object { ":(exclude)$_" })
git archive --format=zip --output=$gitZip $revision -- . $archiveExcludes
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $gitZip)) { throw 'cannot archive pinned beta tree' }
$archiveEntries = @(tar -tf $gitZip)
if ($LASTEXITCODE -ne 0) { throw 'cannot list pinned beta archive' }
$credentialArchiveEntries = @($archiveEntries | Where-Object { $_ -in $forbiddenArchivePaths })
if ($credentialArchiveEntries.Count -ne 0) { throw 'sanitized beta archive still contains credential-bearing paths' }
$treeFiles = @(git ls-tree -r --name-only $revision)
if ($LASTEXITCODE -ne 0) { throw 'cannot enumerate pinned beta tree' }
$expectedArchiveFiles = @($treeFiles | Where-Object { $_ -notin $forbiddenArchivePaths } | Sort-Object)
$actualArchiveFiles = @($archiveEntries | Where-Object { -not $_.EndsWith('/') } | Sort-Object)
$archiveCoverageDifference = @(Compare-Object $expectedArchiveFiles $actualArchiveFiles)
if ($archiveCoverageDifference.Count -ne 0) { $archiveCoverageDifference | Format-Table; throw 'sanitized archive does not cover the full safe beta tree' }
Expand-Archive -LiteralPath $gitZip -DestinationPath $gitSnapshot
$expandedCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|' + $remotePassPattern + '|password\s*[:=]|passwd\s*[:=]|' + $cnPasswordPattern
$expandedCredentialHits = @(rg -l -i $expandedCredentialPattern $gitSnapshot)
if ($LASTEXITCODE -gt 1) { throw 'cannot scan expanded beta archive' }
if ($expandedCredentialHits.Count -ne 0) { $expandedCredentialHits; throw 'expanded beta archive contains credential-shaped text' }

function Get-NormalizedTextSha256([string]$path) {
  $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8).Replace("`r`n", "`n").Replace("`r", "`n")
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
}
$productionEcology = Join-Path $snapshot 'docs\ecological-latent-control.md'
$canonicalEcology = Join-Path $gitSnapshot 'docs\ecological-latent-control.md'
if ((Get-NormalizedTextSha256 $productionEcology) -ne (Get-NormalizedTextSha256 $canonicalEcology)) {
  throw 'cannot deduplicate ecological-latent-control.md: canonical content differs'
}

$unreviewedOutput = Join-Path $auditRoot "production-unreviewed-$runId.json"
python flock-voice-engine/tools/production_manifest.py `
  --snapshot-root $snapshot `
  --repository-root $gitSnapshot `
  --metadata docs/production-manifests/2026-07-22-metadata.json `
  --output $unreviewedOutput `
  --fail-unreviewed
if ($LASTEXITCODE -ne 2) { throw 'empty-decision discovery must exit 2' }
$discovery = Get-Content -Raw -Encoding UTF8 $unreviewedOutput | ConvertFrom-Json
if ($discovery.summary.unmapped -ne 0) { throw 'production snapshot contains unmapped files' }
$reportedKeys = @(
  $discovery.entries |
    Where-Object { $_.disposition -eq 'unreviewed' } |
    ForEach-Object { "$($_.mapping):$($_.status):$($_.repositoryPath)" } |
    Sort-Object
)
$decisionDocument = Get-Content -Raw -Encoding UTF8 docs/production-manifests/2026-07-22-decisions.json | ConvertFrom-Json
$expectedKeys = @($decisionDocument.decisions.PSObject.Properties.Name | Sort-Object)
$keyDifference = @(Compare-Object -ReferenceObject $reportedKeys -DifferenceObject $expectedKeys)
if ($keyDifference.Count -ne 0) { $keyDifference | Format-Table; throw 'decision keys do not exactly match discovered differences' }

python flock-voice-engine/tools/production_manifest.py `
  --snapshot-root $snapshot `
  --repository-root $gitSnapshot `
  --metadata docs/production-manifests/2026-07-22-metadata.json `
  --decisions docs/production-manifests/2026-07-22-decisions.json `
  --output docs/production-manifests/2026-07-22-production.json `
  --fail-unreviewed
if ($LASTEXITCODE -ne 0) { throw 'reviewed manifest generation failed' }
```

Expected: 无 decisions 的第一次运行必须 exit 2，且它暴露的 key 集合与 decisions 文件逐项完全相等；生态潜空间文档只有在规范化 SHA 相等后才允许 `deduplicate`；第二次运行 exit 0 且 `summary.unreviewed == 0`。任何 key 漂移都必须重新核对具体文件、Git blob 历史和 active 容器提供路径，不能用默认 ignore。

- [ ] **Step 5: 用机器断言核心 active scopes 没有内容漂移**

```powershell
$manifest = Get-Content -Raw -Encoding UTF8 docs/production-manifests/2026-07-22-production.json | ConvertFrom-Json
$dirtyCore = $manifest.entries | Where-Object {
  $_.mapping -in @('mvp-src','mvp-index','engine-server','engine-deploy','active-legacy-client','served-timbre-assets') -and
  $_.status -eq 'changed'
}
if ($dirtyCore) { $dirtyCore | Format-Table; throw 'active production tree drifted' }
if ($manifest.summary.unreviewed -ne 0) { throw 'manifest has unreviewed differences' }
if ($manifest.summary.unmapped -ne 0) { throw 'manifest does not cover every sanitized content-snapshot file' }
$vendorMetadata = $manifest.metadata.externalRuntimeInputs.vendor
if ($vendorMetadata.regularFileCount -ne 460 -or $vendorMetadata.symlinkCount -ne 0 -or
    $vendorMetadata.treeSha256 -ne '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049' -or
    $vendorMetadata.reconstructability -ne 'content-fingerprinted-only') {
  throw 'manifest lost the external vendor fingerprint or reconstructability gap'
}
$runtimeConfigMetadata = $manifest.metadata.externalRuntimeInputs.runtimeConfig
if ($runtimeConfigMetadata.contentCaptured -ne $false -or
    $runtimeConfigMetadata.integrityValueCommitted -ne $false -or
    $runtimeConfigMetadata.integrityScheme -ne 'private HMAC-SHA256 start/end comparison') {
  throw 'manifest lost the private runtime config integrity contract'
}
function Assert-EntryCount([string]$mapping, [string]$status, [int]$expected) {
  $actual = @($manifest.entries | Where-Object { $_.mapping -eq $mapping -and $_.status -eq $status }).Count
  if ($actual -ne $expected) { throw "$mapping/$status expected $expected, got $actual" }
}
Assert-EntryCount 'mvp-src' 'same' 35
Assert-EntryCount 'mvp-index' 'same' 1
Assert-EntryCount 'engine-server' 'same' 13
Assert-EntryCount 'engine-server' 'production-only' 1
Assert-EntryCount 'engine-deploy' 'same' 3
Assert-EntryCount 'engine-gitignore' 'same' 1
Assert-EntryCount 'active-legacy-client' 'same' 5
Assert-EntryCount 'active-legacy-client' 'production-only' 2
Assert-EntryCount 'served-timbre-assets' 'same' 5
Assert-EntryCount 'served-timbre-assets' 'repository-only' 1
```

Expected: 没有表格输出，所有冻结计数精确相等，命令 exit 0。`engine-server` 允许已 disposition 的 production-only `brave.py`；`active-legacy-client` 允许两个已 disposition 的临时页；served timbre 的 repository-only 1 是未复制到 web 的 `atlas.json`。九个 credential-bearing path 与 `mvp/runtime-config.js` 在进入 archive/manifest 前被精确清除，绝不成为 content hash entry；vendor/runtime config 作为明确的 out-of-band runtime input 出现在 metadata，不能被 `unmapped == 0` 掩盖。metadata 中的 deploy 4/4 是清理前只读溯源事实，manifest 可安全 hash 的 deploy entry 是 3/3。

- [ ] **Step 6: 确认不会错误收编 stale root client**

```powershell
$manifest = Get-Content -Raw -Encoding UTF8 docs/production-manifests/2026-07-22-production.json | ConvertFrom-Json
$staleEntries = @($manifest.entries | Where-Object { $_.productionPath.StartsWith('client/') })
$staleExcluded = @($manifest.excluded | Where-Object { $_.productionPath.StartsWith('client/') })
if ($staleEntries.Count -ne 0) { throw 'stale root client leaked into canonical entries' }
if ($staleExcluded.Count -ne 4) { throw "expected 4 explicitly excluded stale client files, got $($staleExcluded.Count)" }
```

Expected: stale root client 的 4 个文件全部且仅出现在 excluded；active client 的 entry production path 必须来自 `web/_client/`。

- [ ] **Step 7: 提交生产基线证据**

```powershell
git add docs/production-manifests
git commit -m "chore: capture 2026-07-22 production baseline"
```

---

### Task 4：给当前 Python 服务增加 release 与 owner 身份

**Files:**

- Create: `flock-voice-engine/server/release_info.py`
- Create: `flock-voice-engine/tests/conftest.py`
- Create: `flock-voice-engine/tests/test_release_info.py`
- Modify: `flock-voice-engine/server/app.py`
- Modify: `flock-voice-engine/docs/protocol.md`

**Status contract added in Phase 0:**

```json
{
  "releaseRevision": "40-char-git-sha-or-unknown",
  "sourceManifestSha256": "64-char-sha256-or-unknown",
  "protocolFamily": "legacy-decoder",
  "protocolVersion": 1,
  "runtimeOwner": "browser",
  "audioOwner": "legacy"
}
```

这些字段同时出现在 `/healthz`、`/api/decoder-status` 和 WebSocket `ready`；不改变现有 PCM 或 control/note 协议。`legacy-decoder` 在 Phase 0–4 只能声明精确 owner tuple `(browser, legacy)`；未来 `(server, world)` 只属于 Phase 5 原子切换后的 Node `flock-runtime`，不能通过给旧 Python 服务改环境变量提前伪装。

- [ ] **Step 1: 先写 release info 的失败测试**

`test_release_info.py`：

```python
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from server.release_info import PROTOCOL_FAMILY, PROTOCOL_VERSION, ReleaseInfo


def test_defaults_describe_current_phase_zero_ownership() -> None:
    with patch.dict(os.environ, {}, clear=True):
        info = ReleaseInfo.from_env()
    assert info.release_revision == "unknown"
    assert info.source_manifest_sha256 == "unknown"
    assert info.protocol_family == "legacy-decoder" == PROTOCOL_FAMILY
    assert info.protocol_version == 1 == PROTOCOL_VERSION
    assert info.runtime_owner == "browser"
    assert info.audio_owner == "legacy"


def test_reads_full_git_revision_with_phase_zero_owners() -> None:
    revision = "3cf686eb1dd2ed356594904e2f366805ae7dd11a"
    manifest_sha256 = "a" * 64
    with patch.dict(os.environ, {
        "FLOCK_BUILD_REVISION": revision,
        "FLOCK_SOURCE_MANIFEST_SHA256": manifest_sha256,
        "FLOCK_RUNTIME_OWNER": "browser",
        "FLOCK_AUDIO_OWNER": "legacy",
    }, clear=True):
        info = ReleaseInfo.from_env()
    assert info.as_payload() == {
        "releaseRevision": revision,
        "sourceManifestSha256": manifest_sha256,
        "protocolFamily": "legacy-decoder",
        "protocolVersion": 1,
        "runtimeOwner": "browser",
        "audioOwner": "legacy",
    }


@pytest.mark.parametrize("name,value", [
    ("FLOCK_BUILD_REVISION", "not-a-git-sha"),
    ("FLOCK_SOURCE_MANIFEST_SHA256", "not-a-sha256"),
    ("FLOCK_RUNTIME_OWNER", "server"),
    ("FLOCK_AUDIO_OWNER", "world"),
])
def test_rejects_invalid_release_identity(name: str, value: str) -> None:
    with patch.dict(os.environ, {name: value}, clear=True):
        with pytest.raises(ValueError):
            ReleaseInfo.from_env()


def test_revision_and_manifest_must_be_declared_together() -> None:
    with patch.dict(os.environ, {"FLOCK_BUILD_REVISION": "b" * 40}, clear=True):
        with pytest.raises(ValueError):
            ReleaseInfo.from_env()
```

同时创建 `flock-voice-engine/tests/conftest.py`，让整套 voice pytest 从仓库根执行时都有一致 import root：

```python
from __future__ import annotations

import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))
```

- [ ] **Step 2: 运行测试确认缺模块**

```powershell
$releaseRed = python -m pytest flock-voice-engine/tests/test_release_info.py -q 2>&1
$releaseRedExit = $LASTEXITCODE
if ($releaseRedExit -eq 0 -or -not ($releaseRed | Select-String -SimpleMatch 'server.release_info')) {
  $releaseRed
  throw 'release red test did not fail for the expected missing module'
}
```

Expected: FAIL，`ModuleNotFoundError: server.release_info`。

完成后所有测试命令都不得依赖调用者预先设置 `PYTHONPATH`。

- [ ] **Step 3: 实现不可变 release info 与严格校验**

`release_info.py` 的完整数据模型：

```python
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Mapping

PROTOCOL_FAMILY = "legacy-decoder"
PROTOCOL_VERSION = 1
_GIT_SHA = re.compile(r"[0-9a-f]{40}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
RUNTIME_OWNER = "browser"
AUDIO_OWNER = "legacy"


@dataclass(frozen=True)
class ReleaseInfo:
    release_revision: str
    source_manifest_sha256: str
    protocol_family: str
    protocol_version: int
    runtime_owner: str
    audio_owner: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ReleaseInfo":
        source = os.environ if env is None else env
        revision = source.get("FLOCK_BUILD_REVISION", "unknown").strip()
        manifest_sha256 = source.get("FLOCK_SOURCE_MANIFEST_SHA256", "unknown").strip()
        runtime_owner = source.get("FLOCK_RUNTIME_OWNER", "browser").strip()
        audio_owner = source.get("FLOCK_AUDIO_OWNER", "legacy").strip()
        if revision != "unknown" and _GIT_SHA.fullmatch(revision) is None:
            raise ValueError("FLOCK_BUILD_REVISION 必须是完整 40 位小写 Git SHA")
        if manifest_sha256 != "unknown" and _SHA256.fullmatch(manifest_sha256) is None:
            raise ValueError("FLOCK_SOURCE_MANIFEST_SHA256 必须是 64 位小写 SHA-256")
        if (revision == "unknown") != (manifest_sha256 == "unknown"):
            raise ValueError("release revision 与 source manifest 必须同时已知或同时 unknown")
        if (runtime_owner, audio_owner) != (RUNTIME_OWNER, AUDIO_OWNER):
            raise ValueError(
                "legacy-decoder 在 Phase 0–4 只能声明 runtimeOwner=browser/audioOwner=legacy"
            )
        return cls(
            revision,
            manifest_sha256,
            PROTOCOL_FAMILY,
            PROTOCOL_VERSION,
            runtime_owner,
            audio_owner,
        )

    def as_payload(self) -> dict[str, str | int]:
        return {
            "releaseRevision": self.release_revision,
            "sourceManifestSha256": self.source_manifest_sha256,
            "protocolFamily": self.protocol_family,
            "protocolVersion": self.protocol_version,
            "runtimeOwner": self.runtime_owner,
            "audioOwner": self.audio_owner,
        }
```

- [ ] **Step 4: 在 app 启动时只解析一次，并加入三个响应面**

把 `build_app()` 改成 `build_app(config: EngineConfig, release_info: ReleaseInfo | None = None)`，并在函数第一行执行 `release_info = release_info or ReleaseInfo.from_env()`，再开始 `make_backend()/load()`；非法发布环境必须在加载重模型前 fail-fast。`status_payload()` 合并 `**release_info.as_payload()`；`healthz()` 也合并同一 payload。WebSocket ready 已展开 `status_payload()`，因此自动继承，不能另造第二套值。

`app.py` 的 package import 分支加入 `from .release_info import ReleaseInfo`，直接脚本 fallback 分支加入 `from server.release_info import ReleaseInfo`，两种现有启动方式都必须通过。

在内置 selftest 中新增：

```python
assert status["releaseRevision"] == "unknown"
assert status["sourceManifestSha256"] == "unknown"
assert status["protocolFamily"] == "legacy-decoder"
assert status["protocolVersion"] == 1
assert status["runtimeOwner"] == "browser"
assert status["audioOwner"] == "legacy"
```

并对 `/healthz` 的同六字段做相同断言。selftest 显式构造 `ReleaseInfo("unknown", "unknown", "legacy-decoder", 1, "browser", "legacy")` 传给 `build_app()`，不能受调用 shell 中残留的 `FLOCK_*` 环境变量影响。

- [ ] **Step 5: 运行单元和集成测试**

```powershell
python -m pytest flock-voice-engine/tests/test_release_info.py -q
if ($LASTEXITCODE -ne 0) { throw 'release info tests failed' }
python flock-voice-engine/server/app.py --selftest
if ($LASTEXITCODE -ne 0) { throw 'voice selftest failed after release identity change' }
```

Expected: 7 tests passed；`app.py 自测通过`。

- [ ] **Step 6: 更新 legacy protocol 文档并提交**

在 `protocol.md` 的 HTTP/ready payload 表中加入上述六字段，并明确标注“候选源码契约：只有下一次受控 release 后线上 8090 才保证出现；Phase 0 结束时当前 8090 可能仍无这些字段”。默认 owner 只是描述候选代码对应的当前职责，不会让服务器开始 world tick。`protocolFamily="legacy-decoder"` 将当前 decoder 与后续 `flock-runtime` 区分，`protocolVersion` 始终保持数值类型。

```powershell
git add flock-voice-engine/server/release_info.py `
  flock-voice-engine/server/app.py `
  flock-voice-engine/tests/conftest.py `
  flock-voice-engine/tests/test_release_info.py `
  flock-voice-engine/docs/protocol.md
git commit -m "feat(voice): expose release and owner identity"
```

---

### Task 5：删除旧凭证入口并把 active 部署脚本迁到 yfhuang 身份

**Files:**

- Create: `flock-voice-engine/tests/test_deploy_contract.py`
- Create: `flock-voice-engine/tests/test_tool_paths.py`
- Modify: `flock-voice-engine/deploy/docker-run.sh`
- Modify: `flock-voice-engine/deploy/Dockerfile`
- Modify: `flock-voice-engine/server/app.py`
- Modify: `flock-voice-engine/.gitignore`
- Create: `flock-voice-engine/tools/project_paths.py`
- Modify: `flock-voice-engine/tools/bench_compute.py`
- Modify: `flock-voice-engine/tools/build_latent_map.py`
- Modify: `flock-voice-engine/tools/build_voice_maps.py`
- Modify: `flock-voice-engine/tools/collapse_probe.py`
- Modify: `flock-voice-engine/tools/descriptors.py`
- Modify: `flock-voice-engine/tools/dump_timbre_net.py`
- Modify: `flock-voice-engine/tools/render_pca100.py`
- Modify: `flock-voice-engine/tools/roam_probe.py`
- Modify: `flock-voice-engine/BRIEF.md`
- Modify: `flock-voice-engine/docs/HANDOFF.md`
- Modify: `flock-voice-engine/docs/deploy.md`
- Modify: `flock-voice-engine/docs/latent-map.md`
- Modify: `flock-voice-engine/docs/model-notes.md`
- Modify: `flock-voice-engine/docs/protocol.md`
- Delete: `flock-voice-engine/deploy/run.sh`
- Delete: `flock-voice-engine/deploy/sync.sh`
- Delete: `spark-docs/flock-voice-engine/` (含凭证形态文本的生成副本，canonical tree 在上方)
- Modify: `docs/melody-lattice-handoff.md`
- Modify: `spark-docs/docs/melody-lattice-handoff.md`
- External modify: `D:/workspace/spark_hackrothon/validate_agent_prompts.py`
- External modify: `D:/workspace/spark_hackrothon/eco_sim_server.py`
- External modify: `D:/workspace/spark_hackrothon/dl-nvfp4.service`
- External create: `D:/workspace/spark_hackrothon/.audit/phase0-external-sanitization.json`

Phase 0 只修源码和本地文件；不得把新脚本同步到服务器或重启当前容器。

- [ ] **Step 1: 先写 active deploy contract 的失败测试**

`test_deploy_contract.py`：

```python
from __future__ import annotations

import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy"


def test_only_supported_docker_entrypoint_remains() -> None:
    assert (DEPLOY / "docker-run.sh").is_file()
    assert not (DEPLOY / "run.sh").exists()
    assert not (DEPLOY / "sync.sh").exists()


def test_active_deploy_uses_yfhuang_and_srv_release_paths() -> None:
    script = (DEPLOY / "docker-run.sh").read_text(encoding="utf-8")
    assert "EXPECTED_OPERATOR=yfhuang" in script
    assert "PROJECT=/srv/deploy/flock-voice-engine" in script
    assert 'RUN_UID="$(id -u)"' in script
    assert 'RUN_GID="$(id -g)"' in script
    assert 'LOG_DIR="$PROJECT/logs"' in script
    assert "--user \"$RUN_UID:$RUN_GID\"" in script
    assert "FLOCK_BUILD_REVISION" in script
    assert "FLOCK_SOURCE_MANIFEST_SHA256" in script
    assert "FLOCK_RUNTIME_OWNER=browser" in script
    assert "FLOCK_AUDIO_OWNER=legacy" in script
    assert "verify_status_identity" in script


def test_active_deploy_has_no_password_automation_or_legacy_home() -> None:
    active = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (DEPLOY / "docker-run.sh", DEPLOY / "Dockerfile")
    )
    banned = (
        "REMOTE_PASS",
        "expect -c",
        "StrictHostKeyChecking=no",
        "/home/" + "rolf",
        "--user " + "1005:1005",
    )
    for token in banned:
        assert token not in active


def test_engine_tree_has_no_legacy_operator_or_personal_home() -> None:
    roots = (
        ROOT / "BRIEF.md",
        ROOT / "deploy",
        ROOT / "docs",
        ROOT / "server",
        ROOT / "tools",
    )
    forbidden = (
        "/home/" + "rolf",
        "ssh " + "rolf@",
        "ProxyJump=" + "rolf",
        "--user " + "1005:1005",
    )
    candidates = []
    for root in roots:
        candidates.extend([root] if root.is_file() else [path for path in root.rglob("*") if path.is_file()])
    for path in candidates:
        if path.suffix.lower() not in {".md", ".py", ".sh"} and path.name != "Dockerfile":
            continue
        text = path.read_text(encoding="utf-8")
        for token in forbidden:
            assert token not in text, f"{path.relative_to(ROOT)} 仍含 legacy identity: {token}"


def test_wrong_operator_is_rejected_before_docker_is_called() -> None:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = windows_git_bash if windows_git_bash.is_file() else Path("/bin/bash")
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行部署契约测试"
    with tempfile.TemporaryDirectory() as directory:
        stub_bin = Path(directory)
        identifier = stub_bin / "id"
        docker = stub_bin / "docker"
        identifier.write_text("#!/bin/sh\nprintf 'intruder\\n'\n", encoding="utf-8")
        docker.write_text("#!/bin/sh\nprintf 'docker-called\\n'\nexit 99\n", encoding="utf-8")
        identifier.chmod(0o755)
        docker.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = str(stub_bin) + os.pathsep + env["PATH"]
        result = subprocess.run(
            [str(bash), str(DEPLOY / "docker-run.sh"), "status"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
    assert result.returncode == 1
    assert "yfhuang" in result.stderr
    assert "docker-called" not in result.stdout


def test_restart_preflights_missing_or_invalid_release_before_docker_mutation() -> None:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = windows_git_bash if windows_git_bash.is_file() else Path("/bin/bash")
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行部署契约测试"
    cases = (
        ("missing", None, None),
        ("invalid", "not-a-git-sha", "not-a-manifest-sha"),
    )
    for label, revision, manifest_sha in cases:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "project"
            stub_bin = root / "bin"
            project.mkdir()
            stub_bin.mkdir()
            if revision is not None:
                (project / ".release-revision").write_text(revision + "\n", encoding="utf-8")
            if manifest_sha is not None:
                (project / ".release-source-manifest.sha256").write_text(
                    manifest_sha + "\n", encoding="utf-8"
                )
            identifier = stub_bin / "id"
            docker = stub_bin / "docker"
            call_log = root / "docker-calls.txt"
            identifier.write_text(
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "  -un) printf 'yfhuang\\n' ;;\n"
                "  -u) printf '1001\\n' ;;\n"
                "  -g) printf '1001\\n' ;;\n"
                "  -nG) printf 'docker\\n' ;;\n"
                "  *) exit 2 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            docker.write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {shlex.quote(call_log.as_posix())}\n"
                "if [ \"$1\" = run ]; then exit 99; fi\n"
                "exit 0\n",
                encoding="utf-8",
            )
            identifier.chmod(0o755)
            docker.chmod(0o755)
            script_copy = root / "docker-run.sh"
            script_text = (DEPLOY / "docker-run.sh").read_text(encoding="utf-8")
            assert script_text.count("PROJECT=/srv/deploy/flock-voice-engine") == 1
            script_text = script_text.replace(
                "PROJECT=/srv/deploy/flock-voice-engine",
                f"PROJECT={shlex.quote(project.as_posix())}",
            )
            script_copy.write_text(script_text, encoding="utf-8")
            script_copy.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = str(stub_bin) + os.pathsep + env["PATH"]
            result = subprocess.run(
                [str(bash), str(script_copy), "restart"],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )
            calls = call_log.read_text(encoding="utf-8").splitlines() if call_log.exists() else []
        assert result.returncode == 1, f"{label}: restart 应 fail closed"
        assert not any(call.startswith(("rm ", "run ", "stop ")) for call in calls), (
            f"{label}: release 预检失败后发生 Docker 写操作: {calls}"
        )


def test_status_is_read_only_and_validates_endpoint_release_identity() -> None:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = windows_git_bash if windows_git_bash.is_file() else Path("/bin/bash")
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行部署契约测试"
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        project = root / "project"
        stub_bin = root / "bin"
        project.mkdir()
        stub_bin.mkdir()
        (project / ".release-revision").write_text("a" * 40 + "\n", encoding="utf-8")
        (project / ".release-source-manifest.sha256").write_text("b" * 64 + "\n", encoding="utf-8")
        call_log = root / "docker-calls.txt"
        (stub_bin / "id").write_text(
            "#!/bin/sh\ncase \"$1\" in -un) echo yfhuang;; -u|-g) echo 1001;; *) exit 2;; esac\n",
            encoding="utf-8",
        )
        (stub_bin / "docker").write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' \"$*\" >> {shlex.quote(call_log.as_posix())}\n"
            "if [ \"$1\" = inspect ]; then echo true; fi\n"
            "if [ \"$1\" = rm ] || [ \"$1\" = run ]; then exit 99; fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        matching = (
            '{"releaseRevision":"' + "a" * 40
            + '","sourceManifestSha256":"' + "b" * 64
            + '","protocolFamily":"legacy-decoder","protocolVersion":1,'
            + '"runtimeOwner":"browser","audioOwner":"legacy"}'
        )
        mismatch = (
            '{"releaseRevision":"' + "c" * 40
            + '","sourceManifestSha256":"' + "d" * 64
            + '","protocolFamily":"legacy-decoder","protocolVersion":1,'
            + '"runtimeOwner":"browser","audioOwner":"legacy"}'
        )
        payload_file = root / "healthz.json"
        (stub_bin / "curl").write_text(
            "#!/bin/sh\ncat " + shlex.quote(payload_file.as_posix()) + "\n",
            encoding="utf-8",
        )
        (stub_bin / "python3").write_text(
            "#!/bin/sh\nexec " + shlex.quote(Path(sys.executable).as_posix()) + ' "$@"\n',
            encoding="utf-8",
        )
        for executable in ("id", "docker", "curl", "python3"):
            (stub_bin / executable).chmod(0o755)
        script_copy = root / "docker-run.sh"
        script_text = (DEPLOY / "docker-run.sh").read_text(encoding="utf-8")
        assert script_text.count("PROJECT=/srv/deploy/flock-voice-engine") == 1
        script_copy.write_text(
            script_text.replace(
                "PROJECT=/srv/deploy/flock-voice-engine",
                f"PROJECT={shlex.quote(project.as_posix())}",
            ),
            encoding="utf-8",
        )
        script_copy.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = str(stub_bin) + os.pathsep + env["PATH"]
        for label, payload, expected_returncode in (
            ("matching", matching, 0),
            ("mismatch", mismatch, 1),
        ):
            payload_file.write_text(payload + "\n", encoding="utf-8")
            call_log.unlink(missing_ok=True)
            result = subprocess.run(
                [str(bash), str(script_copy), "status"],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )
            calls = call_log.read_text(encoding="utf-8").splitlines()
            assert result.returncode == expected_returncode, (
                f"{label}: stdout={result.stdout!r}, stderr={result.stderr!r}"
            )
            assert not any(call.startswith(("rm ", "run ", "stop ")) for call in calls)
            if label == "matching":
                assert any(call == "ps" or call.startswith("ps ") for call in calls)
                assert any(call == "stats" or call.startswith("stats ") for call in calls)
            else:
                assert "release" in (result.stdout + result.stderr).lower()
```

`test_tool_paths.py`：

```python
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest


ENGINE_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = ENGINE_ROOT / "tools"
TEST_PACKAGE = "_phase0_tool_paths"

ENV_KEYS = (
    "FLOCK_STAGING_ROOT",
    "FLOCK_MIDIBRAVE_ROOT",
    "FLOCK_TIMBRE_WEIGHTS",
)

TOOL_SCRIPTS = (
    "bench_compute",
    "build_latent_map",
    "build_voice_maps",
    "collapse_probe",
    "descriptors",
    "dump_timbre_net",
    "render_pca100",
    "roam_probe",
)


def fresh_test_package() -> None:
    for name in tuple(sys.modules):
        if name == TEST_PACKAGE or name.startswith(f"{TEST_PACKAGE}."):
            del sys.modules[name]

    package = types.ModuleType(TEST_PACKAGE)
    package.__package__ = TEST_PACKAGE
    package.__path__ = [str(TOOLS_ROOT)]
    sys.modules[TEST_PACKAGE] = package


def load_tool(name: str):
    module_name = f"{TEST_PACKAGE}.{name}"
    path = TOOLS_ROOT / f"{name}.py"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def assert_path_arguments(namespace, expected: dict[str, Path]) -> None:
    for attribute, value in expected.items():
        actual = getattr(namespace, attribute)
        assert isinstance(actual, Path), f"{attribute} 必须由 argparse 返回 Path"
        assert actual == value


def test_project_paths_have_project_relative_defaults(monkeypatch) -> None:
    for name in ENV_KEYS:
        monkeypatch.delenv(name, raising=False)

    fresh_test_package()
    paths = load_tool("project_paths")

    assert paths.ENGINE_ROOT == ENGINE_ROOT
    assert paths.STAGING_ROOT == ENGINE_ROOT / "staging"
    assert paths.VENDOR_MIDIBRAVE == ENGINE_ROOT / "vendor/midibrave/src"
    assert paths.TIMBRE_WEIGHTS == ENGINE_ROOT / "staging/timbre_net.npz"


def test_project_paths_apply_environment_precedence(monkeypatch, tmp_path) -> None:
    staging = tmp_path / "custom-staging"
    vendor = tmp_path / "custom-vendor"

    monkeypatch.setenv("FLOCK_STAGING_ROOT", str(staging))
    monkeypatch.setenv("FLOCK_MIDIBRAVE_ROOT", str(vendor))
    monkeypatch.delenv("FLOCK_TIMBRE_WEIGHTS", raising=False)

    fresh_test_package()
    paths = load_tool("project_paths")
    assert paths.STAGING_ROOT == staging
    assert paths.VENDOR_MIDIBRAVE == vendor
    assert paths.TIMBRE_WEIGHTS == staging / "timbre_net.npz"

    explicit_weights = tmp_path / "explicit-weights.npz"
    monkeypatch.setenv("FLOCK_TIMBRE_WEIGHTS", str(explicit_weights))

    fresh_test_package()
    paths = load_tool("project_paths")
    assert paths.TIMBRE_WEIGHTS == explicit_weights


def test_all_tool_defaults_and_explicit_cli_paths(monkeypatch, tmp_path) -> None:
    staging = tmp_path / "env-staging"
    vendor = tmp_path / "env-vendor"
    weights = tmp_path / "env-weights.npz"
    explicit = tmp_path / "explicit"

    monkeypatch.setenv("FLOCK_STAGING_ROOT", str(staging))
    monkeypatch.setenv("FLOCK_MIDIBRAVE_ROOT", str(vendor))
    monkeypatch.setenv("FLOCK_TIMBRE_WEIGHTS", str(weights))

    fresh_test_package()
    load_tool("project_paths")

    cases = (
        (
            "bench_compute",
            {
                "out": staging / "bench_compute.json",
                "selection": staging / "pca100/selection_100.json",
            },
            [
                "-o", str(explicit / "bench.json"),
                "--selection", str(explicit / "selection.json"),
            ],
            {
                "out": explicit / "bench.json",
                "selection": explicit / "selection.json",
            },
        ),
        (
            "build_latent_map",
            {"weights": weights},
            ["--weights", str(explicit / "latent-weights.npz")],
            {"weights": explicit / "latent-weights.npz"},
        ),
        (
            "build_voice_maps",
            {
                "input": staging / "voice_clap_extracted.json",
                "out": ENGINE_ROOT / "assets/timbre/voice_maps",
            },
            [
                "--input", str(explicit / "voice-input.json"),
                "--out", str(explicit / "voice-maps"),
            ],
            {
                "input": explicit / "voice-input.json",
                "out": explicit / "voice-maps",
            },
        ),
        (
            "collapse_probe",
            {
                "weights": weights,
                "out": staging / "collapse_probe.npz",
            },
            [
                "--weights", str(explicit / "collapse-weights.npz"),
                "--out", str(explicit / "collapse.npz"),
            ],
            {
                "weights": explicit / "collapse-weights.npz",
                "out": explicit / "collapse.npz",
            },
        ),
        (
            "descriptors",
            {"out": staging / "descriptors.json"},
            ["--out", str(explicit / "descriptors.json")],
            {"out": explicit / "descriptors.json"},
        ),
        (
            "render_pca100",
            {
                "indir": staging / "pca100",
                "out": staging / "pca100/renders",
                "vendor": vendor,
            },
            [
                "--in", str(explicit / "pca-input"),
                "--out", str(explicit / "pca-renders"),
                "--vendor", str(explicit / "render-vendor"),
            ],
            {
                "indir": explicit / "pca-input",
                "out": explicit / "pca-renders",
                "vendor": explicit / "render-vendor",
            },
        ),
        (
            "roam_probe",
            {
                "anchors": staging / "anchors_partial.json",
                "out": staging / "roam",
                "vendor": vendor,
            },
            [
                "--anchors", str(explicit / "anchors.json"),
                "--out", str(explicit / "roam"),
                "--vendor", str(explicit / "roam-vendor"),
            ],
            {
                "anchors": explicit / "anchors.json",
                "out": explicit / "roam",
                "vendor": explicit / "roam-vendor",
            },
        ),
    )

    for name, defaults, command_line, overridden in cases:
        module = load_tool(name)
        assert_path_arguments(module.parse_args([]), defaults)
        assert_path_arguments(module.parse_args(command_line), overridden)

    dump = load_tool("dump_timbre_net")
    assert_path_arguments(dump.parse_args([]), {"out": weights})

    checkpoint = explicit / "checkpoint.pt"
    legacy_out = explicit / "legacy-output.npz"
    legacy = dump.parse_args([str(checkpoint), str(legacy_out)])
    assert_path_arguments(legacy, {"checkpoint": checkpoint, "out": legacy_out})

    flag_out = explicit / "flag-output.npz"
    flagged = dump.parse_args([str(checkpoint), "--out", str(flag_out)])
    assert_path_arguments(flagged, {"checkpoint": checkpoint, "out": flag_out})

    with pytest.raises(SystemExit):
        dump.parse_args(
            [str(checkpoint), str(legacy_out), "--out", str(flag_out)]
        )


@pytest.mark.parametrize("name", TOOL_SCRIPTS)
def test_direct_help_has_no_model_data_or_filesystem_side_effects(
    name: str, tmp_path: Path
) -> None:
    environment = os.environ.copy()
    environment["FLOCK_STAGING_ROOT"] = str(tmp_path / "must-not-create-staging")
    environment["FLOCK_MIDIBRAVE_ROOT"] = str(tmp_path / "missing-vendor")
    environment["FLOCK_TIMBRE_WEIGHTS"] = str(tmp_path / "missing-weights.npz")
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"

    result = subprocess.run(
        [sys.executable, str(TOOLS_ROOT / f"{name}.py"), "--help"],
        cwd=tmp_path,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
    )

    assert result.returncode == 0, (
        f"{name} --help 失败：stdout={result.stdout!r}, "
        f"stderr={result.stderr!r}"
    )
    assert "usage:" in (result.stdout + result.stderr).lower()
    assert list(tmp_path.iterdir()) == [], f"{name} --help 不得创建任何文件或目录"
```

- [ ] **Step 2: 运行测试确认旧脚本与身份导致失败**

```powershell
python -m pytest `
  flock-voice-engine/tests/test_deploy_contract.py `
  flock-voice-engine/tests/test_tool_paths.py `
  -q
```

Expected: FAIL；至少报告 `run.sh/sync.sh` 仍存在、active script/工具/文档仍含旧身份路径，证明旧 `restart` 会在 release 预检前删除容器，并显示工具尚无无副作用 `parse_args()`/`--help` 契约。

- [ ] **Step 3: 删除两条已废弃且危险的入口**

```powershell
git rm flock-voice-engine/deploy/run.sh flock-voice-engine/deploy/sync.sh
```

删除原因由 Task 7 统一写进 `deploy.md`：venv/nohup 入口会与 Docker 抢 8090；旧 sync 含密码自动应答且直接热覆盖 production。Phase 5 会提供原子 release 工具，在此之前没有 `--apply` 热同步脚本。

- [ ] **Step 4: 把 docker-run.sh 改成单一 operator、动态 UID/GID 和 release identity**

脚本顶部运行契约固定为：

```bash
EXPECTED_OPERATOR=yfhuang
if [[ "$(id -un)" != "$EXPECTED_OPERATOR" ]]; then
  echo "错误：本服务只允许 $EXPECTED_OPERATOR 操作" >&2
  exit 1
fi
docker info >/dev/null 2>&1 || {
  echo "错误：$EXPECTED_OPERATOR 当前不能访问 Docker；不要改用其它账号或 sudo 绕过" >&2
  exit 1
}

DOCKER=docker
IMAGE=twiddle/flock-voice-engine:latest
NAME=flock-voice-engine
PORT=8090
PROJECT=/srv/deploy/flock-voice-engine
LOG_DIR="$PROJECT/logs"
RUN_UID="$(id -u)"
RUN_GID="$(id -g)"
```

抽出 `preflight_release()`，在 `start` 和 `restart` 的任何容器写操作之前读取并严格校验 release 文件：

```bash
preflight_release() {
  local revision_file="$PROJECT/.release-revision"
  local manifest_sha_file="$PROJECT/.release-source-manifest.sha256"
  [[ -r "$revision_file" ]] || {
    echo "错误：缺少 $revision_file；拒绝启动无法追溯的 release" >&2
    return 1
  }
  [[ -r "$manifest_sha_file" ]] || {
    echo "错误：缺少 $manifest_sha_file；拒绝启动没有源码 manifest 的 release" >&2
    return 1
  }
  RELEASE_REVISION="$(tr -d '\r\n' < "$revision_file")"
  SOURCE_MANIFEST_SHA256="$(tr -d '\r\n' < "$manifest_sha_file")"
  [[ "$RELEASE_REVISION" =~ ^[0-9a-f]{40}$ ]] || {
    echo "错误：release revision 必须是完整 40 位 Git SHA" >&2
    return 1
  }
  [[ "$SOURCE_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "错误：source manifest hash 必须是 64 位 SHA-256" >&2
    return 1
  }
}
```

`preflight_release()` 只做读取/校验并设置 `RELEASE_REVISION`、`SOURCE_MANIFEST_SHA256`；`install -d` 移到预检成功之后。case 调度顺序固定为：`start -> preflight_release -> start_container`，`restart -> preflight_release -> stop_container -> start_container`。`restart` 不得先递归调用 `stop`；缺失或非法 release 文件时允许前面的 `docker info` 只读探测，但绝不能执行 `docker rm/run` 或其它状态改变。测试通过复制真实脚本并仅替换测试 project 路径来验证这一顺序，生产脚本不得加入测试专用路径开关。

再实现只读 `verify_status_identity()`：把 `/healthz` JSON 通过 stdin 交给 `python3 -c` 的 `json.load(sys.stdin)`，并将 payload 精确比对为 `releaseRevision=$RELEASE_REVISION`、`sourceManifestSha256=$SOURCE_MANIFEST_SHA256`、`protocolFamily=legacy-decoder`、`protocolVersion=1`、`runtimeOwner=browser`、`audioOwner=legacy`；字段缺失、类型错误或任一不等都向 stderr 输出不含凭证的 `release identity mismatch` 并 exit 1。`status` 检测到容器正在运行时，顺序必须是 `preflight_release -> curl healthz -> verify_status_identity -> 展示 ps/stats`；整个分支不得调用 `install/docker rm/docker run`。这样磁盘 release 标记、容器环境和 endpoint 自述形成三方闭环，而不是只打印一段不可核对的 JSON。

容器参数修改为：

```bash
--user "$RUN_UID:$RUN_GID"
-v "$LOG_DIR:/app/logs"
-e FLOCK_VOICE_LOAD_LOG=/app/logs/flock-voice-load.jsonl
-e FLOCK_BUILD_REVISION="$RELEASE_REVISION"
-e FLOCK_SOURCE_MANIFEST_SHA256="$SOURCE_MANIFEST_SHA256"
-e FLOCK_RUNTIME_OWNER=browser
-e FLOCK_AUDIO_OWNER=legacy
```

保留 `/data/model_weights/midiBrave:ro`、宿主机 CUDA site-packages 只读挂载、`--gpus all`、8090、block 4096、pool 5 和 `--static /app/web`。不得改动模型、端口或性能参数。

- [ ] **Step 5: 将 app 的日志路径改成环境注入**

`app.py` 顶层改为：

```python
LOAD_LOG_PATH = Path(
    os.environ.get("FLOCK_VOICE_LOAD_LOG", "/tmp/flock-voice-load.jsonl")
)
```

补 `import os`。默认 `/tmp` 仅用于本地/selftest；生产由容器环境明确指向 `/app/logs`。`.gitignore` 加：

```gitignore
logs/
.release-revision
.release-source-manifest.sha256
```

保持 `flock-voice-engine/.gitignore` 现有 `staging/*.wav/__pycache__/*.pyc/.venv` 忽略语义，只追加 release/log 条目；终端若显示乱码，不得据此改写内容，manifest 已按 UTF-8+换行归一确认线上与 Git 基线相同。

Phase 0 不提供手工伪造这两个文件的命令，也不启动新脚本；Phase 5 的原子 release builder 必须从 clean Git HEAD 生成 staged source manifest，写入完整 Git SHA 与 manifest SHA-256，再让候选 status 与发布记录互相核对。缺任一文件时 `start` 必须 fail closed。这样 Phase 0 暴露的是可审计字段，不把任意环境字符串宣称为已验证 release。

- [ ] **Step 6: 清理 Dockerfile 注释中的个人路径和固定 UID**

构建示例统一为：

```bash
cd /srv/deploy/flock-voice-engine
docker build -f deploy/Dockerfile -t twiddle/flock-voice-engine:latest .
```

注释说明运行时 UID/GID 由 `docker-run.sh` 从 `yfhuang` 动态取得；Dockerfile 不创建第二个个人用户。

- [ ] **Step 7: 先冻结并清理 tracked 凭证形态文本，删除生成镜像**

只输出文件名，不把值打印到终端或计划中：

```powershell
$remotePassPattern = 'REMOTE_' + 'PASS='
$cnPasswordPattern = ('密' + '码') + '.{0,12}[:=：]'
$trackedCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|' + $remotePassPattern + '|password[[:space:]]*[:=]|passwd[[:space:]]*[:=]|' + $cnPasswordPattern
$beforeCredentialFiles = @(git grep -Iil -E $trackedCredentialPattern -- .)
if ($LASTEXITCODE -gt 1) { throw 'cannot enumerate tracked credential files' }
if (Test-Path flock-voice-engine/deploy/sync.sh) { throw 'deleted sync entrypoint returned' }
$expectedCredentialFiles = @(
  'docs/melody-lattice-handoff.md',
  'flock-voice-engine/docs/HANDOFF.md',
  'flock-voice-engine/docs/deploy.md',
  'flock-voice-engine/docs/model-notes.md',
  'spark-docs/docs/melody-lattice-handoff.md',
  'spark-docs/flock-voice-engine/docs/HANDOFF.md',
  'spark-docs/flock-voice-engine/docs/deploy.md',
  'spark-docs/flock-voice-engine/docs/model-notes.md'
) | Sort-Object
$credentialDifference = @(Compare-Object ($beforeCredentialFiles | Sort-Object) $expectedCredentialFiles)
if ($credentialDifference.Count -ne 0) { $credentialDifference | Format-Table; throw 'tracked credential file set changed' }
git rm -r spark-docs/flock-voice-engine
```

旧 sync 已在 Step 3 删除；两份 melody handoff 与 canonical `docs/{HANDOFF,deploy,model-notes}.md` 删除值或改成 `${DEEPSEEK_API_KEY}`/只读 secret file 注入说明。生成的 `spark-docs/flock-voice-engine/` 整棵删除，因为它既重复 canonical 文档又复制了凭证形态文本；Task 7 只给 `spark-docs/README.md` 加单向指针。不得把真实值移到另一份 tracked 文件，也不在本阶段重写公共 Git 历史。

- [ ] **Step 8: 把工具默认路径改成 project-relative/显式环境，不保留个人 home**

创建 `tools/project_paths.py`：

```python
from __future__ import annotations

import os
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
STAGING_ROOT = Path(os.environ.get("FLOCK_STAGING_ROOT", ENGINE_ROOT / "staging"))
VENDOR_MIDIBRAVE = Path(
    os.environ.get("FLOCK_MIDIBRAVE_ROOT", ENGINE_ROOT / "vendor" / "midibrave" / "src")
)
TIMBRE_WEIGHTS = Path(
    os.environ.get("FLOCK_TIMBRE_WEIGHTS", STAGING_ROOT / "timbre_net.npz")
)
```

八个脚本全部从该模块取默认值；已有 CLI 参数继续优先，缺参数的脚本补 `argparse` 参数，禁止重新硬编码任何用户名：

| 脚本 | 新的默认/参数 |
|---|---|
| `bench_compute.py` | `--out $STAGING_ROOT/bench_compute.json`、`--selection $STAGING_ROOT/pca100/selection_100.json` |
| `build_latent_map.py` | `--weights $TIMBRE_WEIGHTS` |
| `build_voice_maps.py` | `--input $STAGING_ROOT/voice_clap_extracted.json`、`--out` project-relative |
| `collapse_probe.py` | `--weights $TIMBRE_WEIGHTS`、`--out $STAGING_ROOT/collapse_probe.npz` |
| `descriptors.py` | `--out $STAGING_ROOT/descriptors.json` |
| `dump_timbre_net.py` | positional/`--out` 默认 `$TIMBRE_WEIGHTS`，保留现有显式参数兼容 |
| `render_pca100.py` | `--in/--out` 位于 `$STAGING_ROOT/pca100`，`--vendor` 默认 `$VENDOR_MIDIBRAVE` |
| `roam_probe.py` | `--anchors/--out` 位于 `$STAGING_ROOT`，`--vendor` 默认 `$VENDOR_MIDIBRAVE` |

八个脚本统一暴露无副作用的 `build_parser() -> argparse.ArgumentParser`、`parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace`、`main(argv: Sequence[str] | None = None) -> int | None`；各自从 `collections.abc` 导入 `Sequence`。`parse_args` 与直接执行入口必须逐字采用：

```python
def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
```

每个 `main()` 的第一条可执行语句都是 `args = parse_args(argv)`；只有该语句返回后，才允许加载模型/数据、创建目录或写文件。每个 `build_parser()` 保留原参数和非路径默认值，并精确增加上表中的路径参数。

所有路径参数使用 `type=Path`，所以 `parse_args()` 返回的 `out/selection/weights/input/indir/vendor/anchors/checkpoint` 等路径属性都是 `Path`。同时兼容包导入与直接脚本执行：

```python
if __package__:
    from .project_paths import STAGING_ROOT, TIMBRE_WEIGHTS, VENDOR_MIDIBRAVE
else:
    from project_paths import STAGING_ROOT, TIMBRE_WEIGHTS, VENDOR_MIDIBRAVE
```

`collapse_probe.py`、`descriptors.py`、`dump_timbre_net.py`、`roam_probe.py` 当前在 import 时直接执行；把原有操作逐行移动到 `main()`，不改计算顺序。`build_voice_maps.py` 的 backend import、两处 vendor `sys.path` 注入、模型/checkpoint 加载、输入读取、`mkdir` 与所有写文件动作同样移到 `parse_args()` 之后。这样 `python tools/<name>.py --help` 在路径不存在时仍只打印帮助并 exit 0。

`dump_timbre_net.py` 的 parser 必须保留 `CHECKPOINT [OUT]` 两个旧位置参数，并增加 `--out`；默认 checkpoint 仍是 `/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt`，默认输出为 `TIMBRE_WEIGHTS`。只给旧位置 `OUT` 时继续有效；同时给位置 `OUT` 与 `--out` 时调用 `parser.error()`，不得静默选择。其余脚本由 argparse 自然保证“显式 CLI > 环境计算出的默认值 > project-relative 默认值”。

同步更新 `BRIEF.md`、`docs/latent-map.md`、`docs/protocol.md` 的示例为 `/srv/deploy/flock-voice-engine` + `yfhuang` 或 project-relative CLI；`server/app.py` 的旧日志注释与 Step 5 的环境路径保持一致。不得改变算法、模型、非路径默认数值或输出格式，只迁移路径来源与把 import-time 操作包进 `main()`。

- [ ] **Step 9: 清理非 Git 运维工作区中的明文 key/token**

使用 `apply_patch` 修改三个外部文件：

- `validate_agent_prompts.py` 和 `eco_sim_server.py`：使用 `os.environ.get("DEEPSEEK_API_KEY")`，只在真正调用 provider 时对缺失值给出中文错误；模块 import 和不调用云模型的测试不能因缺 key 失败。
- `dl-nvfp4.service`：删除内嵌 HF token，改用 `EnvironmentFile=-/home/yfhuang/.config/huggingface.env`；该 secret file 不进仓库。

这些文件不在 Git 中。修改后先用 `Get-FileHash -Algorithm SHA256` 取三份文件的新 hash，再使用 `apply_patch` 创建 `.audit/phase0-external-sanitization.json`，固定结构为 `{"schemaVersion":1,"credentialsCaptured":false,"files":[{"path":"validate_agent_prompts.py","sha256":"..."}, ...]}`；`path` 只用工作区相对路径，数组按 path 排序，不记录旧 hash、key 值或环境值。现有 token/password 应视为已暴露，轮换需要凭证所有者另行授权，Phase 0 不自行调用外部账户 API。

- [ ] **Step 10: 运行测试、Python 语法与静态 secret 复核**

```powershell
python -m pytest `
  flock-voice-engine/tests/test_deploy_contract.py `
  flock-voice-engine/tests/test_tool_paths.py `
  -q
if ($LASTEXITCODE -ne 0) { throw 'deploy contract tests failed' }
$gitBash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $gitBash)) { throw 'Git Bash not found' }
& $gitBash -n flock-voice-engine/deploy/docker-run.sh
if ($LASTEXITCODE -ne 0) { throw 'docker-run.sh syntax check failed' }
python -m compileall -q flock-voice-engine/server flock-voice-engine/tools
if ($LASTEXITCODE -ne 0) { throw 'voice Python syntax check failed' }
$remotePassPattern = 'REMOTE_' + 'PASS='
$cnPasswordPattern = ('密' + '码') + '.{0,12}[:=：]'
$trackedCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|' + $remotePassPattern + '|password[[:space:]]*[:=]|passwd[[:space:]]*[:=]|' + $cnPasswordPattern
$trackedHits = @(git grep -Iil -E $trackedCredentialPattern -- .)
if ($LASTEXITCODE -gt 1) { throw 'git secret scan failed' }
if ($trackedHits.Count -ne 0) { $trackedHits; throw 'tracked secret remains' }
$legacyIdentityHits = @(git grep -Il -E '/home/rolf|ssh[[:space:]]+rolf@|ProxyJump[[:space:]]*=[[:space:]]*rolf|--user[[:space:]]+1005:1005' -- flock-voice-engine)
if ($LASTEXITCODE -gt 1) { throw 'legacy identity scan failed' }
if ($legacyIdentityHits.Count -ne 0) { $legacyIdentityHits; throw 'legacy operator path remains in active engine tree' }
$externalCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|REMOTE_PASS|password\s*[:=]|passwd\s*[:=]|' + $cnPasswordPattern
$externalHits = @(rg -l -i $externalCredentialPattern `
  D:\workspace\spark_hackrothon\validate_agent_prompts.py `
  D:\workspace\spark_hackrothon\eco_sim_server.py `
  D:\workspace\spark_hackrothon\dl-nvfp4.service
)
if ($LASTEXITCODE -gt 1) { throw 'external secret scan failed' }
if ($externalHits.Count -ne 0) { $externalHits; throw 'external secret remains' }
python -m py_compile `
  D:\workspace\spark_hackrothon\validate_agent_prompts.py `
  D:\workspace\spark_hackrothon\eco_sim_server.py
if ($LASTEXITCODE -ne 0) { throw 'external Python syntax check failed' }
$importSmoke = @'
import importlib.util
import sys
from pathlib import Path

for raw_path in sys.argv[1:]:
    path = Path(raw_path)
    name = f"phase0_smoke_{path.stem}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
'@
$previousDeepSeekKey = $env:DEEPSEEK_API_KEY
Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
try {
  $importSmoke | python - `
    D:\workspace\spark_hackrothon\validate_agent_prompts.py `
    D:\workspace\spark_hackrothon\eco_sim_server.py
  if ($LASTEXITCODE -ne 0) { throw 'external Python import smoke failed without DEEPSEEK_API_KEY' }
} finally {
  if ($null -eq $previousDeepSeekKey) {
    Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:DEEPSEEK_API_KEY = $previousDeepSeekKey
  }
}
$externalAuditPath = 'D:\workspace\spark_hackrothon\.audit\phase0-external-sanitization.json'
if (-not (Test-Path $externalAuditPath)) { throw 'external sanitization audit record missing' }
$externalAudit = Get-Content -Raw -Encoding UTF8 $externalAuditPath | ConvertFrom-Json
if ($externalAudit.schemaVersion -ne 1 -or $externalAudit.credentialsCaptured -ne $false) {
  throw 'external sanitization audit metadata invalid'
}
$workspaceRoot = 'D:\workspace\spark_hackrothon'
$expectedExternalPaths = @('dl-nvfp4.service', 'eco_sim_server.py', 'validate_agent_prompts.py')
$recordedExternalPaths = @($externalAudit.files.path | Sort-Object)
if (@(Compare-Object $recordedExternalPaths $expectedExternalPaths).Count -ne 0) {
  throw 'external sanitization audit file set mismatch'
}
foreach ($entry in $externalAudit.files) {
  $actualHash = (Get-FileHash -LiteralPath (Join-Path $workspaceRoot $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($entry.sha256 -ne $actualHash) { throw "external audit hash mismatch: $($entry.path)" }
}
$auditRoot = 'D:\workspace\spark_hackrothon\.audit'
$auditCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|REMOTE_PASS|password\s*[:=]|passwd\s*[:=]|' + $cnPasswordPattern
$auditTextHits = @(rg -l -i $auditCredentialPattern `
  $auditRoot -g '!*.zip'
)
if ($LASTEXITCODE -gt 1) { throw 'audit secret scan failed' }
if ($auditTextHits.Count -ne 0) { $auditTextHits; throw 'audit text copy still contains a known secret' }
$archiveLeaks = @()
foreach ($archive in Get-ChildItem -LiteralPath $auditRoot -Recurse -Filter '*.zip' -File) {
  $entries = @(tar -tf $archive.FullName)
  if ($LASTEXITCODE -ne 0) { throw "cannot list audit archive: $($archive.Name)" }
  $archiveLeaks += @($entries | Where-Object {
    $normalized = $_ -replace '\\','/'
    $normalized -eq 'deploy/sync.sh' -or
      $normalized -like '*/deploy/sync.sh' -or
      $normalized -eq 'docs/deploy.md' -or
      $normalized -like '*/docs/deploy.md' -or
      $normalized -eq 'docs/HANDOFF.md' -or
      $normalized -like '*/docs/HANDOFF.md' -or
      $normalized -eq 'docs/model-notes.md' -or
      $normalized -like '*/docs/model-notes.md' -or
      $normalized -eq 'mvp/runtime-config.js' -or
      $normalized -like '*/mvp/runtime-config.js' -or
      $normalized -eq 'web/runtime-config.js' -or
      $normalized -like '*/web/runtime-config.js' -or
      $normalized -eq 'docs/melody-lattice-handoff.md' -or
      $normalized -like '*/docs/melody-lattice-handoff.md'
  })
}
if ($archiveLeaks.Count -ne 0) { $archiveLeaks; throw 'audit archive still contains credential-bearing paths' }
```

Expected: 18 tests passed（7 个 deploy contract、3 个路径解析行为、8 个脚本 `--help`）；Git Bash `-n`、engine compileall、外部 Python py_compile 与“清空 key 后 import”均 exit 0；所有 secret/identity 搜索都没有文件输出，外部审计 hash 与当前文件一致。不能用测试允许列表掩盖真实 key。

- [ ] **Step 11: 提交 tracked 变更**

```powershell
git add flock-voice-engine/.gitignore `
  flock-voice-engine/deploy `
  flock-voice-engine/server/app.py `
  flock-voice-engine/tests/test_deploy_contract.py `
  flock-voice-engine/tests/test_tool_paths.py `
  flock-voice-engine/tools/project_paths.py `
  flock-voice-engine/tools/bench_compute.py `
  flock-voice-engine/tools/build_latent_map.py `
  flock-voice-engine/tools/build_voice_maps.py `
  flock-voice-engine/tools/collapse_probe.py `
  flock-voice-engine/tools/descriptors.py `
  flock-voice-engine/tools/dump_timbre_net.py `
  flock-voice-engine/tools/render_pca100.py `
  flock-voice-engine/tools/roam_probe.py `
  flock-voice-engine/BRIEF.md `
  flock-voice-engine/docs/HANDOFF.md `
  flock-voice-engine/docs/deploy.md `
  flock-voice-engine/docs/latent-map.md `
  flock-voice-engine/docs/model-notes.md `
  flock-voice-engine/docs/protocol.md `
  docs/melody-lattice-handoff.md `
  spark-docs/docs/melody-lattice-handoff.md
git commit -m "chore(deploy): migrate active tooling to yfhuang"
```

---

### Task 6：修复 JavaScript/voice 测试入口并建立 Phase 0 门禁

**Files:**

- Create: `tools/check-js.mjs`
- Create: `test/check-js.test.js`
- Modify: `package.json`

- [ ] **Step 1: 先写动态 JS checker 的失败测试**

`test/check-js.test.js`：

```javascript
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectInlineScripts,
  collectJavaScriptFiles,
  checkInlineScripts,
  checkJavaScriptFiles,
} from '../tools/check-js.mjs';

test('递归发现 js/mjs 并稳定排序', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-js-'));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'z.js'), 'export const z = 1;\n');
  writeFileSync(join(root, 'nested', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'nested', 'ignore.txt'), 'not javascript\n');
  assert.deepEqual(
    collectJavaScriptFiles([root]).map((file) => file.slice(root.length + 1).replaceAll('\\', '/')),
    ['nested/a.mjs', 'z.js'],
  );
});

test('语法错误返回失败文件，合法文件通过', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-js-'));
  const good = join(root, 'good.js');
  const bad = join(root, 'bad.js');
  writeFileSync(good, 'const good = true;\n');
  writeFileSync(bad, 'const = ;\n');
  assert.deepEqual(checkJavaScriptFiles([good]), []);
  assert.deepEqual(checkJavaScriptFiles([bad]), [bad]);
});

test('检查 canonical legacy HTML 的内联脚本并忽略 src 脚本', () => {
  const validRoot = mkdtempSync(join(tmpdir(), 'check-inline-valid-'));
  const invalidRoot = mkdtempSync(join(tmpdir(), 'check-inline-invalid-'));
  writeFileSync(
    join(validRoot, 'valid.html'),
    '<script src="external.js"></script><script>const valid = true;</script>\n',
  );
  writeFileSync(join(invalidRoot, 'invalid.html'), '<script>const = ;</script>\n');
  const valid = collectInlineScripts([validRoot]);
  const invalid = collectInlineScripts([invalidRoot]);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 1);
  assert.deepEqual(checkInlineScripts(valid), []);
  assert.deepEqual(checkInlineScripts(invalid), [invalid[0].label]);
});
```

- [ ] **Step 2: 运行测试确认 checker 模块不存在**

```powershell
node --test test/check-js.test.js
```

Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向 `tools/check-js.mjs`。

- [ ] **Step 3: 实现跨平台 checker**

`tools/check-js.mjs` 使用以下完整实现：

```javascript
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);
const JAVASCRIPT_TYPES = new Set(['', 'application/javascript', 'module', 'text/javascript']);

function collectFiles(roots, extensions) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extensions.has(extname(entry.name))) found.push(path);
    }
  };
  for (const root of roots) visit(resolve(root));
  return found.sort((left, right) => left.localeCompare(right, 'en'));
}

export function collectJavaScriptFiles(roots) {
  return collectFiles(roots, JAVASCRIPT_EXTENSIONS);
}

export function checkJavaScriptFiles(files) {
  const failed = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0 || result.error) {
      failed.push(file);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) process.stderr.write(`${result.error.message}\n`);
    }
  }
  return failed;
}

export function collectInlineScripts(roots) {
  const found = [];
  for (const file of collectFiles(roots, new Set(['.html']))) {
    const html = readFileSync(file, 'utf8');
    const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    let ordinal = 0;
    while ((match = pattern.exec(html)) !== null) {
      const attributes = match[1];
      if (/\bsrc\s*=/i.test(attributes)) continue;
      const typeMatch = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i);
      const type = (typeMatch?.[1] ?? '').toLowerCase();
      if (!JAVASCRIPT_TYPES.has(type)) continue;
      ordinal += 1;
      found.push({
        label: `${file}#inline-${ordinal}`,
        source: match[2],
        module: type === 'module',
      });
    }
  }
  return found.sort((left, right) => left.label.localeCompare(right.label, 'en'));
}

export function checkInlineScripts(scripts) {
  const failed = [];
  for (const script of scripts) {
    const args = script.module ? ['--check', '--input-type=module', '-'] : ['--check', '-'];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', input: script.source });
    if (result.status !== 0 || result.error) {
      failed.push(script.label);
      if (result.stderr) process.stderr.write(`${script.label}\n${result.stderr}`);
      if (result.error) process.stderr.write(`${script.label}\n${result.error.message}\n`);
    }
  }
  return failed;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const files = collectJavaScriptFiles(['src', 'mvp/src', 'flock-voice-engine/client']);
  const inlineScripts = collectInlineScripts(['flock-voice-engine/client']);
  if (files.length === 0) {
    process.stderr.write('没有找到 JavaScript 源文件\n');
    process.exitCode = 1;
  } else {
    const failed = [...checkJavaScriptFiles(files), ...checkInlineScripts(inlineScripts)];
    if (failed.length > 0) process.exitCode = 1;
    else process.stdout.write(
      `checked ${files.length} JavaScript files and ${inlineScripts.length} inline scripts\n`,
    );
  }
}
```

实现行为：

- `collectJavaScriptFiles()` 用共享递归遍历器仅收 `.js/.mjs`，最终按绝对路径排序。
- `checkJavaScriptFiles()` 对每个文件执行 `spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })`，把非零退出文件加入数组，并把该进程 stderr 原样写到当前 stderr。
- `collectInlineScripts()` 只扫描 canonical `flock-voice-engine/client/*.html`，跳过带 `src=` 的外链脚本和非 JavaScript type，为每段内联代码生成稳定 `file#inline-N` 标签；`checkInlineScripts()` 通过 `node --check -` 从 stdin 校验，不生成临时源码文件。
- 直接执行脚本时检查 `src`、`mvp/src` 与会被部署到 `web/_client` 的 canonical `flock-voice-engine/client`；无文件时 exit 1；全部通过时打印实际文件数。
- 不硬编码单个源文件，因此以后增加/删除模块不会让 package script 引用幽灵路径。

- [ ] **Step 4: 运行 checker 单测与真实树检查**

```powershell
node --test test/check-js.test.js
node tools/check-js.mjs
```

Expected: 3 tests passed；在 beta 基线上打印 `checked 45 JavaScript files and 3 inline scripts` 并 exit 0。

- [ ] **Step 5: 修复 package scripts**

`package.json` 的 scripts 更新为：

```json
{
  "check": "node tools/check-js.mjs",
  "check:voice-python": "python -m compileall -q flock-voice-engine/server flock-voice-engine/tools",
  "test:voice": "python -m pytest flock-voice-engine/tests -q",
  "selftest:voice": "python flock-voice-engine/server/app.py --selftest",
  "verify:phase0": "npm test && npm run test:mvp && npm run check && npm run check:voice-python && npm run test:voice && npm run selftest:voice",
  "verify": "npm run verify:phase0 && npm run test:research && npm run test:native"
}
```

保留现有其它 script，不改变 research/native 的命令。

- [ ] **Step 6: 运行新的可信门禁**

```powershell
npm run verify:phase0
```

Expected: root Node tests、MVP tests、45 个 JS 文件与 3 段 active legacy HTML 内联脚本语法、全部 voice pytest 和 app selftest 都 exit 0；不再出现 `src/instrument/live-session.js`。

- [ ] **Step 7: 提交门禁修复**

```powershell
git add tools/check-js.mjs test/check-js.test.js package.json
git commit -m "test: repair phase zero verification gate"
```

---

### Task 7：把交接信息统一到实际生产事实并确认生成文档副本已删除

**Files:**

- Modify: `flock-voice-engine/BRIEF.md`
- Modify: `flock-voice-engine/README.md`
- Modify: `flock-voice-engine/docs/HANDOFF.md`
- Modify: `flock-voice-engine/docs/deploy.md`
- Modify: `flock-voice-engine/docs/client-integration.md`
- Create: `flock-voice-engine/tests/test_documentation_contract.py`
- Modify: `spark-docs/README.md`
- Verify absent: `spark-docs/flock-voice-engine/` (Task 5 已删除的生成镜像)
- External modify: `D:/workspace/spark_hackrothon/HANDOFF.md`
- External modify: `D:/workspace/spark_hackrothon/AGENTS.md`

- [ ] **Step 1: 先把文档事实清单写成失败测试**

`test_documentation_contract.py`：

```python
from __future__ import annotations

import re
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
CURRENT_FACT_DOCUMENTS = (
    ENGINE / "BRIEF.md",
    ENGINE / "README.md",
    ENGINE / "docs/HANDOFF.md",
)
RELEASE_CONTRACT_DOCUMENTS = (
    ENGINE / "docs/protocol.md",
    ENGINE / "docs/client-integration.md",
)
DEPLOY_DOCUMENT = ENGINE / "docs/deploy.md"
DOCUMENTS = CURRENT_FACT_DOCUMENTS + RELEASE_CONTRACT_DOCUMENTS + (
    DEPLOY_DOCUMENT,
    ENGINE / "docs/latent-map.md",
    ENGINE / "docs/model-notes.md",
)
REPOSITORY = ENGINE.parent
SPARK_README = REPOSITORY / "spark-docs/README.md"
GENERATED_ENGINE_MIRROR = REPOSITORY / "spark-docs/flock-voice-engine"


def test_each_current_fact_document_contains_current_production_contract() -> None:
    required = (
        "yfhuang",
        "/srv/deploy/flock-voice-engine",
        "44.1 kHz",
        "4096",
        "pool 5",
        "[bass,pad,lead,pluck,pad]",
        "bird_agent",
        "mvp/",
        "origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a",
        "vendor",
        "21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049",
        "revision unknown",
        "runtime-config.js",
        "HMAC-SHA256",
        "不能由 Git 重建",
    )
    for document in CURRENT_FACT_DOCUMENTS:
        text = document.read_text(encoding="utf-8")
        for token in required:
            assert token in text, f"{document.name} 缺少当前事实: {token}"


def test_release_contract_documents_cover_paired_identity_and_six_fields() -> None:
    fields = (
        "releaseRevision",
        "sourceManifestSha256",
        "protocolFamily",
        "protocolVersion",
        "runtimeOwner",
        "audioOwner",
    )
    for document in RELEASE_CONTRACT_DOCUMENTS:
        text = document.read_text(encoding="utf-8")
        assert "候选源码" in text
        for field in fields:
            assert field in text, f"{document.name} 缺少 release 字段: {field}"
    deploy = DEPLOY_DOCUMENT.read_text(encoding="utf-8")
    assert ".release-revision" in deploy
    assert ".release-source-manifest.sha256" in deploy
    assert "成对" in deploy


def test_active_documents_have_no_obsolete_execution_instructions() -> None:
    text = "\n".join(path.read_text(encoding="utf-8") for path in DOCUMENTS)
    forbidden_literals = (
        "/home/" + "rolf",
        "ssh " + "rolf@",
        "ProxyJump=" + "rolf",
        "REMOTE_PASS",
        "expect -c",
        "--user " + "1005:1005",
        "rolf/flock-voice-engine",
    )
    for token in forbidden_literals:
        assert token not in text, f"文档仍含旧执行事实: {token}"
    forbidden_patterns = (
        r"pool(?:-size)?\s*[=:]?\s*7\b",
        r"(?:block|块长|块)\s*[=:]?\s*2048\b",
        r"bash\s+deploy/(?:run|sync)\.sh",
    )
    for pattern in forbidden_patterns:
        assert re.search(pattern, text, re.IGNORECASE) is None, f"文档仍匹配旧事实: {pattern}"


def test_generated_engine_document_mirror_is_removed() -> None:
    assert not GENERATED_ENGINE_MIRROR.exists(), "不能保留第二份手工维护的 engine 文档树"
    spark_readme = SPARK_README.read_text(encoding="utf-8")
    assert "../flock-voice-engine/" in spark_readme
    assert "canonical" in spark_readme
```

- [ ] **Step 2: 运行文档测试确认 beta 文档仍是红灯**

```powershell
python -m pytest flock-voice-engine/tests/test_documentation_contract.py -q
```

Expected: FAIL，输出明确列出旧 home/login/pool/block、缺少候选契约标记或仍存在生成文档副本。

- [ ] **Step 3: 按测试清单统一事实**

tracked 文档必须同时满足：

- 当前线上：8090、44.1 kHz、block 4096、pool 5、row voices `[bass,pad,lead,pluck,pad]`。
- 代码：`/srv/deploy/flock-voice-engine`；未来操作账号仅 `yfhuang`。
- 8081 模型契约：`bird_agent`，不可改端口或模型名。
- `mvp/` 是 canonical UI；部署 `web/` 是 release 输出，不能手改成第二份源码。
- Phase 0 不改线上内容；当前容器仍有 legacy UID/log mount 债务，下一次受控 release 必须把 UID/GID、日志目录和 revision 一起切换。
- 不再提供 `run.sh`/`sync.sh`；不能用手工 expect/password 热覆盖。
- 当前浏览器仍拥有 world/agent/latent/audio orchestration；Node 后端权威 runtime 尚未切生产。
- Git-controlled 的 `web/src`、server、deploy、`web/_client` 可由 `origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a` 重建；vendor 只有冻结聚合 SHA `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`，三个来源的 revision unknown，不能由 Git 重建；runtime config 内容不捕获，仅有私有 HMAC-SHA256 前后证明。重构在 `refactor/backend-owned-runtime`。
- `flock-voice-engine/` 是 engine 代码与文档唯一 canonical tree；`spark-docs/flock-voice-engine/` 生成副本删除，不再双写。

- [ ] **Step 4: 重写 engine BRIEF/README 的现状摘要和目录说明**

从 `BRIEF.md` 与 `README.md` 移除过期账号、个人目录、block 2048、pool 7、pad 四行和旧部署根说明。保留历史性能数字时必须标注“历史配置”，不能放在“当前配置”表中。两份文档都增加“可重建边界”：Git-controlled 四个 scope 可重建；vendor 只固定聚合 SHA/来源且 revision unknown；runtime config 只做私有 HMAC，不捕获内容；Phase 0 不宣称模型权重或宿主机 site-packages 可复现。

- [ ] **Step 5: 把 engine HANDOFF 开头改成一屏可执行事实**

首屏命令只出现：

```bash
ssh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa yfhuang@192.168.9.140
cd /srv/deploy/flock-voice-engine
docker compose version >/dev/null 2>&1 || docker version
bash deploy/docker-run.sh status
curl --noproxy '*' http://127.0.0.1:8090/healthz
```

Phase 0 期间这只是只读 status/health；文档明确禁止从本分支运行 start/restart。删除所有要求其它账号登录、个人 home 路径、密码、expect 的 active instructions。

- [ ] **Step 6: 更新 deploy/client integration 文档**

`deploy.md` 说明：

- 当前 hot copy 只做事实来源，不再作为开发源；
- 新部署必须同时有 `.release-revision` 与 `.release-source-manifest.sha256`，两者成对校验，并在 status 返回同一 revision/manifest SHA；
- 当前 Phase 0 无 apply 工具；Phase 5 才引入 staging release + 原子切换；
- `web/_client` 来自 `flock-voice-engine/client`，`web/src` 来自 `mvp/src`；根 stale `client` 不参与发布；
- `/app/vendor` 是实际代码输入但当前只有聚合 SHA、来源声明和 revision unknown，替换前必须固定可获取 revision 或受控 artifact；`web/runtime-config.js` 内容不进 Git，只用私有 HMAC-SHA256 证明 Phase 0 前后未变；
- 当前 8090 进程不在本阶段重启。

`client-integration.md` 补充 `releaseRevision/sourceManifestSha256/protocolFamily/protocolVersion/runtimeOwner/audioOwner` 六个字段的诊断用途，不改变 legacy client 行为；同样标记为候选源码契约，当前未重启的 8090 可能尚无这些字段。`releaseRevision` 与 `sourceManifestSha256` 只能同时已知或同时为 `unknown`。

- [ ] **Step 7: 验证生成 engine 文档镜像已删除并保留单向指针**

```powershell
if (Test-Path spark-docs/flock-voice-engine) { throw 'generated engine documentation mirror returned' }
```

Task 5 已因 credential/canonical 双重原因删除生成镜像；本步骤更新 `spark-docs/README.md`，明确 `flock-voice-engine/` 才是 canonical 代码/文档目录，并只保留相对链接 `../flock-voice-engine/`。不得在 `spark-docs` 重新复制 BRIEF、README 或 docs 子树。Git 历史仍可追溯旧镜像，因此无需另建归档。

- [ ] **Step 8: 更新外部权威 HANDOFF 与代理说明**

`D:/workspace/spark_hackrothon/HANDOFF.md` 当前仍把 8090 写成旧 `eco_sim`。使用 `apply_patch` 改为：

- 8090 当前是 Docker `flock-voice-engine` + 同源 MVP；
- 旧 `eco_sim_server.py`/`eco_sim.html` 是历史实验，不是当前 production owner；
- 服务源码 `/srv/deploy/flock-voice-engine`；操作身份 `yfhuang`；
- 当前 effective contract 为 block 4096/pool 5；
- Git-controlled scopes 可由 beta 重建，但 vendor revision unknown、不能由 Git 重建；记录 vendor 聚合 SHA 和 runtime config 私有 HMAC 边界；
- 后续重构分支与设计/plan 的路径；
- 所有凭证值移除，只保留 secret 注入位置。

该文件不属于 Git worktree，不能伪装成 branch commit；最终交付单独报告其本地修改。

同时使用 `apply_patch` 更新 `D:/workspace/spark_hackrothon/AGENTS.md`：把“`eco_sim` 裸进程占用 8090”的旧生产说明改为当前 Docker `flock-voice-engine` + 同源 MVP，保留 `eco_sim` 仅为历史实验说明；服务器操作身份只写 `yfhuang`，且不保留密码值。该文件同样不进入分支提交。

- [ ] **Step 9: 运行机器文档契约与两份外部权威文件双向检查**

```powershell
python -m pytest flock-voice-engine/tests/test_documentation_contract.py -q
if ($LASTEXITCODE -ne 0) { throw 'documentation contract tests failed' }
$externalHandoff = 'D:\workspace\spark_hackrothon\HANDOFF.md'
$externalAgents = 'D:\workspace\spark_hackrothon\AGENTS.md'
$externalDocuments = @($externalHandoff, $externalAgents)
foreach ($document in $externalDocuments) {
  rg -q 'yfhuang' $document; if ($LASTEXITCODE -ne 0) { throw "$document missing yfhuang" }
  rg -q '/srv/deploy/flock-voice-engine' $document; if ($LASTEXITCODE -ne 0) { throw "$document missing deploy root" }
  rg -q 'block.*4096|4096.*block' $document; if ($LASTEXITCODE -ne 0) { throw "$document missing block 4096" }
  rg -q 'pool.*5|5.*pool' $document; if ($LASTEXITCODE -ne 0) { throw "$document missing pool 5" }
  rg -q '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049' $document; if ($LASTEXITCODE -ne 0) { throw "$document missing vendor fingerprint" }
  rg -q 'vendor.*不能由 Git 重建|不能由 Git 重建.*vendor' $document; if ($LASTEXITCODE -ne 0) { throw "$document overstates vendor reconstructability" }
  rg -q 'runtime-config.*HMAC-SHA256|HMAC-SHA256.*runtime-config' $document; if ($LASTEXITCODE -ne 0) { throw "$document missing private runtime config integrity boundary" }
}
$staleOwnerHits = @(rg -l 'eco_sim.*8090|8090.*eco_sim' $externalDocuments)
if ($LASTEXITCODE -gt 1) { throw 'external ownership scan failed' }
if ($staleOwnerHits.Count -ne 0) { $staleOwnerHits; throw 'external document still assigns 8090 to eco_sim' }
$staleIdentityHits = @(rg -l '/home/rolf|ssh\s+rolf@|ProxyJump\s*=\s*rolf|--user\s+1005:1005' $externalDocuments)
if ($LASTEXITCODE -gt 1) { throw 'external identity scan failed' }
if ($staleIdentityHits.Count -ne 0) { $staleIdentityHits; throw 'external document still contains legacy operator instructions' }
$externalSecretHits = @(rg -l -i 'sudo.{0,20}密码|password\s*[:=]|passwd\s*[:=]|REMOTE_PASS|sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}' $externalDocuments)
if ($LASTEXITCODE -gt 1) { throw 'external credential scan failed' }
if ($externalSecretHits.Count -ne 0) { $externalSecretHits; throw 'external authority document still contains credential material' }
```

Expected: 4 tests passed；两份外部文件的生产配置、vendor 指纹/不可重建边界、runtime config 私有 HMAC 边界正向断言通过；三条负向扫描均无文件名输出。`rg` 无匹配的 exit 1 是成功语义，只有大于 1 才是工具错误。历史性能表若必须保留旧 block/pool 数字，移动到不属于 active documents 的归档文档，不能削弱本测试。

- [ ] **Step 10: 提交 tracked 文档与契约测试**

```powershell
git add flock-voice-engine/BRIEF.md `
  flock-voice-engine/README.md `
  flock-voice-engine/docs/HANDOFF.md `
  flock-voice-engine/docs/deploy.md `
  flock-voice-engine/docs/client-integration.md `
  flock-voice-engine/tests/test_documentation_contract.py `
  spark-docs/README.md
git commit -m "docs: reconcile production handoff facts"
```

---

### Task 8：Phase 0 全量验收、审查与下一计划门槛

**Files:**

- Verify only: whole worktree
- Verify only: `D:/workspace/spark_hackrothon/HANDOFF.md`
- Verify only: `D:/workspace/spark_hackrothon/AGENTS.md`
- No remote writes

- [ ] **Step 1: 运行完整 Phase 0 门禁**

```powershell
npm run verify:phase0
```

Expected: exit 0。记录 root/MVP/voice 的实际 pass count 和总耗时到最终交付，不修改原始测试数据文件。

- [ ] **Step 2: 重跑生产 manifest，证明结果可复现**

```powershell
$before = (Get-FileHash docs/production-manifests/2026-07-22-production.json -Algorithm SHA256).Hash
$revision = '3cf686eb1dd2ed356594904e2f366805ae7dd11a'
$auditRoot = 'D:\workspace\spark_hackrothon\.audit'
$runId = [Guid]::NewGuid().ToString('N')
$gitZip = Join-Path $auditRoot "git-beta-3cf686eb-$runId.zip"
$gitSnapshot = Join-Path $auditRoot "git-beta-3cf686eb-$runId"
$remotePassPattern = 'REMOTE_' + 'PASS='
$cnPasswordPattern = ('密' + '码') + '.{0,12}[:=：]'
$gitCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|' + $remotePassPattern + '|password[[:space:]]*[:=]|passwd[[:space:]]*[:=]|' + $cnPasswordPattern
$credentialBlobs = @(git grep -Iil -E $gitCredentialPattern $revision -- .)
if ($LASTEXITCODE -gt 1) { throw 'cannot scan pinned beta credential paths' }
$credentialPaths = @($credentialBlobs | ForEach-Object { $_.Substring($revision.Length + 1) } | Sort-Object)
$expectedCredentialPaths = @(
  'docs/melody-lattice-handoff.md',
  'flock-voice-engine/deploy/sync.sh',
  'flock-voice-engine/docs/HANDOFF.md',
  'flock-voice-engine/docs/deploy.md',
  'flock-voice-engine/docs/model-notes.md',
  'spark-docs/docs/melody-lattice-handoff.md',
  'spark-docs/flock-voice-engine/docs/HANDOFF.md',
  'spark-docs/flock-voice-engine/docs/deploy.md',
  'spark-docs/flock-voice-engine/docs/model-notes.md'
) | Sort-Object
$credentialPathDifference = @(Compare-Object $credentialPaths $expectedCredentialPaths)
if ($credentialPathDifference.Count -ne 0) { $credentialPathDifference | Format-Table; throw 'pinned beta credential path set changed' }
$forbiddenArchivePaths = @('mvp/runtime-config.js') + $expectedCredentialPaths
$archiveExcludes = @($forbiddenArchivePaths | ForEach-Object { ":(exclude)$_" })
git archive --format=zip --output=$gitZip $revision -- . $archiveExcludes
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $gitZip)) { throw 'cannot archive pinned beta tree' }
$archiveEntries = @(tar -tf $gitZip)
if ($LASTEXITCODE -ne 0) { throw 'cannot list pinned beta archive' }
$credentialArchiveEntries = @($archiveEntries | Where-Object { $_ -in $forbiddenArchivePaths })
if ($credentialArchiveEntries.Count -ne 0) { throw 'sanitized beta archive still contains credential-bearing paths' }
$treeFiles = @(git ls-tree -r --name-only $revision)
if ($LASTEXITCODE -ne 0) { throw 'cannot enumerate pinned beta tree' }
$expectedArchiveFiles = @($treeFiles | Where-Object { $_ -notin $forbiddenArchivePaths } | Sort-Object)
$actualArchiveFiles = @($archiveEntries | Where-Object { -not $_.EndsWith('/') } | Sort-Object)
$archiveCoverageDifference = @(Compare-Object $expectedArchiveFiles $actualArchiveFiles)
if ($archiveCoverageDifference.Count -ne 0) { $archiveCoverageDifference | Format-Table; throw 'sanitized archive does not cover the full safe beta tree' }
Expand-Archive -LiteralPath $gitZip -DestinationPath $gitSnapshot
$expandedCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|' + $remotePassPattern + '|password\s*[:=]|passwd\s*[:=]|' + $cnPasswordPattern
$expandedCredentialHits = @(rg -l -i $expandedCredentialPattern $gitSnapshot)
if ($LASTEXITCODE -gt 1) { throw 'cannot scan expanded beta archive' }
if ($expandedCredentialHits.Count -ne 0) { $expandedCredentialHits; throw 'expanded beta archive contains credential-shaped text' }
function Get-NormalizedTextSha256([string]$path) {
  $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8).Replace("`r`n", "`n").Replace("`r", "`n")
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
}
if ((Get-NormalizedTextSha256 'D:\workspace\spark_hackrothon\.audit\production-20260722-plan\docs\ecological-latent-control.md') -ne
    (Get-NormalizedTextSha256 (Join-Path $gitSnapshot 'docs\ecological-latent-control.md'))) {
  throw 'deduplicated ecological document is no longer byte-equivalent after normalization'
}
python flock-voice-engine/tools/production_manifest.py `
  --snapshot-root D:\workspace\spark_hackrothon\.audit\production-20260722-plan `
  --repository-root $gitSnapshot `
  --metadata docs/production-manifests/2026-07-22-metadata.json `
  --decisions docs/production-manifests/2026-07-22-decisions.json `
  --output docs/production-manifests/2026-07-22-production.json `
  --fail-unreviewed
if ($LASTEXITCODE -ne 0) { throw 'reproducibility manifest generation failed' }
$after = (Get-FileHash docs/production-manifests/2026-07-22-production.json -Algorithm SHA256).Hash
if ($before -ne $after) { throw 'manifest output is not deterministic' }
$regenerated = Get-Content -Raw -Encoding UTF8 docs/production-manifests/2026-07-22-production.json | ConvertFrom-Json
if ($regenerated.summary.unreviewed -ne 0 -or $regenerated.summary.unmapped -ne 0 -or $regenerated.summary.unusedDecisions -ne 0) {
  throw 'regenerated manifest is not fully reviewed'
}
$vendorStart = Get-Content -Raw -Encoding UTF8 (Join-Path (Join-Path $auditRoot 'phase0-start') 'vendor.json') | ConvertFrom-Json
$vendorMetadata = $regenerated.metadata.externalRuntimeInputs.vendor
if ($vendorMetadata.regularFileCount -ne $vendorStart.regularFileCount -or
    $vendorMetadata.symlinkCount -ne $vendorStart.symlinkCount -or
    $vendorMetadata.treeSha256 -ne $vendorStart.treeSha256 -or
    $vendorMetadata.reconstructability -ne 'content-fingerprinted-only') {
  throw 'reproducible manifest lost the vendor fingerprint/reconstructability boundary'
}
$runtimeConfigMetadata = $regenerated.metadata.externalRuntimeInputs.runtimeConfig
if ($runtimeConfigMetadata.contentCaptured -ne $false -or
    $runtimeConfigMetadata.integrityValueCommitted -ne $false -or
    $runtimeConfigMetadata.integrityScheme -ne 'private HMAC-SHA256 start/end comparison') {
  throw 'reproducible manifest lost the private runtime config boundary'
}
```

Expected: 两个 manifest hash 完全相同，`unreviewed == 0`；再生输出仍精确携带 vendor 指纹/不可重建声明和 runtime config 私有完整性边界，但不含 HMAC 值或配置内容。

- [ ] **Step 3: 在全部 tracked 文档改写后重跑 secret 与旧身份门禁**

只输出命中文件名，不打印任何匹配值：

```powershell
$remotePassPattern = 'REMOTE_' + 'PASS='
$cnPasswordPattern = ('密' + '码') + '.{0,12}[:=：]'
$trackedCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|' + $remotePassPattern + '|password[[:space:]]*[:=]|passwd[[:space:]]*[:=]|' + $cnPasswordPattern
$trackedHits = @(git grep -Iil -E $trackedCredentialPattern -- .)
if ($LASTEXITCODE -gt 1) { throw 'final tracked secret scan failed' }
if ($trackedHits.Count -ne 0) { $trackedHits; throw 'tracked secret introduced after documentation rewrite' }
$legacyIdentityHits = @(git grep -Il -E '/home/rolf|ssh[[:space:]]+rolf@|ProxyJump[[:space:]]*=[[:space:]]*rolf|--user[[:space:]]+1005:1005' -- flock-voice-engine)
if ($LASTEXITCODE -gt 1) { throw 'final legacy identity scan failed' }
if ($legacyIdentityHits.Count -ne 0) { $legacyIdentityHits; throw 'legacy operator path remains in active engine tree' }
$externalFiles = @(
  'D:\workspace\spark_hackrothon\AGENTS.md',
  'D:\workspace\spark_hackrothon\HANDOFF.md',
  'D:\workspace\spark_hackrothon\dl-nvfp4.service',
  'D:\workspace\spark_hackrothon\eco_sim_server.py',
  'D:\workspace\spark_hackrothon\validate_agent_prompts.py'
)
$externalCredentialPattern = 'sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|REMOTE_PASS|password\s*[:=]|passwd\s*[:=]|' + $cnPasswordPattern
$externalSecretHits = @(rg -l -i $externalCredentialPattern $externalFiles)
if ($LASTEXITCODE -gt 1) { throw 'final external secret scan failed' }
if ($externalSecretHits.Count -ne 0) { $externalSecretHits; throw 'external operational file still contains credential material' }
$externalIdentityHits = @(rg -l '/home/rolf|ssh\s+rolf@|ProxyJump\s*=\s*rolf|--user\s+1005:1005' $externalFiles[0..1])
if ($LASTEXITCODE -gt 1) { throw 'final external identity scan failed' }
if ($externalIdentityHits.Count -ne 0) { $externalIdentityHits; throw 'external authority file still contains legacy operator instructions' }
```

Expected: 四组搜索都没有文件名输出。扫描覆盖整个 tracked tree；计划中的 detector 字面量通过字符串拼接避免自命中，不对 `docs/superpowers/**` 或其它目录做豁免。Task 7 刚改写的 BRIEF/README/HANDOFF/deploy/client integration 全部必须接受最终扫描，不能依赖 Task 5 的较早结果。

- [ ] **Step 4: 验证分支拓扑、提交粒度和工作树**

```powershell
git merge-base --is-ancestor origin/beta HEAD
if ($LASTEXITCODE -ne 0) { throw 'origin/beta is not an ancestor' }
git log --oneline --decorate origin/beta..HEAD
git diff --check origin/beta..HEAD
if ($LASTEXITCODE -ne 0) { throw 'git diff whitespace check failed' }
git status --short --branch
$porcelain = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $porcelain.Count -ne 0) { $porcelain; throw 'final worktree is not clean' }
```

Expected: beta 是祖先；日志显示设计、计划和每个 Phase 0 独立提交；`git diff --check` 无输出；工作树除明确列出的外部非 Git 文件外干净。

- [ ] **Step 5: 证明 Phase 0 没有碰生产**

只读执行：

```powershell
$auditRoot = 'D:\workspace\spark_hackrothon\.audit'
$startDir = Join-Path $auditRoot 'phase0-start'
$markerPath = Join-Path $startDir 'container.txt'
$coreSourceHashPath = Join-Path $startDir 'core-source.sha256'
$vendorStartPath = Join-Path $startDir 'vendor.json'
$runtimeConfigStartPath = Join-Path $startDir 'runtime-config.json'
$runtimeConfigKeyPath = Join-Path $startDir 'runtime-config-key.dpapi'
foreach ($evidencePath in @($markerPath, $coreSourceHashPath, $vendorStartPath, $runtimeConfigStartPath, $runtimeConfigKeyPath)) {
  if (-not (Test-Path -LiteralPath $evidencePath)) { throw "missing Phase 0 start evidence: $evidencePath" }
}
$beforeMarker = (Get-Content -Raw -Encoding UTF8 $markerPath).Trim()
$beforeCoreSourceHashes = (Get-Content -Raw -Encoding UTF8 $coreSourceHashPath).Trim()
$vendorStart = Get-Content -Raw -Encoding UTF8 $vendorStartPath | ConvertFrom-Json
$runtimeConfigStart = Get-Content -Raw -Encoding UTF8 $runtimeConfigStartPath | ConvertFrom-Json
$metadata = Get-Content -Raw -Encoding UTF8 docs/production-manifests/2026-07-22-metadata.json | ConvertFrom-Json
if ($vendorStart.schemaVersion -ne 1 -or $vendorStart.regularFileCount -ne 460 -or
    $vendorStart.symlinkCount -ne 0 -or $vendorStart.treeSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeConfigStart.schemaVersion -ne 1 -or $runtimeConfigStart.byteCount -ne 171 -or
    $runtimeConfigStart.integrityScheme -ne 'HMAC-SHA256' -or
    $runtimeConfigStart.hmac -notmatch '^[0-9a-f]{64}$') {
  throw 'Phase 0 private start evidence is malformed'
}
$gitSsh = 'C:\Program Files\Git\usr\bin\ssh.exe'
if (-not (Test-Path $gitSsh)) { throw 'Git for Windows ssh not found' }
$mountJson = & $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  "docker inspect flock-voice-engine --format '{{json .Mounts}}'"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($mountJson -join "`n"))) { throw 'cannot read final production mounts' }
try { $mounts = @(($mountJson -join "`n") | ConvertFrom-Json) }
catch { throw 'final production mount payload is not valid JSON' }
foreach ($expectedMount in @(
  @('/srv/deploy/flock-voice-engine/server', '/app/server'),
  @('/srv/deploy/flock-voice-engine/vendor', '/app/vendor'),
  @('/srv/deploy/flock-voice-engine/assets', '/app/assets'),
  @('/srv/deploy/flock-voice-engine/web', '/app/web')
)) {
  $matchingMounts = @($mounts | Where-Object {
    $_.Source -eq $expectedMount[0] -and $_.Destination -eq $expectedMount[1] -and $_.RW -eq $false
  })
  if ($matchingMounts.Count -ne 1) { throw "final read-only mount changed: $($expectedMount -join ' -> ')" }
}
$afterMarker = & $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  "docker inspect flock-voice-engine --format '{{.Id}} {{.State.StartedAt}}'"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($afterMarker -join "`n"))) { throw 'cannot read final production marker' }
$coreSourceHashCommand = @'
bash -o pipefail -c \"cd /srv/deploy/flock-voice-engine && find . -type f ! -path './deploy/sync.sh' ! -path './docs/deploy.md' ! -path './docs/HANDOFF.md' ! -path './docs/model-notes.md' ! -path './web/runtime-config.js' ! -path './logs/*' ! -path '*/__pycache__/*' ! -path '*/.venv/*' ! -path '*/vendor/*' ! -path '*/staging/*' ! -path '*/checkpoint/*' ! -path '*.bak_[0-9]*/*' ! -path '*.bak.[0-9]*/*' ! -name '.env' ! -name '.env.*' ! -name '*.pem' ! -name '*.key' ! -name '*.ckpt' ! -name '*.safetensors' ! -name '*.pyc' ! -name '*.npy' ! -name '._*' ! -name '*.bak' ! -name '*.bak.[0-9]*' ! -name '*.bak_[0-9]*' -print0 | sort -z | xargs -0 sha256sum\"
'@
$afterCoreSourceHashes = & $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  $coreSourceHashCommand
if ($LASTEXITCODE -ne 0 -or $beforeCoreSourceHashes -ne (($afterCoreSourceHashes -join "`n").Trim())) {
  throw 'production Git-controlled core source/assets changed during Phase 0'
}
$vendorCommand = @'
bash -o pipefail -c \"cd /srv/deploy/flock-voice-engine && find vendor -type f -printf x | wc -c && find vendor -type l -printf x | wc -c && LC_ALL=C find vendor -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f1\"
'@
$afterVendorFacts = @(& $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  $vendorCommand)
if ($LASTEXITCODE -ne 0 -or $afterVendorFacts.Count -ne 3) { throw 'cannot read final production vendor fingerprint' }
$afterVendorFileCount = [int]$afterVendorFacts[0]
$afterVendorSymlinkCount = [int]$afterVendorFacts[1]
$afterVendorTreeSha256 = $afterVendorFacts[2].Trim()
if ($afterVendorFileCount -ne $vendorStart.regularFileCount -or
    $afterVendorSymlinkCount -ne $vendorStart.symlinkCount -or
    $afterVendorTreeSha256 -ne $vendorStart.treeSha256 -or
    $metadata.externalRuntimeInputs.vendor.regularFileCount -ne $vendorStart.regularFileCount -or
    $metadata.externalRuntimeInputs.vendor.symlinkCount -ne $vendorStart.symlinkCount -or
    $metadata.externalRuntimeInputs.vendor.treeSha256 -ne $vendorStart.treeSha256) {
  throw 'production vendor fingerprint changed or differs from committed metadata'
}
$runtimeConfigByteLines = @(& $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  "stat -c '%s' /srv/deploy/flock-voice-engine/web/runtime-config.js")
if ($LASTEXITCODE -ne 0 -or $runtimeConfigByteLines.Count -ne 1 -or
    [int]$runtimeConfigByteLines[0] -ne $runtimeConfigStart.byteCount) {
  throw 'production runtime config is missing or changed byte count'
}
Add-Type -AssemblyName System.Security
function ConvertTo-NativeArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $backslashes += 1; continue }
    if ($character -eq '"') {
      [void]$builder.Append((('\' * (2 * $backslashes + 1)) -join ''))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append((('\' * $backslashes) -join ''))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append((('\' * (2 * $backslashes)) -join ''))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}
function Invoke-SshWithBinaryInput([byte[]]$InputBytes, [string]$RemoteCommand) {
  if ($InputBytes.Length -ne 32) { throw 'binary SSH input must be exactly 32 bytes' }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $gitSsh
  $nativeArguments = @(
    '-T', '-i', 'D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa',
    '-o', 'BatchMode=yes', 'yfhuang@192.168.9.140', $RemoteCommand
  )
  $startInfo.Arguments = (($nativeArguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw 'cannot start binary-input SSH process' }
    $stdin = $process.StandardInput.BaseStream
    $stdin.Write($InputBytes, 0, $InputBytes.Length)
    $stdin.Flush()
    $stdin.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $null = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StandardOutput = $stdout }
  } finally {
    $process.Dispose()
  }
}
$protectedKey = [IO.File]::ReadAllBytes($runtimeConfigKeyPath)
if ($protectedKey.Length -eq 0) { throw 'private runtime config DPAPI key blob is empty' }
$rawKey = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protectedKey,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  if ($null -eq $rawKey -or $rawKey.Length -ne 32) { throw 'private runtime config HMAC key has unexpected length' }
  if ($metadata.externalRuntimeInputs.runtimeConfig.contentCaptured -ne $false -or
      $metadata.externalRuntimeInputs.runtimeConfig.integrityValueCommitted -ne $false -or
      $metadata.externalRuntimeInputs.runtimeConfig.integrityScheme -ne 'private HMAC-SHA256 start/end comparison') {
    throw 'committed runtime config metadata overstates or leaks private integrity evidence'
  }
  $runtimeHmacCommand = @'
python3 -c 'import hashlib,hmac,sys; payload=sys.stdin.buffer.read(); key=payload[3:] if len(payload)==35 and payload[:3]==bytes((239,187,191)) else payload; assert len(key)==32; data=open("/srv/deploy/flock-voice-engine/web/runtime-config.js","rb").read(); print(hmac.new(key,data,hashlib.sha256).hexdigest())'
'@
  $runtimeHmacResult = Invoke-SshWithBinaryInput $rawKey $runtimeHmacCommand
  $afterRuntimeHmacLines = @($runtimeHmacResult.StandardOutput -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($runtimeHmacResult.ExitCode -ne 0 -or $afterRuntimeHmacLines.Count -ne 1) {
    throw 'cannot read final private runtime config integrity marker'
  }
  $afterRuntimeHmac = $afterRuntimeHmacLines[0].Trim()
  if ($afterRuntimeHmac -notmatch '^[0-9a-f]{64}$' -or $afterRuntimeHmac -cne $runtimeConfigStart.hmac) {
    throw 'production runtime config changed during Phase 0'
  }
} finally {
  if ($null -ne $rawKey) { [Array]::Clear($rawKey, 0, $rawKey.Length) }
}
if ($beforeMarker -ne (($afterMarker -join "`n").Trim())) {
  Write-Warning '容器期间被外部重启，但部署文件 hash 未变化；记录为环境事件，不归因于源码写入'
}
$decoderStatus = & $gitSsh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa `
  -o BatchMode=yes yfhuang@192.168.9.140 `
  "curl -fsS --noproxy '*' http://127.0.0.1:8090/api/decoder-status"
if ($LASTEXITCODE -ne 0 -or @($decoderStatus).Count -eq 0 -or [string]::IsNullOrWhiteSpace(($decoderStatus -join "`n"))) {
  throw 'production decoder-status is unavailable or empty'
}
try {
  $null = ($decoderStatus -join "`n") | ConvertFrom-Json
} catch {
  throw 'production decoder-status did not return valid JSON'
}
```

Expected: 四个 active source mount 仍指向相同宿主路径且只读；Git-controlled core source hash、vendor 460/0/聚合 SHA、runtime config 私有 HMAC/字节数都与 Phase 0 开始前一致，vendor 同时与 committed metadata 一致。容器 marker 通常相同，若被外部重启但以上运行输入未变则只记录警告；线上 decoder status 必须 exit 0、非空且是合法 JSON，但仍可属于旧 release、尚无新增字段。此证明不覆盖模型权重或宿主机 site-packages，因此只证明 Phase 0 没有改动被本计划纳入的运行输入，不宣称完整二进制环境可复现；不得为让字段出现而重启。

- [ ] **Step 6: 请求独立 code review**

使用 `superpowers:requesting-code-review`，审查重点：

- beta 重放是否保留设计/计划且没有反灌 stale client；
- manifest 是否遗漏/读取 secret，decision 是否过宽；
- vendor 聚合指纹、来源/revision 缺口与 runtime config 私有 HMAC 是否真正前后闭环；
- release/owner 字段是否在 health/status/ready 一致；
- deploy script 是否真的只允许 `yfhuang`、动态 UID/GID、无密码入口；
- verify 是否实际包含 root、MVP、voice pytest 和 selftest；
- Phase 0 是否有任何远端写操作。

修复所有 Blocker/Critical/Important，再重跑 Steps 1–5。

- [ ] **Step 7: 完成 Phase 0 后才编写后续三个计划**

依次创建，不在本计划内实施：

1. `Phase 1–2：Node 共享世界、mailbox、加法协议与确定性 shadow`；
2. `Phase 3–4：species/master agent、fallback、GPU 调度与潜空间下沉`；
3. `Phase 5–6：单例 Python audio worker、legacy split tap、PCM fan-out 与 8090 原子切换`。

每个计划必须引用本次 `releaseRevision`、production manifest hash、vendor tree SHA `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049` 和 `npm run verify:phase0` 作为进入条件。Phase 5 若要替换 vendor，必须先固定可获取的上游 revision 或受控 artifact，不能只沿用 unknown provenance；其受控 release-artifact manifest 还必须覆盖 worker image/code、vendor、模型/voice weights、voice maps 与校准资产，并把 runtime/worker identity mismatch 拒绝和 Audio WS v1 golden vector 设为 8090 切换硬门禁。

## Phase 0 Definition of Done

- `origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a` 是 refactor 分支祖先。
- Git-controlled 的 active `web/src`、server、deploy、`web/_client` 可由 Git 重建；没有把 stale 根 client、死 `server/brave.py` 或临时诊断页误收编。
- vendor 当前只有 460/0/聚合 SHA 与来源声明，三个上游 revision 仍 unknown，明确不能宣称由 Git 重建；runtime config 内容不捕获、不提交，只保留私有 HMAC-SHA256 前后证明。
- manifest 可重复生成、SHA 稳定、`unreviewed == 0`，且不 hash runtime config/secret 内容；external runtime input 不会被 `unmapped == 0` 掩盖。
- `/healthz`、`/api/decoder-status`、ready 在本地候选中返回同一 release/protocol/owner identity。
- active deploy 源码仅支持 `yfhuang`，UID/GID 动态取值，日志迁到 release 目录；旧 run/sync/expect/password 入口消失。
- tracked tree 与列出的外部运维文件不含已知明文 token/key。
- `npm run verify:phase0` 全绿，`npm run check` 不再引用不存在的文件。
- engine 文档和外部权威 `HANDOFF.md` 对 8090、路径、pool/block、身份、Git-controlled canonical source 与 vendor/runtime config 不可重建边界描述一致。
- 线上四个 active mount 契约、core source hash、vendor 聚合 SHA/文件数、runtime config 私有 HMAC 前后一致；Phase 0 没有同步或覆盖生产。容器 ID/StartedAt 只作辅助环境记录，不把外部正常重启误判成源码写入。
- 该证明不覆盖模型权重与宿主机 site-packages，Phase 0 不宣称完整二进制环境可复现。
