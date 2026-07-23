# Latent Cosmos Synth

一个正在重构中的树-鸟生态音序器：树的生态状态形成可栖息的结构，鸟群的归栖、飞行与日循环共同生成声音。当前开发主线位于 `mvp/`，目标是先把可解释的生态规则、日界和声与可选 LLM 个性层跑通，再逐步扩展为多树生态。

## 运行 MVP

无需安装前端依赖。在仓库根目录启动静态服务器：

```bash
python3 -m http.server 4193
```

然后打开 <http://localhost:4193/mvp/>。也可以使用等价脚本：

```bash
npm run serve:mvp
```

## 测试

MVP 测试使用 Node.js 20+ 自带的 test runner，不会真实调用外部 API：

```bash
node --test mvp/test/*.test.js
# 或
npm run test:mvp
```

真实 MiniMax 链路另有显式冒烟工具；只有设置 `MINIMAX_API_KEY` 后才会发送请求：

```bash
export MINIMAX_API_KEY="你的 MiniMax API Key"
node mvp/tools/llm-live-smoke.mjs
```

## 设计事实源

- [`docs/rebuild-plan.md`](docs/rebuild-plan.md)：重构阶段、系统边界与流水线时序。
- [`docs/eco-incentive-design.md`](docs/eco-incentive-design.md)：生态激励、agent 分权与 master 决策原则。

发生实现或叙述冲突时，以上两份文档是当前设计事实源。`mvp/` 是重构实现；旧 `src/` 与 `research/` 是冻结遗产，仅供追溯，不代表当前产品架构。旧版项目说明已精简保存至 [`docs/legacy-readme.md`](docs/legacy-readme.md)。

## 音源后端文档

[`flock-voice-engine`](../flock-voice-engine/) 是 engine 代码与文档唯一的 canonical
目录。本目录不再保存生成的 `flock-voice-engine/` 镜像，也不复制它的 BRIEF、README
或 docs 子树；旧镜像需要追溯时直接查看 Git 历史，当前内容只保留这条单向指针。

## 当前目录

```text
mvp/        当前树-鸟生态音序器 MVP
docs/       当前设计事实与历史说明
studies/    美术方向与静态研究
src/        冻结的旧浏览器乐器实现
research/   冻结的旧神经声源研究流水线
native/     旧原生实验
```
