// store.js —— config.json 读写 + models/presets 增删改查。内存态为主, 写操作后落盘。

import { BUILTIN_PRESETS } from "./presets.js";

const CONFIG_PATH = import.meta.dir + "/config.json";

// 模型行为字段默认值(新建/兜底用)
export const MODEL_DEFAULTS = {
  id: "default",
  format: "openai",
  content: "这是来自 mock 上游的假回复，用于测试 new-api 全链路计费与日志。",
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

function defaultState() {
  return {
    models: [
      { ...MODEL_DEFAULTS, id: "grok-4.5", format: "openai" },
      { ...MODEL_DEFAULTS, id: "claude-opus", format: "claude", cacheCreationTokens: 0 },
      { ...MODEL_DEFAULTS, id: "gemini-2.5-pro", format: "gemini" },
    ],
    presets: structuredClone(BUILTIN_PRESETS),
  };
}

let state = defaultState();

// 规范化一个模型对象: 补全缺省字段 + 数字字段转 number
function normalizeModel(m) {
  const out = { ...MODEL_DEFAULTS, ...m };
  for (const k of Object.keys(MODEL_DEFAULTS)) {
    if (typeof MODEL_DEFAULTS[k] === "number") out[k] = Number(out[k]) || 0;
  }
  out.id = String(out.id || "").trim() || "unnamed";
  if (!["openai", "claude", "gemini"].includes(out.format)) out.format = "openai";
  return out;
}

export async function load() {
  try {
    const f = Bun.file(CONFIG_PATH);
    if (await f.exists()) {
      const parsed = JSON.parse(await f.text());
      state = {
        models: Array.isArray(parsed.models) && parsed.models.length
          ? parsed.models.map(normalizeModel)
          : defaultState().models,
        presets: Array.isArray(parsed.presets) && parsed.presets.length
          ? parsed.presets
          : structuredClone(BUILTIN_PRESETS),
      };
    } else {
      await persist();
    }
  } catch (e) {
    console.error("[store] config.json 解析失败, 回退默认:", e.message);
    state = defaultState();
  }
  return state;
}

async function persist() {
  try {
    await Bun.write(CONFIG_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[store] 落盘失败:", e.message);
  }
}

export function getState() {
  return state;
}

export function getModel(id) {
  return state.models.find((m) => m.id === id) || null;
}

// 兜底: 找不到模型时用第一个同名->否则默认(format 按 endpoint 传入)
export function resolveModel(id, fallbackFormat = "openai") {
  return getModel(id) || { ...MODEL_DEFAULTS, id: id || "default", format: fallbackFormat };
}

export async function upsertModel(m) {
  const model = normalizeModel(m);
  const i = state.models.findIndex((x) => x.id === model.id);
  if (i >= 0) state.models[i] = model;
  else state.models.push(model);
  await persist();
  return model;
}

export async function deleteModel(id) {
  state.models = state.models.filter((m) => m.id !== id);
  await persist();
}

export async function applyPreset(id, presetName) {
  const model = getModel(id);
  const preset = state.presets.find((p) => p.name === presetName);
  if (!model || !preset) return null;
  Object.assign(model, preset.patch);
  const norm = normalizeModel(model);
  const i = state.models.findIndex((x) => x.id === id);
  state.models[i] = norm;
  await persist();
  return norm;
}

export async function reset() {
  state = defaultState();
  await persist();
  return state;
}
