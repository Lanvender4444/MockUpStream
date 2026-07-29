// store.js —— SQLite 持久化（bun:sqlite，无需额外依赖）。
// 对外 API 与旧 JSON 版一致，server.js 无需改动。
// 表: models(身份) / configurations(行为快照, 挂在某个 model 下) / configuration_channels(多对多) /
//     presets(name + patch JSON) / channels

import { Database } from "bun:sqlite";
import { BUILTIN_PRESETS } from "./presets.js";

const DB_PATH = import.meta.dir + "/mock.db";

// 模型只是身份(渠道调度测试的耦合点在 Configuration 上, 不在这里)。
export const MODEL_DEFAULTS = {
  id: "default",
  vendor: "custom-openai",
  format: "openai",
};

// 厂商 -> 协议格式。厂商是给人看的身份，协议格式是技术上走哪个 endpoint，两者自动关联，
// 选厂商时不需要用户再单独选协议(openai 兼容的一大堆厂商都自动落到 openai 协议)。
export const VENDOR_FORMAT_MAP = {
  openai: "openai", claude: "claude", gemini: "gemini",
  deepseek: "openai", kimi: "openai", glm: "openai", qwen: "openai",
  hunyuan: "openai", mistral: "openai", grok: "openai", llama: "openai",
  minimax: "openai", ernie: "openai", mimo: "openai",
  "custom-openai": "openai", "custom-gemini": "gemini", "custom-claude": "claude",
};

const COLS = Object.keys(MODEL_DEFAULTS); // 列顺序 = 字段顺序

// Configuration = 一个模型底下的一份完整"行为快照"(回复内容/token/缓存/延迟/错误注入)。
// 一个模型可以有多个 Configuration，每个可以绑定一个或多个渠道(configuration_channels)；
// 请求进来按 (modelId, channelId) 找对应的 Configuration，找不到专属的就退回该模型 ord 最小的那个(默认)。
export const CONFIG_DEFAULTS = {
  id: "default",
  modelId: "",
  name: "默认",
  enabled: 1,
  content: "这是来自 mock 上游的假回复，用于测试 new-api 全链路计费与日志。",
  promptMode: "auto",
  promptTokens: 100,
  completionTokens: 30,
  cacheMode: "none",
  cacheRatio: 0.5,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  // 图片 token(用于测 new-api 图片输入/输出分离计价)。
  // imageEnabled: 总开关。0=不返回任何图片 token(默认，行为同纯文字)；1=按下面的数量返回。
  // imageFormat:  仅面板提示用——openai / gemini，标注图片明细形状 + 该打哪个端点。
  //   实际响应形状由请求打到的 endpoint 决定(见 README)，此字段不改变响应，只做选择/提示。
  // imageInputTokens: 输入里属于图片的 token(<=promptTokens)，映射到 openai 的
  //   prompt_tokens_details.image_tokens / gemini 的 promptTokensDetails[IMAGE]。
  // imageOutputTokens: 输出里属于图片(生图)的 token(<=completionTokens)，映射到 openai 的
  //   completion_tokens_details.image_tokens / gemini 的 candidatesTokensDetails[IMAGE]。
  imageEnabled: 0,
  imageFormat: "openai",
  imageInputTokens: 0,
  imageOutputTokens: 0,
  latencyMs: 0,
  latencyMode: "fixed",   // "fixed" | "range" —— range 模式下 latencyMs 不用, 看 latencyMin/Max/Dist
  latencyMin: 0,
  latencyMax: 0,
  latencyDist: "uniform", // "uniform" | "normal" —— 只在 latencyMode==="range" 时生效
  chunkDelayMs: 40,
  errorEnabled: 0,
  errorStatus: 0,
  errorRate: 0,
  errorMessage: "mock injected error",
};
const CONFIG_COLS = Object.keys(CONFIG_DEFAULTS);

