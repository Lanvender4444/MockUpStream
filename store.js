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
  vendor: "custom-openai",
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

// 厂商 -> 协议格式。厂商是给人看的身份，协议格式是技术上走哪个 endpoint，两者自动关联，
// 选厂商时不需要用户再单独选协议(openai 兼容的一大堆厂商都自动落到 openai 协议)。
export const VENDOR_FORMAT_MAP = {
  openai: "openai", claude: "claude", gemini: "gemini",
  deepseek: "openai", kimi: "openai", glm: "openai", qwen: "openai",
  hunyuan: "openai", mistral: "openai", grok: "openai", llama: "openai",
  minimax: "openai", ernie: "openai",
  "custom-openai": "openai", "custom-gemini": "gemini", "custom-claude": "claude",
};

const COLS = Object.keys(MODEL_DEFAULTS); // 列顺序 = 字段顺序

// 预设只承载"行为字段"(不含 id/format/vendor/content)，套用时覆盖模型对应字段。
export const PRESET_FIELDS = COLS.filter((c) => !["id", "format", "vendor", "content"].includes(c));

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
  { ...MODEL_DEFAULTS, id: "grok-4.5", format: "openai", vendor: "grok" },
  { ...MODEL_DEFAULTS, id: "deepseek-v4-flash", format: "openai", vendor: "deepseek" },
  { ...MODEL_DEFAULTS, id: "qwen3-max", format: "openai", vendor: "qwen" },
  { ...MODEL_DEFAULTS, id: "kimi-k2", format: "openai", vendor: "kimi" },
  { ...MODEL_DEFAULTS, id: "glm-4.6", format: "openai", vendor: "glm" },
  { ...MODEL_DEFAULTS, id: "mimo-v2.5", format: "openai", vendor: "custom-openai" },
  { ...MODEL_DEFAULTS, id: "gemini-2.5-pro", format: "gemini", vendor: "gemini" },
  { ...MODEL_DEFAULTS, id: "claude-opus-4-8", format: "claude", vendor: "claude" },
];

let db;

