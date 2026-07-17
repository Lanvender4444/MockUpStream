// store.js —— SQLite 持久化（bun:sqlite，无需额外依赖）。
// 对外 API 与旧 JSON 版一致，server.js 无需改动。
// 表:  models(固定列)  /  presets(name + patch JSON)

import { Database } from "bun:sqlite";
import { BUILTIN_PRESETS } from "./presets.js";

const DB_PATH = import.meta.dir + "/mock.db";

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

const COLS = Object.keys(MODEL_DEFAULTS); // 列顺序 = 字段顺序

const DEFAULT_MODELS = [
  { ...MODEL_DEFAULTS, id: "grok-4.5", format: "openai" },
  { ...MODEL_DEFAULTS, id: "claude-opus", format: "claude" },
  { ...MODEL_DEFAULTS, id: "gemini-2.5-pro", format: "gemini" },
];

let db;

// 规范化: 补全缺省 + 数字字段转 number + 合法 format
function normalizeModel(m) {
  const out = { ...MODEL_DEFAULTS, ...m };
  for (const k of COLS) {
    if (typeof MODEL_DEFAULTS[k] === "number") out[k] = Number(out[k]) || 0;
  }
  out.id = String(out.id || "").trim() || "unnamed";
  if (!["openai", "claude", "gemini"].includes(out.format)) out.format = "openai";
  return out;
}

function initSchema() {
  const colDefs = COLS.map((c) => {
    if (c === "id") return "id TEXT PRIMARY KEY";
    const t = typeof MODEL_DEFAULTS[c] === "number"
      ? (c === "cacheRatio" ? "REAL" : "INTEGER")
      : "TEXT";
    return `${c} ${t}`;
  }).join(", ");
  db.run(`CREATE TABLE IF NOT EXISTS models (${colDefs}, ord INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS presets (name TEXT PRIMARY KEY, patch TEXT, ord INTEGER)`);
}

function seedIfEmpty() {
  const nModels = db.query("SELECT COUNT(*) c FROM models").get().c;
  if (nModels === 0) DEFAULT_MODELS.forEach((m, i) => writeModel(m, i));
  const nPresets = db.query("SELECT COUNT(*) c FROM presets").get().c;
  if (nPresets === 0)
    BUILTIN_PRESETS.forEach((p, i) =>
      db.run("INSERT INTO presets (name, patch, ord) VALUES (?, ?, ?)", [p.name, JSON.stringify(p.patch), i]));
}

// upsert 一个模型(带排序号)
function writeModel(m, ord) {
  const model = normalizeModel(m);
  const placeholders = COLS.map(() => "?").join(", ");
  const updates = COLS.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`).join(", ");
  const vals = COLS.map((c) => model[c]);
  // ord: 新行用传入值; 冲突更新时保留原 ord
  const useOrd = ord ?? nextOrd();
  db.run(
    `INSERT INTO models (${COLS.join(",")}, ord) VALUES (${placeholders}, ?)
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
    [...vals, useOrd]
  );
  return model;
}

function nextOrd() {
  return (db.query("SELECT COALESCE(MAX(ord),-1)+1 n FROM models").get().n) || 0;
}

function rowToModel(row) {
  const { ord, ...rest } = row;
  return normalizeModel(rest);
}

// ---------- 对外 API（与旧版一致）----------

export async function load() {
  db = new Database(DB_PATH);
  // 配置库写操作极少, 不用 WAL(避免强杀丢未 checkpoint 的提交);
  // 默认回滚日志 + synchronous FULL => 每次提交即时落盘, 抗强杀。
  db.run("PRAGMA synchronous = FULL");
  initSchema();
  seedIfEmpty();
  return getState();
}

export function getState() {
  const models = db.query("SELECT * FROM models ORDER BY ord, rowid").all().map(rowToModel);
  const presets = db.query("SELECT name, patch FROM presets ORDER BY ord, rowid").all()
    .map((r) => ({ name: r.name, patch: JSON.parse(r.patch) }));
  return { models, presets };
}

export function getModel(id) {
  const row = db.query("SELECT * FROM models WHERE id = ?").get(id);
  return row ? rowToModel(row) : null;
}

// 兜底: 找不到模型时返回默认(format 按 endpoint 传入)
export function resolveModel(id, fallbackFormat = "openai") {
  return getModel(id) || { ...MODEL_DEFAULTS, id: id || "default", format: fallbackFormat };
}

export async function upsertModel(m) {
  return writeModel(m);
}

export async function deleteModel(id) {
  db.run("DELETE FROM models WHERE id = ?", [id]);
}

export async function applyPreset(id, presetName) {
  const model = getModel(id);
  const prow = db.query("SELECT patch FROM presets WHERE name = ?").get(presetName);
  if (!model || !prow) return null;
  const merged = { ...model, ...JSON.parse(prow.patch) };
  return writeModel(merged); // 保留原 ord(ON CONFLICT 不动 ord)
}

export async function reset() {
  db.run("DELETE FROM models");
  db.run("DELETE FROM presets");
  seedIfEmpty();
  return getState();
}
