// channels.test.js —— bun test: 渠道 CRUD + Configuration CRUD + (model,channel) 解析逻辑 + 门禁逻辑。
import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import * as store from "./store.js";
import { shouldChannelFail } from "./usage.js";

beforeEach(async () => {
  await store.load(":memory:");
});

test("首次建库自动 seed 3 个示例渠道(都是健康默认值——差异化行为现在挂在 Configuration 上)", () => {
  const { channels } = store.getState();
  expect(channels.length).toBe(3);
  expect(channels.map((c) => c.id)).toEqual(["primary", "backup", "flaky"]);
  for (const c of channels) {
    expect(c.enabled).toBe(1);
    expect(c.errorRate).toBe(0);
    expect(c.extraLatencyMs).toBe(0);
  }
});

test("种子渠道各自分了不冲突的独立端口(8789/8790/8791)", () => {
  const { channels } = store.getState();
  expect(channels.map((c) => c.port)).toEqual([8789, 8790, 8791]);
});

test("upsertChannel: 不给 port 自动分配一个比现有都大的、跟已有渠道不冲突的端口", async () => {
  const saved = await store.upsertChannel({ id: "auto-port-ch" });
  expect(saved.port).toBeGreaterThan(8791);
  const ports = store.getState().channels.map((c) => c.port);
  expect(new Set(ports).size).toBe(ports.length); // 全都互不相同
});

test("upsertChannel: 显式指定的端口跟别的渠道冲突会报错, 不会静默覆盖", async () => {
  await expect(store.upsertChannel({ id: "conflict-ch", port: 8789 })).rejects.toThrow(/占用/);
});

test("upsertChannel: 编辑自己(同 id)用回原来的端口不算冲突", async () => {
  const saved = await store.upsertChannel({ id: "primary", name: "主渠道", port: 8789 });
  expect(saved.port).toBe(8789);
});

test("grok-4.5 种子了 3 份 Configuration: 默认 + 绑 backup + 绑 flaky", () => {
  const configs = store.getConfigsForModel("grok-4.5");
  expect(configs.length).toBe(3);
  const [def, onBackup, onFlaky] = configs; // 按 ord
  expect(def.channelIds).toEqual([]);
  expect(onBackup.channelIds).toEqual(["backup"]);
  expect(onBackup.latencyMs).toBe(800);
  expect(onFlaky.channelIds).toEqual(["flaky"]);
  expect(onFlaky.errorEnabled).toBe(1);
  expect(onFlaky.errorRate).toBe(30);
  expect(onFlaky.errorStatus).toBe(503);
});

test("其它模型只有一份不绑渠道的默认 Configuration", () => {
  const configs = store.getConfigsForModel("deepseek-v4-flash");
  expect(configs.length).toBe(1);
  expect(configs[0].channelIds).toEqual([]);
});

test("Seedance 示例模型使用独立来源并预填结算与视频任务字段", () => {
  const model = store.getModel("doubao-seedance-1-0-pro-250528");
  const config = store.getConfigsForModel(model.id)[0];
  expect(model.vendor).toBe("seedance");
  expect(model.format).toBe("seedance");
  expect(config.completionTokens).toBe(108000);
  expect(config.seedanceVideoUrl).toBe("https://example.com/mock-video.mp4");
  expect(config.seedanceFinalStatus).toBe("succeeded");
  expect(config.seedanceResolution).toBe("1080p");
  expect(config.seedanceDuration).toBe(5);
  expect(config.seedanceRatio).toBe("16:9");
  expect(config.seedanceFramesPerSecond).toBe(24);
});

test("Seedance Configuration 可以按渠道覆盖状态机和结算 token", async () => {
  await store.upsertConfig({
    id: "seedance-on-backup",
    modelId: "doubao-seedance-1-0-pro-250528",
    name: "backup 视频任务",
    channelIds: ["backup"],
    completionTokens: 54000,
    seedanceQueuedPolls: 2,
    seedanceRunningPolls: 3,
    seedanceFinalStatus: "failed",
  });
  const resolved = store.resolveModel("doubao-seedance-1-0-pro-250528", "seedance", "backup");
  expect(resolved.completionTokens).toBe(54000);
  expect(resolved.seedanceQueuedPolls).toBe(2);
  expect(resolved.seedanceRunningPolls).toBe(3);
  expect(resolved.seedanceFinalStatus).toBe("failed");
});

test("upsertChannel: 新建 + 数字字段兜底", async () => {
  const saved = await store.upsertChannel({ id: "ch1", name: "测试渠道", errorRate: "50" });
  expect(saved.id).toBe("ch1");
  expect(saved.errorRate).toBe(50);
  expect(saved.enabled).toBe(1); // 没给, 用默认值
  expect(saved.extraLatencyMs).toBe(0);
});

