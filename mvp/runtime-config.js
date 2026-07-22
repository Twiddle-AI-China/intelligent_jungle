// 部署期运行配置：只放无密钥的服务地址，**不得提交任何真实内网/生产端点**。
// 仓库内保持空值 = 默认不接入任何远端，启动路径直接走确定性规则层。
// 部署时由环境覆写本文件（模板与说明见 runtime-config.example.js）。
window.LCS_RUNTIME = {
  stepfunBase: '',
};