// 渠道行为字段默认值(新建/兜底用)。渠道管"这条链路本身通不通/稳不稳/快不快"，
// 跟 Configuration 决定"返回什么内容"是两个独立维度，可以叠加。
export const CHANNEL_DEFAULTS = {
  id: "default",
  name: "渠道",
  // 每个渠道一个独立端口(不用路径前缀)：很多 OpenAI 兼容客户端拼 Base URL 时会用"前导斜杠"的相对路径解析
  // (new URL("/v1/...", base))，这种写法会把 base 自带的路径整段吃掉退回裸 host:port——用独立端口就没有
  // 路径可丢，跟主端口结构完全一样，对任何客户端都零风险。没显式指定就自动分配(见 writeChannel)。
  port: 8789,
  enabled: 1,             // 0/1(SQLite 没有 boolean); 0 时该渠道下所有请求直接返回渠道级错误，模拟"渠道挂了"
  errorRate: 0,           // 0-100，独立于 Configuration 自己的 errorRate，模拟"渠道不稳定，偶发失败"
  errorStatus: 0,
  errorMessage: "channel unavailable (mock)",
  extraLatencyMs: 0,      // 叠加在 Configuration 自身延迟之上，模拟"这个渠道网络更慢"
};
const CHANNEL_COLS = Object.keys(CHANNEL_DEFAULTS);

// 预设只承载"行为字段"(不含 id/modelId/name/enabled)，套用时覆盖 Configuration 对应字段。
export const PRESET_FIELDS = CONFIG_COLS.filter((c) => !["id", "modelId", "name", "enabled"].includes(c));