test("upsertChannel: 同 id 更新而不是重复插入", async () => {
  await store.upsertChannel({ id: "ch2", name: "A" });
  await store.upsertChannel({ id: "ch2", name: "B", enabled: 0 });
  const c = store.getChannel("ch2");
  expect(c.name).toBe("B");
  expect(c.enabled).toBe(0);
  expect(store.getState().channels.filter((x) => x.id === "ch2").length).toBe(1);
});

test("getChannel: 查无此渠道返回 null", () => {
  expect(store.getChannel("no-such-channel")).toBeNull();
});

test("deleteChannel: 删除后查不到, 且清掉该渠道在 configuration_channels 里的绑定", async () => {
  await store.upsertChannel({ id: "ch3" });
  await store.upsertConfig({ id: "cfg-x", modelId: "grok-4.5", channelIds: ["ch3"] });
  await store.deleteChannel("ch3");
  expect(store.getChannel("ch3")).toBeNull();
  expect(store.getConfig("cfg-x").channelIds).toEqual([]);
});

test("reset(): 渠道/模型/Configuration 都回到种子状态", async () => {
  await store.upsertChannel({ id: "extra" });
  await store.upsertConfig({ id: "extra-cfg", modelId: "grok-4.5" });
  await store.reset();
  expect(store.getState().channels.length).toBe(3);
  expect(store.getConfigsForModel("grok-4.5").length).toBe(3);
  expect(store.getConfig("extra-cfg")).toBeNull();
});

test("upsertConfig: 新建 + 数字字段兜底 + channelIds", async () => {
  const saved = await store.upsertConfig({ id: "c1", modelId: "grok-4.5", name: "测试配置", latencyMs: "500", channelIds: ["primary"] });
  expect(saved.modelId).toBe("grok-4.5");
  expect(saved.latencyMs).toBe(500);
  expect(saved.channelIds).toEqual(["primary"]);
});

test("upsertConfig: 再次 upsert 换 channelIds 是全量替换, 不是追加", async () => {
  await store.upsertConfig({ id: "c2", modelId: "grok-4.5", channelIds: ["primary", "backup"] });
  await store.upsertConfig({ id: "c2", modelId: "grok-4.5", channelIds: ["flaky"] });
  expect(store.getConfig("c2").channelIds).toEqual(["flaky"]);
});

test("deleteConfig: 删除后查不到", async () => {
  await store.upsertConfig({ id: "c3", modelId: "grok-4.5" });
  await store.deleteConfig("c3");
  expect(store.getConfig("c3")).toBeNull();
});

test("deleteModel: 级联删掉它名下所有 Configuration", async () => {
  await store.upsertModel({ id: "m-temp", vendor: "openai" });
  await store.upsertConfig({ id: "m-temp-default", modelId: "m-temp" });
  await store.deleteModel("m-temp");
  expect(store.getModel("m-temp")).toBeNull();
  expect(store.getConfigsForModel("m-temp").length).toBe(0);
});

