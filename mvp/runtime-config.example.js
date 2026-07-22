// 可选的部署期运行配置模板。**不要提交实际的 runtime-config.js**（已 gitignore）：
// 端点只由部署环境写入，仓库里不留任何内网地址。
//
// 用法：部署时把本文件复制成同目录的 runtime-config.js 并填入真实地址，例如
//   cp mvp/runtime-config.example.js mvp/runtime-config.js
// 缺失该文件时 index.html 以 onerror 容错加载，启动路径直接走确定性规则层，
// 不等待任何远端，也不显示 provider / key / 诊断信息。
//
// 约束：只放无密钥的服务地址。浏览器不保存、不输入、不透传任何第三方 API Key。
// 若页面以 https 提供，这里必须同样是 https，否则浏览器按混合内容拦截，
// 表现为「静默退回规则层」，很难从 UI 上看出来。
window.LCS_RUNTIME = {
  // StepFun 服务根地址；留空或删掉本行 = 不接入任何远端。
  stepfunBase: '',
};
