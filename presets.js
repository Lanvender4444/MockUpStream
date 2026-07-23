// presets.js —— 内置场景预设。每个 patch 是"完整行为快照"(不含 id/format/content)，
// 套用即得确定结果，无需依赖模型原有值。

const base = {
  promptMode: "auto",
  promptTokens: 100,
  completionTokens: 30,
  cacheMode: "none",
  cacheRatio: 0.5,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  latencyMs: 0,
  latencyMode: "fixed",
  latencyMin: 0,
  latencyMax: 0,
  latencyDist: "uniform",
  chunkDelayMs: 40,
  errorEnabled: 0,
  errorStatus: 0,
  errorRate: 0,
  errorMessage: "mock injected error",
};

export const BUILTIN_PRESETS = [
  { name: "正常基准", patch: { ...base } },
  { name: "高缓存命中", patch: { ...base, promptMode: "fixed", promptTokens: 1000, cacheMode: "ratio", cacheRatio: 0.8 } },
  { name: "超长上下文", patch: { ...base, promptMode: "fixed", promptTokens: 210000, completionTokens: 500 } },
  { name: "超长输出", patch: { ...base, completionTokens: 3000000, chunkDelayMs: 2 } },
  { name: "长延迟", patch: { ...base, latencyMode: "range", latencyMin: 3000, latencyMax: 10000, latencyDist: "normal" } },
  { name: "错误超时", patch: { ...base, errorEnabled: 1, errorStatus: 429, errorRate: 100, errorMessage: "mock injected 429 (rate limit)" } },
  // 500 + 不命中 new-api 默认排除规则(400/408/422 状态码、"invalid params"等消息正则都会被排除)的错误信息，
  // 确保打到 new-api 时被 IsExcludedError 判定为 ErrorLevelFailed，真正计入渠道失败率/触发熔断——
  // 用来测"渠道失败率死"这类场景，而不是被 new-api 悄悄排除、误以为测试生效了实际上没生效。
  { name: "渠道失败(计入 new-api 失败率)", patch: { ...base, errorEnabled: 1, errorStatus: 500, errorRate: 100, errorMessage: "mock upstream failure for testing timeout-death review" } },
];