test("migrateToConfigurations: 老宽表(model+行为字段混一起)升级不丢数据", async () => {
  const path = import.meta.dir + "/.tmp-migration-test.db";
  if (existsSync(path)) unlinkSync(path);
  try {
    const raw = new Database(path);
    raw.run(`CREATE TABLE models (
      id TEXT PRIMARY KEY, format TEXT, vendor TEXT, content TEXT, promptMode TEXT,
      promptTokens INTEGER, completionTokens INTEGER, cacheMode TEXT, cacheRatio REAL,
      cachedTokens INTEGER, cacheCreationTokens INTEGER, latencyMs INTEGER, latencyMode TEXT,
      latencyMin INTEGER, latencyMax INTEGER, latencyDist TEXT, chunkDelayMs INTEGER,
      errorStatus INTEGER, errorRate INTEGER, errorMessage TEXT, ord INTEGER)`);
    raw.run(
      `INSERT INTO models (id, format, vendor, content, promptMode, promptTokens, completionTokens,
        cacheMode, cacheRatio, cachedTokens, cacheCreationTokens, latencyMs, latencyMode, latencyMin,
        latencyMax, latencyDist, chunkDelayMs, errorStatus, errorRate, errorMessage, ord)
       VALUES ('old-model', 'openai', 'openai', 'hello old world', 'fixed', 999, 55,
        'ratio', 0.7, 0, 0, 1234, 'fixed', 0, 0, 'uniform', 10, 0, 0, 'mock injected error', 0)`
    );
    raw.close();

    const state = await store.load(path);
    const model = state.models.find((m) => m.id === "old-model");
    expect(model).toBeTruthy();
    expect(model.vendor).toBe("openai");

    const configs = store.getConfigsForModel("old-model");
    expect(configs.length).toBe(1);
    expect(configs[0].content).toBe("hello old world");
    expect(configs[0].promptTokens).toBe(999);
    expect(configs[0].completionTokens).toBe(55);
    expect(configs[0].cacheMode).toBe("ratio");
    expect(configs[0].cacheRatio).toBe(0.7);
    expect(configs[0].latencyMs).toBe(1234);
    expect(configs[0].channelIds).toEqual([]); // 老数据迁移成不绑渠道的通用兜底

    // 老 models 表已经瘦身, 不再有 content 等行为字段
    store.close(); // Windows 下文件被占着删不掉, 先把 store.js 自己那个连接关掉
    const check = new Database(path);
    const cols = check.query("PRAGMA table_info(models)").all().map((c) => c.name);
    check.close();
    expect(cols.sort()).toEqual(["format", "id", "ord", "vendor"].sort());
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("migrateChannelColumns: 老 channels 表(上一版走 /ch/<id> 路径, 没有 port 列)升级后每个渠道分到不冲突的端口", async () => {
  const path = import.meta.dir + "/.tmp-channel-migration-test.db";
  if (existsSync(path)) unlinkSync(path);
  try {
    const raw = new Database(path);
    raw.run(`CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, errorRate INTEGER, errorStatus INTEGER, errorMessage TEXT, extraLatencyMs INTEGER, ord INTEGER)`);
    raw.run(`INSERT INTO channels (id, name, enabled, errorRate, errorStatus, errorMessage, extraLatencyMs, ord) VALUES ('old-ch-a', '老渠道A', 1, 0, 503, 'x', 0, 0)`);
    raw.run(`INSERT INTO channels (id, name, enabled, errorRate, errorStatus, errorMessage, extraLatencyMs, ord) VALUES ('old-ch-b', '老渠道B', 1, 30, 503, 'y', 0, 1)`);
    raw.close();

    await store.load(path);
    const channels = store.getState().channels;
    const ports = channels.map((c) => c.port);
    expect(new Set(ports).size).toBe(ports.length); // 互不冲突
    expect(ports.every((p) => p >= 8789)).toBe(true);

    store.close();
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("resolveModel: 渠道命中专属 Configuration", () => {
  const cfg = store.resolveModel("grok-4.5", "openai", "backup");
  expect(cfg.latencyMs).toBe(800);
  expect(cfg.id).toBe("grok-4.5"); // 身份字段用模型的, 不是 Configuration 自己的 id
  expect(cfg.vendor).toBe("grok");
});

test("resolveModel: 渠道没有专属 Configuration 时回退默认(ord 最小)", () => {
  const cfg = store.resolveModel("grok-4.5", "openai", "primary"); // primary 没绑过任何 Configuration
  expect(cfg.latencyMs).toBe(0); // 默认 Configuration 的值, 不是 backup/flaky 那两份的
  expect(cfg.errorRate).toBe(0);
});

test("resolveModel: 不传 channelId(不走 /ch/ 前缀的直连请求)也用默认 Configuration", () => {
  const cfg = store.resolveModel("grok-4.5", "openai");
  expect(cfg.latencyMs).toBe(0);
  expect(cfg.errorRate).toBe(0);
});

test("resolveModel: 模型不存在时兜底(跟旧版查无模型行为等价)", () => {
  const cfg = store.resolveModel("no-such-model", "claude", "backup");
  expect(cfg.id).toBe("no-such-model");
  expect(cfg.format).toBe("claude");
  expect(cfg.latencyMs).toBe(0);
});

test("shouldChannelFail: channel 为 null(无渠道前缀直连) 恒不失败", () => {
  expect(shouldChannelFail(null)).toBe(false);
});

test("shouldChannelFail: enabled=0 恒失败", () => {
  expect(shouldChannelFail({ enabled: 0, errorRate: 0 })).toBe(true);
});

test("shouldChannelFail: enabled=1 且 errorRate=0 恒不失败", () => {
  for (let i = 0; i < 50; i++) expect(shouldChannelFail({ enabled: 1, errorRate: 0 }, Math.random)).toBe(false);
});

test("shouldChannelFail: enabled=1 且 errorRate=100 恒失败", () => {
  for (let i = 0; i < 50; i++) expect(shouldChannelFail({ enabled: 1, errorRate: 100 }, Math.random)).toBe(true);
});

test("shouldChannelFail: 用固定 rand() 精确验证边界", () => {
  const channel = { enabled: 1, errorRate: 30 };
  expect(shouldChannelFail(channel, () => 0.29)).toBe(true);  // 29 < 30
  expect(shouldChannelFail(channel, () => 0.30)).toBe(false); // 30 !< 30
});
