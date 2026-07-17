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
  chunkDelayMs: 40,
  errorStatus: 0,
  errorRate: 0,
  errorMessage: "mock injected error",
};

export const BUILTIN_PRESETS = [
  { name: "正常基准", patch: { ...base } },
  { name: "高缓存命中", patch: { ...base, promptMode: "fixed", promptTokens: 1000, cacheMode: "ratio", cacheRatio: 0.8 } },
  { name: "超长上下文", patch: { ...base, promptMode: "fixed", promptTokens: 210000, completionTokens: 500 } },
  { name: "超长输出", patch: { ...base, completionTokens: 3000000, chunkDelayMs: 2 } },
  { name: "错误超时", patch: { ...base, errorStatus: 429, errorRate: 100, errorMessage: "mock injected 429 (rate limit)" } },
];
