// presets.js —— 内置场景预设（纯数据）。patch 是"行为字段子集"，套用时合并进模型。

export const BUILTIN_PRESETS = [
  {
    name: "正常基准",
    patch: {
      promptMode: "auto",
      completionTokens: 30,
      cacheMode: "none",
      cacheCreationTokens: 0,
      latencyMs: 0,
      errorStatus: 0,
      errorRate: 0,
    },
  },
  {
    name: "高缓存命中",
    patch: {
      promptMode: "fixed",
      promptTokens: 1000,
      cacheMode: "ratio",
      cacheRatio: 0.8,
      cacheCreationTokens: 0,
      errorStatus: 0,
      errorRate: 0,
    },
  },
  {
    name: "超长上下文",
    patch: {
      promptMode: "fixed",
      promptTokens: 210000,
      completionTokens: 500,
      errorStatus: 0,
      errorRate: 0,
    },
  },
  {
    name: "错误超时",
    patch: {
      errorStatus: 429,
      errorRate: 100,
      errorMessage: "mock injected 429 (rate limit)",
    },
  },
];