// 规范化预设 patch: 只保留 PRESET_FIELDS + 数字字段转 number
function normalizePatch(patch = {}) {
  const out = {};
  for (const k of PRESET_FIELDS) {
    if (patch[k] === undefined) continue;
    out[k] = typeof CONFIG_DEFAULTS[k] === "number" ? Number(patch[k]) || 0 : patch[k];
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
  { ...MODEL_DEFAULTS, id: "mimo-v2.5", format: "openai", vendor: "mimo" },
  { ...MODEL_DEFAULTS, id: "gemini-2.5-pro", format: "gemini", vendor: "gemini" },
  { ...MODEL_DEFAULTS, id: "claude-opus-4-8", format: "claude", vendor: "claude" },
  // 两个生图示例模型,和常见真实网关同名,方便直接对着测图片输入/输出计价。
  { ...MODEL_DEFAULTS, id: "gpt-image-2", format: "openai", vendor: "openai" },
  { ...MODEL_DEFAULTS, id: "gemini-3.1-flash-image-preview", format: "gemini", vendor: "gemini" },
];

// 每个模型至少一个默认 Configuration(不绑渠道 = 兜底)。给 grok-4.5 额外加两个绑定具体渠道的示例，
// 开箱即可演示"同一模型在不同渠道下表现不同"这个核心场景，不用自己现建。
const DEFAULT_CONFIGS = [
  { id: "grok-4.5-default", modelId: "grok-4.5", name: "默认" },
  { id: "grok-4.5-on-backup", modelId: "grok-4.5", name: "在 backup 渠道(慢)", latencyMs: 800, channelIds: ["backup"] },
  { id: "grok-4.5-on-flaky", modelId: "grok-4.5", name: "在 flaky 渠道(偶发故障)", errorEnabled: 1, errorStatus: 503, errorRate: 30, errorMessage: "mock channel error (simulated instability)", channelIds: ["flaky"] },
  { id: "deepseek-v4-flash-default", modelId: "deepseek-v4-flash", name: "默认" },
  { id: "qwen3-max-default", modelId: "qwen3-max", name: "默认" },
  { id: "kimi-k2-default", modelId: "kimi-k2", name: "默认" },
  { id: "glm-4.6-default", modelId: "glm-4.6", name: "默认" },
  { id: "mimo-v2.5-default", modelId: "mimo-v2.5", name: "默认" },
  { id: "gemini-2.5-pro-default", modelId: "gemini-2.5-pro", name: "默认" },
  { id: "claude-opus-4-8-default", modelId: "claude-opus-4-8", name: "默认" },
  // 生图示例配置:预填真实观测到的 token 口径,开箱即可测图片输出计价。
  // gpt-image-2:纯图输出(整段 output 都是图片)。
  { id: "gpt-image-2-default", modelId: "gpt-image-2", name: "默认", imageEnabled: 1, imageFormat: "openai", promptMode: "fixed", promptTokens: 11, completionTokens: 4354, imageOutputTokens: 4354 },
  // gemini-3.1-flash-image-preview:混合输出(图片 1120 + 文字 437)。
  { id: "gemini-3.1-flash-image-preview-default", modelId: "gemini-3.1-flash-image-preview", name: "默认", imageEnabled: 1, imageFormat: "gemini", promptMode: "fixed", promptTokens: 8, completionTokens: 1557, imageOutputTokens: 1120 },
];

// 3 个示例渠道，直接演示典型的多渠道测试场景(权重/失败转移/限流降级)。
const DEFAULT_CHANNELS = [
  { ...CHANNEL_DEFAULTS, id: "primary", name: "主渠道", port: 8789 },
  { ...CHANNEL_DEFAULTS, id: "backup", name: "备用渠道(模拟慢)", port: 8790 },
  { ...CHANNEL_DEFAULTS, id: "flaky", name: "不稳定渠道(模拟偶发故障)", port: 8791 },
];

let db;

// 规范化: 补全缺省 + 数字字段转 number + 厂商合法性校验 + 协议格式由厂商推导(不再单独校验/接受 format)
function normalizeModel(m) {
  const out = { ...MODEL_DEFAULTS, ...m };
  for (const k of COLS) {
    if (out[k] == null) out[k] = MODEL_DEFAULTS[k];
  }
  out.id = String(out.id || "").trim() || "unnamed";
  if (!VENDOR_FORMAT_MAP[out.vendor]) out.vendor = "custom-openai";
  out.format = VENDOR_FORMAT_MAP[out.vendor];
  return out;
}

function colSqlType(c) {
  return typeof MODEL_DEFAULTS[c] === "number" ? "INTEGER" : "TEXT";
}

// 规范化 Configuration: 补全缺省 + 数字字段转 number + id/modelId/name 兜底。
function normalizeConfig(c) {
  const out = { ...CONFIG_DEFAULTS, ...c };
  for (const k of CONFIG_COLS) {
    if (out[k] == null) out[k] = CONFIG_DEFAULTS[k];
    if (typeof CONFIG_DEFAULTS[k] === "number") out[k] = Number(out[k]) || 0;
  }
  out.id = String(out.id || "").trim() || "unnamed";
  out.modelId = String(out.modelId || "").trim();
  out.name = String(out.name || "").trim() || out.id;
  return out;
}

function configColSqlType(c) {
  if (typeof CONFIG_DEFAULTS[c] !== "number") return "TEXT";
  return c === "cacheRatio" ? "REAL" : "INTEGER";
}

// 规范化渠道: 补全缺省 + 数字字段转 number + id 兜底。渠道字段全是标量, 不需要像模型那样推导厂商/协议。
function normalizeChannel(c) {
  const out = { ...CHANNEL_DEFAULTS, ...c };
  for (const k of CHANNEL_COLS) {
    if (out[k] == null) out[k] = CHANNEL_DEFAULTS[k];
    if (typeof CHANNEL_DEFAULTS[k] === "number") out[k] = Number(out[k]) || 0;
  }
  out.id = String(out.id || "").trim() || "unnamed";
  return out;
}

function channelColSqlType(c) {
  return typeof CHANNEL_DEFAULTS[c] === "number" ? "INTEGER" : "TEXT";
}

function initSchema() {
  const colDefs = COLS.map((c) => (c === "id" ? "id TEXT PRIMARY KEY" : `${c} ${colSqlType(c)}`)).join(", ");
  db.run(`CREATE TABLE IF NOT EXISTS models (${colDefs}, ord INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS presets (name TEXT PRIMARY KEY, patch TEXT, ord INTEGER)`);
  const channelColDefs = CHANNEL_COLS.map((c) => (c === "id" ? "id TEXT PRIMARY KEY" : `${c} ${channelColSqlType(c)}`)).join(", ");
  db.run(`CREATE TABLE IF NOT EXISTS channels (${channelColDefs}, ord INTEGER)`);
  const configColDefs = CONFIG_COLS.map((c) => (c === "id" ? "id TEXT PRIMARY KEY" : `${c} ${configColSqlType(c)}`)).join(", ");
  db.run(`CREATE TABLE IF NOT EXISTS configurations (${configColDefs}, ord INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS configuration_channels (configId TEXT, channelId TEXT, PRIMARY KEY(configId, channelId))`);
}

// 给老库的 configurations 表补上后加的列(errorEnabled 等)。
// 跟 channel 的 migrateChannelColumns 同理: 从 CONFIG_COLS 检查缺失列, 挨个 ALTER TABLE ADD COLUMN。
function migrateConfigColumns() {
  const existing = new Set(db.query("PRAGMA table_info(configurations)").all().map((c) => c.name));
  for (const col of CONFIG_COLS) {
    if (col === "id" || existing.has(col)) continue;
    db.run(`ALTER TABLE configurations ADD COLUMN ${col} ${configColSqlType(col)}`);
  }
}

// 老库没有 vendor 列(厂商分类是后加的字段): 补列 + 按 id 关键字猜一次厂商，猜不出来的按原 format 落到对应的
// "自定义"分类。只在 vendor 列刚补上时迁移一次(用 PRAGMA 判断)，不会覆盖用户后续在新分类里的修改。
// 要在 migrateToConfigurations() 之前跑——那一步要从这张表(还是老的宽表结构)里把 vendor 一起搬走。
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

// 老库(升级前)的 models 表还是"模型+行为字段"混一起的宽表。检测到还有 content 列，就把每行的行为
// 字段整体搬成一个不绑渠道的默认 Configuration(= 兜底，任何渠道找不到专属配置都会退到它)，一个值都不丢；
// 然后把 models 表重建成瘦身版(只留 id/vendor/format/ord)。只在检测到宽表时跑一次。
function migrateToConfigurations() {
  const cols = db.query("PRAGMA table_info(models)").all().map((c) => c.name);
  if (!cols.includes("content")) return; // 已经是瘦身版

  const oldRows = db.query("SELECT * FROM models").all();
  db.run("ALTER TABLE models RENAME TO models_old_wide");
  db.run("CREATE TABLE models (id TEXT PRIMARY KEY, vendor TEXT, format TEXT, ord INTEGER)");
  for (const row of oldRows) {
    db.run("INSERT INTO models (id, vendor, format, ord) VALUES (?, ?, ?, ?)", [row.id, row.vendor, row.format, row.ord]);
    const patch = {};
    for (const k of PRESET_FIELDS) if (row[k] !== undefined) patch[k] = row[k];
    writeConfig({ id: `${row.id}-default`, modelId: row.id, name: "默认", ...patch });
  }
  db.run("DROP TABLE models_old_wide");
}

// 老库的 channels 表是上一版加的，没有 port 列(那时候渠道走 /ch/<id> 路径前缀，不是独立端口)。
// 补列后给每个已有渠道挨个分配一个不冲突的端口(8789 起，按 ord 顺序)，不会让它们全撞在默认值上。
function migrateChannelColumns() {
  const existing = new Set(db.query("PRAGMA table_info(channels)").all().map((c) => c.name));
  const hadPort = existing.has("port");
  for (const col of CHANNEL_COLS) {
    if (col === "id" || existing.has(col)) continue;
    db.run(`ALTER TABLE channels ADD COLUMN ${col} ${channelColSqlType(col)}`);
  }
  if (!hadPort) {
    const rows = db.query("SELECT id FROM channels ORDER BY ord, rowid").all();
    let nextPort = 8789;
    for (const row of rows) {
      db.run("UPDATE channels SET port = ? WHERE id = ?", [nextPort, row.id]);
      nextPort++;
    }
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
  // 渠道先种(models 下面的示例 Configuration 会引用渠道 id)
  const nChannels = db.query("SELECT COUNT(*) c FROM channels").get().c;
  if (nChannels === 0) DEFAULT_CHANNELS.forEach((c, i) => writeChannel(c, i));

  const nModels = db.query("SELECT COUNT(*) c FROM models").get().c;
  if (nModels === 0) {
    DEFAULT_MODELS.forEach((m, i) => writeModel(m, i));
    DEFAULT_CONFIGS.forEach((c) => writeConfig(c)); // ord 按 modelId 各自从 0 自增, 不用手动传
  }

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

// upsert 一个渠道(带排序号)，写法照抄 writeModel
function writeChannel(c, ord) {
  const channel = normalizeChannel(c);

  // 没显式给端口: 自动分配一个没被占用的(现有渠道端口最大值+1, 起步 8789)。
  if (c.port == null) {
    const row = db.query("SELECT COALESCE(MAX(port), 8788) n FROM channels WHERE id != ?").get(channel.id);
    channel.port = Math.max(row.n + 1, 8789);
  } else {
    const conflict = db.query("SELECT id FROM channels WHERE port = ? AND id != ?").get(channel.port, channel.id);
    if (conflict) throw new Error(`端口 ${channel.port} 已经被渠道「${conflict.id}」占用了，换一个`);
  }

  const placeholders = CHANNEL_COLS.map(() => "?").join(", ");
  const updates = CHANNEL_COLS.filter((k) => k !== "id").map((k) => `${k}=excluded.${k}`).join(", ");
  const vals = CHANNEL_COLS.map((k) => channel[k]);
  const useOrd = ord ?? (db.query("SELECT COALESCE(MAX(ord),-1)+1 n FROM channels").get().n || 0);
  db.run(
    `INSERT INTO channels (${CHANNEL_COLS.join(",")}, ord) VALUES (${placeholders}, ?)
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
    [...vals, useOrd]
  );
  return channel;
}

// upsert 一个 Configuration(带排序号，缺省时按所属模型各自从 0 自增)。
// channelIds(如果传了数组)驱动 configuration_channels 联表: 全量替换(先删后插)，简单可靠。
function writeConfig(c, ord) {
  const config = normalizeConfig(c);
  const placeholders = CONFIG_COLS.map(() => "?").join(", ");
  const updates = CONFIG_COLS.filter((k) => k !== "id").map((k) => `${k}=excluded.${k}`).join(", ");
  const vals = CONFIG_COLS.map((k) => config[k]);
  const useOrd = ord ?? (db.query("SELECT COALESCE(MAX(ord),-1)+1 n FROM configurations WHERE modelId = ?").get(config.modelId).n || 0);
  db.run(
    `INSERT INTO configurations (${CONFIG_COLS.join(",")}, ord) VALUES (${placeholders}, ?)
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
    [...vals, useOrd]
  );
  if (Array.isArray(c.channelIds)) {
    db.run("DELETE FROM configuration_channels WHERE configId = ?", [config.id]);
    for (const chId of c.channelIds) {
      db.run("INSERT OR IGNORE INTO configuration_channels (configId, channelId) VALUES (?, ?)", [config.id, chId]);
    }
  }
  return getConfig(config.id);
}

function nextOrd() {
  return (db.query("SELECT COALESCE(MAX(ord),-1)+1 n FROM models").get().n) || 0;
}

function rowToModel(row) {
  const { ord, ...rest } = row;
  return normalizeModel(rest);
}

function rowToChannel(row) {
  const { ord, ...rest } = row;
  return normalizeChannel(rest);
}

function rowToConfig(row) {
  const { ord, ...rest } = row;
  const config = normalizeConfig(rest);
  config.channelIds = db.query("SELECT channelId FROM configuration_channels WHERE configId = ? ORDER BY channelId").all(config.id).map((r) => r.channelId);
  return config;
}

// ---------- 对外 API（与旧版一致）----------

export async function load(dbPath) {
  db = new Database(dbPath || DB_PATH);
  // 配置库写操作极少, 不用 WAL(避免强杀丢未 checkpoint 的提交);
  // 默认回滚日志 + synchronous FULL => 每次提交即时落盘, 抗强杀。
  db.run("PRAGMA synchronous = FULL");
  initSchema();
  migrateVendorColumn();
  migrateToConfigurations();
  migrateConfigColumns();
  migrateChannelColumns();
  initAuthSchema();
  initTestSchema();
  seedIfEmpty();
  return getState();
}

// 主要给测试用: 关掉当前连接(比如迁移测试要在临时文件上验证完就删掉, Windows 下文件被占着删不掉)。
export function close() {
  if (db) db.close();
}

export function getState() {
  const models = db.query("SELECT * FROM models ORDER BY ord, rowid").all().map(rowToModel);
  const configurations = db.query("SELECT * FROM configurations ORDER BY modelId, ord, rowid").all().map(rowToConfig);
  const presets = db.query("SELECT name, patch FROM presets ORDER BY ord, rowid").all()
    .map((r) => ({ name: r.name, patch: JSON.parse(r.patch) }));
  const channels = db.query("SELECT * FROM channels ORDER BY ord, rowid").all().map(rowToChannel);
  return { models, configurations, presets, channels };
}

export function getModel(id) {
  const row = db.query("SELECT * FROM models WHERE id = ?").get(id);
  return row ? rowToModel(row) : null;
}

export function getConfigsForModel(modelId) {
  return db.query("SELECT * FROM configurations WHERE modelId = ? ORDER BY ord, rowid").all(modelId).map(rowToConfig);
}

export function getConfig(id) {
  const row = db.query("SELECT * FROM configurations WHERE id = ?").get(id);
  return row ? rowToConfig(row) : null;
}

// 核心解析: 按 (modelId, channelId) 找该模型在这个渠道下该用哪份 Configuration。
//   跳过 disabled (enabled=0) 的 Configuration。
//   有专属绑定 channelId 的 Configuration -> 用它
//   没有(渠道没配过/没传 channelId，包括不走 /ch/ 前缀的直连请求) -> 退回该模型 ord 最小且 enabled 的那个(默认)
//   模型本身都查无 -> 兜底成 MODEL_DEFAULTS+CONFIG_DEFAULTS(跟旧版查无模型时的行为等价)
export function resolveModel(id, fallbackFormat = "openai", channelId = null) {
  const model = getModel(id);
  if (!model) {
    return { ...MODEL_DEFAULTS, ...CONFIG_DEFAULTS, id: id || "default", format: fallbackFormat, modelId: id || "default" };
  }
  const configs = getConfigsForModel(model.id).filter((c) => c.enabled !== 0);
  let config = channelId ? configs.find((c) => c.channelIds.includes(channelId)) : null;
  if (!config) config = configs[0];
  if (!config) config = { ...CONFIG_DEFAULTS, modelId: model.id };
  return { ...CONFIG_DEFAULTS, ...config, ...model };
}

export async function upsertModel(m) {
  return writeModel(m);
}

export async function deleteModel(id) {
  const configs = getConfigsForModel(id);
  for (const c of configs) db.run("DELETE FROM configuration_channels WHERE configId = ?", [c.id]);
  db.run("DELETE FROM configurations WHERE modelId = ?", [id]);
  db.run("DELETE FROM models WHERE id = ?", [id]);
}

export async function upsertConfig(c) {
  return writeConfig(c);
}

export async function deleteConfig(id) {
  db.run("DELETE FROM configuration_channels WHERE configId = ?", [id]);
  db.run("DELETE FROM configurations WHERE id = ?", [id]);
}

export function getChannel(id) {
  const row = db.query("SELECT * FROM channels WHERE id = ?").get(id);
  return row ? rowToChannel(row) : null;
}

export async function upsertChannel(c) {
  return writeChannel(c);
}

export async function deleteChannel(id) {
  db.run("DELETE FROM configuration_channels WHERE channelId = ?", [id]);
  db.run("DELETE FROM channels WHERE id = ?", [id]);
}

// 套用预设到某个 Configuration(不是模型)。保留原 ord 和原有的 channelIds 绑定(预设只改行为字段)。
export async function applyPreset(configId, presetName) {
  const config = getConfig(configId);
  const prow = db.query("SELECT patch FROM presets WHERE name = ?").get(presetName);
  if (!config || !prow) return null;
  const merged = { ...config, ...normalizePatch(JSON.parse(prow.patch)) };
  return writeConfig(merged);
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

// ---------- 测试配置 ----------

export const TEST_CONFIG_DEFAULTS = {
  id: "",
  name: "",
  targetUrl: "",
  model: "",
  format: "openai",
  apiKey: "",
  channelId: "",
  prompt: "",
  stream: 0,
  requestMode: "batch",
  count: 20,
  concurrency: 5,
  createdAt: "",
  updatedAt: "",
};
const TEST_COLS = Object.keys(TEST_CONFIG_DEFAULTS);

function initTestSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS test_configs (
    id TEXT PRIMARY KEY,
    name TEXT, targetUrl TEXT, model TEXT, format TEXT, apiKey TEXT,
    channelId TEXT, prompt TEXT, stream INTEGER,
    requestMode TEXT, count INTEGER, concurrency INTEGER,
    passwordHash TEXT, createdAt TEXT, updatedAt TEXT, ord INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS test_results (
    configId TEXT PRIMARY KEY, summary TEXT, requests TEXT, updatedAt TEXT
  )`);
}

function normalizeTestConfig(c) {
  const out = { ...TEST_CONFIG_DEFAULTS, ...c };
  for (const k of TEST_COLS) {
    if (out[k] == null) out[k] = TEST_CONFIG_DEFAULTS[k];
    if (typeof TEST_CONFIG_DEFAULTS[k] === "number") out[k] = Number(out[k]) || 0;
  }
  out.id = String(out.id || "").trim() || crypto.randomUUID();
  out.name = String(out.name || "").trim() || "未命名测试";
  return out;
}

function getTestPasswordHash(id) {
  const row = db.query("SELECT passwordHash FROM test_configs WHERE id = ?").get(id);
  return row ? row.passwordHash : undefined;
}

export function getTestConfigs() {
  return db.query("SELECT * FROM test_configs ORDER BY ord, rowid").all().map((r) => {
    const { ord, passwordHash, ...rest } = r;
    return { ...rest, hasPassword: !!passwordHash };
  });
}

export function getTestConfig(id) {
  const row = db.query("SELECT * FROM test_configs WHERE id = ?").get(id);
  if (!row) return null;
  const { ord, passwordHash, ...rest } = row;
  return { ...rest, hasPassword: !!passwordHash, _passwordHash: passwordHash };
}

export async function upsertTestConfig(c) {
  const cfg = normalizeTestConfig(c);
  const now = new Date().toISOString();
  if (!cfg.createdAt) cfg.createdAt = now;
  cfg.updatedAt = now;

  const ph = c.passwordHash !== undefined ? c.passwordHash : (getTestPasswordHash(cfg.id) || "");
  const cols = TEST_COLS.filter((k) => k !== "passwordHash");
  const placeholders = cols.map(() => "?").join(", ");
  const updates = cols.filter((k) => k !== "id").map((k) => `${k}=excluded.${k}`).join(", ");
  const vals = cols.map((k) => cfg[k]);
  const ord = db.query("SELECT COALESCE(MAX(ord),-1)+1 n FROM test_configs").get().n || 0;
  db.run(
    `INSERT INTO test_configs (${cols.join(",")}, passwordHash, ord) VALUES (${placeholders}, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ${updates}, passwordHash=excluded.passwordHash, updatedAt=excluded.updatedAt`,
    [...vals, ph, ord]
  );
  return getTestConfig(cfg.id);
}

export async function deleteTestConfig(id) {
  db.run("DELETE FROM test_results WHERE configId = ?", [id]);
  db.run("DELETE FROM test_configs WHERE id = ?", [id]);
}

export function getTestResult(configId) {
  const row = db.query("SELECT * FROM test_results WHERE configId = ?").get(configId);
  if (!row) return null;
  return { ...row, summary: JSON.parse(row.summary), requests: JSON.parse(row.requests) };
}

export function setTestResult(configId, summary, requests) {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO test_results (configId, summary, requests, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(configId) DO UPDATE SET summary=excluded.summary, requests=excluded.requests, updatedAt=excluded.updatedAt",
    [configId, JSON.stringify(summary), JSON.stringify(requests), now]
  );
}

export async function reset() {
  db.run("DELETE FROM models");
  db.run("DELETE FROM configurations");
  db.run("DELETE FROM configuration_channels");
  db.run("DELETE FROM presets");
  db.run("DELETE FROM channels");
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
