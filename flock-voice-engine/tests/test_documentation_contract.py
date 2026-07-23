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
PROTOCOL_DOCUMENT = ENGINE / "docs/protocol.md"
CLIENT_DOCUMENT = ENGINE / "docs/client-integration.md"
LATENT_DOCUMENT = ENGINE / "docs/latent-map.md"
CONFIG_SOURCE = ENGINE / "server/config.py"
APP_SOURCE = ENGINE / "server/app.py"
DOCUMENTS = CURRENT_FACT_DOCUMENTS + RELEASE_CONTRACT_DOCUMENTS + (
    DEPLOY_DOCUMENT,
    LATENT_DOCUMENT,
    ENGINE / "docs/model-notes.md",
)
REPOSITORY = ENGINE.parent
SPARK_README = REPOSITORY / "spark-docs/README.md"
GENERATED_ENGINE_MIRROR = REPOSITORY / "spark-docs/flock-voice-engine"


def _read_int_constant(source: str, name: str) -> int:
    match = re.search(rf"(?m)^{re.escape(name)}\s*=\s*([0-9_]+)\b", source)
    assert match is not None, f"源码缺少常量: {name}"
    return int(match.group(1).replace("_", ""))


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

    for document in (PROTOCOL_DOCUMENT, CLIENT_DOCUMENT):
        text = document.read_text(encoding="utf-8")
        for token in ("brave-voices", "4096", "pool 5"):
            assert token in text, f"{document.name} 缺少当前生产音频事实: {token}"
        for pattern in (
            r"2048\s+(?:样本|samples?)",
            r"pool\s*=\s*1\b",
            r"池长度\s*1\b",
        ):
            assert re.search(pattern, text, re.IGNORECASE) is None, (
                f"{document.name} 仍把旧配置写成 active: {pattern}"
            )

    protocol = PROTOCOL_DOCUMENT.read_text(encoding="utf-8")
    wire_issues: list[str] = []
    if re.search(
        r"4096\s*样本\s*[×x*]\s*2\s*声道\s*[×x*]\s*4\s*字节\s*=\s*(?:\*\*)?32768\s*字节",
        protocol,
    ) is None:
        wire_issues.append("mixed frame 未说明 4096×2×4=32768")
    for pattern in (r"1024\s+(?:样本|samples?)", r"8192\s+(?:字节|bytes?)"):
        if re.search(pattern, protocol, re.IGNORECASE):
            wire_issues.append(f"protocol 仍含旧 wire size: {pattern}")
    split_order = re.search(
        r"t0_row0.*t0_row1.*t0_row2.*t0_row3.*t0_row4.*t1_row0",
        protocol,
        re.DOTALL,
    )
    if split_order is None:
        wire_issues.append("五通道交错示例未在 t1_row0 前列出 t0_row4")
    assert not wire_issues, "; ".join(wire_issues)


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

    config_source = CONFIG_SOURCE.read_text(encoding="utf-8")
    app_source = APP_SOURCE.read_text(encoding="utf-8")
    block = _read_int_constant(config_source, "DEFAULT_BLOCK_SAMPLES")
    prime = _read_int_constant(config_source, "PRIME_FRAMES")
    target = _read_int_constant(app_source, "TARGET_FRAMES")
    high_water = _read_int_constant(config_source, "HIGH_WATER_FRAMES")
    assert (block, prime, target, high_water) == (4096, 4096, 13000, 19000)

    protocol = PROTOCOL_DOCUMENT.read_text(encoding="utf-8")
    pacing_issues: list[str] = []
    for token in (
        "PRIME_FRAMES=4096",
        "TARGET_FRAMES=13000",
        "HIGH_WATER_FRAMES=19000",
        "92.88 ms",
        "294.78 ms",
        "3.17 blocks",
    ):
        if token not in protocol:
            pacing_issues.append(f"protocol 缺少 pacing 事实: {token}")
    for pattern in (
        r"\b11000\b",
        r"46\.44\s*ms",
        r"5\.4\s*(?:blocks?|块)",
        r"230\s*[–-]\s*280",
    ):
        if re.search(pattern, protocol, re.IGNORECASE):
            pacing_issues.append(f"protocol 仍含旧 pacing 事实: {pattern}")
    assert not pacing_issues, "; ".join(pacing_issues)


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

    protocol = PROTOCOL_DOCUMENT.read_text(encoding="utf-8")
    app_commands = re.findall(
        r"(?m)^\s*python(?:3)?\s+server/app\.py\b[^\r\n]*",
        protocol,
    )
    assert app_commands, "protocol.md 必须保留不占 8090 的 app selftest"
    for command in app_commands:
        assert re.fullmatch(
            r"\s*python(?:3)?\s+server/app\.py\s+--selftest\s*(?:#.*)?",
            command,
        ), f"protocol.md 含可直接启动 8090 的命令: {command}"

    latent = LATENT_DOCUMENT.read_text(encoding="utf-8")
    assert "/srv/deploy/flock-voice-engine" not in latent
    assert re.search(r"\b(?:ssh|scp|rsync)\b", latent, re.IGNORECASE) is None
    for token in (
        "calibrate_map_loudness.py",
        "覆写",
        "candidate checkout",
        "assets/timbre/latent_map.json",
        "隔离",
        "staging",
        "Phase 0",
        "active tree",
    ):
        assert token in latent, f"latent-map.md 缺少安全边界: {token}"

    app_source = APP_SOURCE.read_text(encoding="utf-8")
    protocol = PROTOCOL_DOCUMENT.read_text(encoding="utf-8")
    client = CLIENT_DOCUMENT.read_text(encoding="utf-8")
    report_issues: list[str] = []
    for token in ("32 个 render quanta", "85 ms @ 48 kHz"):
        if token not in protocol:
            report_issues.append(f"protocol 缺少 worklet 回报事实: {token}")
    for document_name, document in (
        ("protocol", protocol),
        ("client", client),
        ("server/app.py", app_source),
    ):
        for pattern in (r"每\s*32\s*块", r"0\.74\s*s"):
            if re.search(pattern, document, re.IGNORECASE):
                report_issues.append(f"{document_name} 仍含旧回报周期: {pattern}")
    for pattern in (
        r"\b11000\b",
        r"46\.44\s*ms",
        r"5\.4\s*(?:blocks?|块)",
        r"100\s*[–-]\s*300",
    ):
        if re.search(pattern, app_source, re.IGNORECASE):
            report_issues.append(f"server/app.py 注释仍含旧 pacing 事实: {pattern}")
    assert not report_issues, "; ".join(report_issues)