// 规范化: 补全缺省 + 数字字段转 number + 厂商合法性校验 + 协议格式由厂商推导(不再单独校验/接受 format)
function normalizeModel(m) {
  const out = { ...MODEL_DEFAULTS, ...m };
  for (const k of COLS) {
    if (typeof MODEL_DEFAULTS[k] === "number") out[k] = Number(out[k]) || 0;
  }
  out.id = String(out.id || "").trim() || "unnamed";
  if (!VENDOR_FORMAT_MAP[out.vendor]) out.vendor = "custom-openai";
  out.format = VENDOR_FORMAT_MAP[out.vendor];
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

// 老库没有 vendor 列(厂商分类是后加的字段): 补列 + 按 id 关键字猜一次厂商，猜不出来的按原 format 落到对应的
// "自定义"分类。只在 vendor 列刚补上时迁移一次(用 PRAGMA 判断)，不会覆盖用户后续在新分类里的修改。
const VENDOR_GUESS_KEYWORDS = { gpt: "openai", ...Object.fromEntries(Object.keys(VENDOR_FORMAT_MAP).map((v) => [v, v])) };
function guessVendorFromId(id, fallbackFormat) {
  const lower = String(id || "").toLowerCase();
  for (const [kw, vendor] of Object.entries(VENDOR_GUESS_KEYWORDS)) {
    if (lower.includes(kw)) return vendor;
  }
  return `custom-${fallbackFormat}`;
}
function migrateVendorColumn() {
  const cols = db.query("PRAGMA table_info(models)").all().map((c) => c.name);
  if (cols.includes("vendor")) return;
  db.run("ALTER TABLE models ADD COLUMN vendor TEXT");
  const rows = db.query("SELECT id, format FROM models").all();
  for (const row of rows) {
    db.run("UPDATE models SET vendor = ? WHERE id = ?", [guessVendorFromId(row.id, row.format || "openai"), row.id]);
  }
}

const DEFAULT_LAN_MODE = "allow-all";
const DEFAULT_PUBLIC_MODE = "whitelist";

function initAuthSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), passwordHash TEXT, lanMode TEXT, lanList TEXT, publicMode TEXT, publicList TEXT, updatedAt TEXT)`);
  // 兼容更早期的 schema(单字段 trustedIpsRegex / 老版 lanTrustRegex+publicTrustRegex): 表已存在但缺新列时补列, 已存在则忽略报错
  for (const col of ["lanMode", "lanList", "publicMode", "publicList"]) {
    try { db.run(`ALTER TABLE auth ADD COLUMN ${col} TEXT`); } catch {}
  }
  const row = db.query("SELECT id FROM auth WHERE id = 1").get();
  if (!row) {
    db.run("INSERT INTO auth (id, passwordHash, lanMode, lanList, publicMode, publicList, updatedAt) VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL)");
    return;
  }
  migrateLegacyTrustColumns();
}

// 老版本(单字段 lanTrustRegex/publicTrustRegex, 有值即代表"只信任这个正则")迁移成新的
// mode+list 模型: 映射成 whitelist 模式 + 原正则当 list, 保留原有限制意图, 不静默放宽成 allow-all。
// 只在 lanMode/publicMode 还没写过值时迁移一次, 之后重复启动不会覆盖用户在新模型下的修改。
function migrateLegacyTrustColumns() {
  const cols = db.query("PRAGMA table_info(auth)").all().map((c) => c.name);
  if (!cols.includes("lanTrustRegex") && !cols.includes("publicTrustRegex")) return;
  const row = db.query("SELECT * FROM auth WHERE id = 1").get();
  if (!row) return;
  if (cols.includes("lanTrustRegex") && row.lanTrustRegex && !row.lanMode) {
    db.run("UPDATE auth SET lanMode = 'whitelist', lanList = ? WHERE id = 1", [row.lanTrustRegex]);
  }
  if (cols.includes("publicTrustRegex") && row.publicTrustRegex && !row.publicMode) {
    db.run("UPDATE auth SET publicMode = 'whitelist', publicList = ? WHERE id = 1", [row.publicTrustRegex]);
  }
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
  migrateVendorColumn();
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
  const row = db.query("SELECT passwordHash, lanMode, lanList, publicMode, publicList, updatedAt FROM auth WHERE id = 1").get()
    || { passwordHash: null, lanMode: null, lanList: null, publicMode: null, publicList: null, updatedAt: null };
  return {
    passwordHash: row.passwordHash,
    lan: { mode: row.lanMode || DEFAULT_LAN_MODE, list: row.lanList || null },
    public: { mode: row.publicMode || DEFAULT_PUBLIC_MODE, list: row.publicList || null },
    updatedAt: row.updatedAt,
  };
}

export function setAuthConfig(patch) {
  const cur = getAuthConfig();
  const next = {
    passwordHash: patch.passwordHash !== undefined ? patch.passwordHash : cur.passwordHash,
    lan: {
      mode: (patch.lan && patch.lan.mode !== undefined) ? patch.lan.mode : cur.lan.mode,
      list: (patch.lan && patch.lan.list !== undefined) ? patch.lan.list : cur.lan.list,
    },
    public: {
      mode: (patch.public && patch.public.mode !== undefined) ? patch.public.mode : cur.public.mode,
      list: (patch.public && patch.public.list !== undefined) ? patch.public.list : cur.public.list,
    },
    updatedAt: new Date().toISOString(),
  };
  db.run(
    "UPDATE auth SET passwordHash = ?, lanMode = ?, lanList = ?, publicMode = ?, publicList = ?, updatedAt = ? WHERE id = 1",
    [next.passwordHash, next.lan.mode, next.lan.list, next.public.mode, next.public.list, next.updatedAt]
  );
  return next;
}
