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