def test_generated_engine_document_mirror_is_removed() -> None:
    assert not GENERATED_ENGINE_MIRROR.exists(), "不能保留第二份手工维护的 engine 文档树"
    spark_readme = SPARK_README.read_text(encoding="utf-8")
    assert "../flock-voice-engine/" in spark_readme
    assert "canonical" in spark_readme

    handoff = (ENGINE / "docs/HANDOFF.md").read_text(encoding="utf-8")
    first_bash_block = re.search(r"```bash\r?\n(.*?)\r?\n```", handoff, re.DOTALL)
    assert first_bash_block is not None, "engine HANDOFF 缺少首屏只读命令"
    assert first_bash_block.group(1).splitlines() == [
        "ssh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa yfhuang@192.168.9.140",
        "cd /srv/deploy/flock-voice-engine",
        "docker compose version >/dev/null 2>&1 || docker version",
        "bash deploy/docker-run.sh status",
        "curl --noproxy '*' http://127.0.0.1:8090/healthz",
    ]

    client = CLIENT_DOCUMENT.read_text(encoding="utf-8")
    latency_issues: list[str] = []
    for token in (
        "13000 frames",
        "≈ 295 ms",
        "buffer target",
        "runtime outputLatency",
        "待当前配置复测",
    ):
        if token not in client:
            latency_issues.append(f"client 缺少延迟诊断事实: {token}")
    for pattern in (
        r"130\s*[–-]\s*150\s*ms",
        r"\b122\s*ms\b",
        r"230\s*[–-]\s*280\s*ms",
        r"100\s*[–-]\s*300\s*ms",
    ):
        if re.search(pattern, client, re.IGNORECASE):
            latency_issues.append(f"client 仍含未复测固定延迟: {pattern}")
    assert not latency_issues, "; ".join(latency_issues)
