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

// 预设只承载"行为字段"(不含 id/format/content)，套用时覆盖模型对应字段。
export const PRESET_FIELDS = COLS.filter((c) => !["id", "format", "content"].includes(c));

// 规范化预设 patch: 只保留 PRESET_FIELDS + 数字字段转 number
function normalizePatch(patch = {}) {
  const out = {};
  for (const k of PRESET_FIELDS) {
    if (patch[k] === undefined) continue;
    out[k] = typeof MODEL_DEFAULTS[k] === "number" ? Number(patch[k]) || 0 : patch[k];
  }
  return out;
}

const DEFAULT_MODELS = [
  // 大多数厂商都是 OpenAI 兼容格式(new-api 走 /v1/chat/completions);
  // 只有 Gemini(gemini 格式) 和 Claude(claude 格式) 用不同协议。
  { ...MODEL_DEFAULTS, id: "grok-4.5", format: "openai" },
  { ...MODEL_DEFAULTS, id: "deepseek-v4-flash", format: "openai" },
  { ...MODEL_DEFAULTS, id: "qwen3-max", format: "openai" },
  { ...MODEL_DEFAULTS, id: "kimi-k2", format: "openai" },
  { ...MODEL_DEFAULTS, id: "glm-4.6", format: "openai" },
  { ...MODEL_DEFAULTS, id: "mimo-v2.5", format: "openai" },
  { ...MODEL_DEFAULTS, id: "gemini-2.5-pro", format: "gemini" },
  { ...MODEL_DEFAULTS, id: "claude-opus-4-8", format: "claude" },
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

function initAuthSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), passwordHash TEXT, lanTrustRegex TEXT, publicTrustRegex TEXT, updatedAt TEXT)`);
  // 兼容旧版单字段 schema(trustedIpsRegex): 表已存在但缺新列时补列, 已存在则忽略报错
  try { db.run("ALTER TABLE auth ADD COLUMN lanTrustRegex TEXT"); } catch {}
  try { db.run("ALTER TABLE auth ADD COLUMN publicTrustRegex TEXT"); } catch {}
  const row = db.query("SELECT id FROM auth WHERE id = 1").get();
  if (!row) db.run("INSERT INTO auth (id, passwordHash, lanTrustRegex, publicTrustRegex, updatedAt) VALUES (1, NULL, NULL, NULL, NULL)");
}

function seedIfEmpty() {
  const nModels = db.query("SELECT COUNT(*) c FROM models").get().c;
  if (nModels === 0) DEFAULT_MODELS.forEach((m, i) => writeModel(m, i));
  const nPresets = db.query("SELECT COUNT(*) c FROM presets").get().c;
  if (nPresets === 0)
    BUILTIN_PRESETS.forEach((p, i) =>
      db.run("INSERT INTO presets (name, patch, ord) VALUES (?, ?, ?)", [p.name, JSON.stringify(normalizePatch(p.patch)), i]));
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

export async function load(dbPath) {
  db = new Database(dbPath || DB_PATH);
  // 配置库写操作极少, 不用 WAL(避免强杀丢未 checkpoint 的提交);
  // 默认回滚日志 + synchronous FULL => 每次提交即时落盘, 抗强杀。
  db.run("PRAGMA synchronous = FULL");
  initSchema();
  initAuthSchema();
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
  const merged = { ...model, ...normalizePatch(JSON.parse(prow.patch)) };
  return writeModel(merged); // 保留原 ord(ON CONFLICT 不动 ord)
}

// 新增/编辑预设。patch 为对象；只保留行为字段。
export async function upsertPreset(name, patch) {
  const n = String(name || "").trim();
  if (!n) return null;
  const norm = normalizePatch(patch);
  const row = db.query("SELECT ord FROM presets WHERE name = ?").get(n);
  const ord = row ? row.ord : (db.query("SELECT COALESCE(MAX(ord),-1)+1 n FROM presets").get().n || 0);
  db.run(
    "INSERT INTO presets (name, patch, ord) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET patch=excluded.patch",
    [n, JSON.stringify(norm), ord]
  );
  return { name: n, patch: norm };
}

export async function deletePreset(name) {
  db.run("DELETE FROM presets WHERE name = ?", [name]);
}

export async function reset() {
  db.run("DELETE FROM models");
  db.run("DELETE FROM presets");
  seedIfEmpty();
  return getState();
}

export function getAuthConfig() {
  const row = db.query("SELECT passwordHash, lanTrustRegex, publicTrustRegex, updatedAt FROM auth WHERE id = 1").get();
  return row || { passwordHash: null, lanTrustRegex: null, publicTrustRegex: null, updatedAt: null };
}

export function setAuthConfig(patch) {
  const cur = getAuthConfig();
  const next = {
    passwordHash: patch.passwordHash !== undefined ? patch.passwordHash : cur.passwordHash,
    lanTrustRegex: patch.lanTrustRegex !== undefined ? patch.lanTrustRegex : cur.lanTrustRegex,
    publicTrustRegex: patch.publicTrustRegex !== undefined ? patch.publicTrustRegex : cur.publicTrustRegex,
    updatedAt: new Date().toISOString(),
  };
  db.run("UPDATE auth SET passwordHash = ?, lanTrustRegex = ?, publicTrustRegex = ?, updatedAt = ? WHERE id = 1", [next.passwordHash, next.lanTrustRegex, next.publicTrustRegex, next.updatedAt]);
  return next;
}
