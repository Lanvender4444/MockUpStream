// cli.test.js —— bun test: 命令行增删模型/Configuration/预设/渠道的核心逻辑(不测 process.exit/console，只测对 store 的读写效果)。
import { test, expect, beforeEach } from "bun:test";
import * as store from "./store.js";
import {
  parseArgs, coerceConfig, coerceChannel,
  cmdAddModel, cmdAddConfig, cmdApplyPreset, cmdAddPreset,
  cmdListModels, cmdListConfigs, cmdListPresets, cmdListChannels,
  cmdDeleteModel, cmdDeleteConfig, cmdDeletePreset, cmdAddChannel, cmdDeleteChannel,
} from "./scripts/cli.js";

beforeEach(async () => {
  await store.load(":memory:");
});

test("parseArgs: 混合位置参数和 --key=value", () => {
  const { positional, flags } = parseArgs(["grok-4.5", "--vendor=grok", "--latencyMs=200"]);
  expect(positional).toEqual(["grok-4.5"]);
  expect(flags).toEqual({ vendor: "grok", latencyMs: "200" });
});

test("coerceConfig: 数字字段转 number, 字符串字段原样", () => {
  expect(coerceConfig("latencyMs", "200")).toBe(200);
  expect(coerceConfig("name", "abc")).toBe("abc");
});

test("coerceChannel: enabled 特殊处理, 其余数字字段照常转 number", () => {
  expect(coerceChannel("enabled", "false")).toBe(0);
  expect(coerceChannel("enabled", "0")).toBe(0);
  expect(coerceChannel("enabled", "true")).toBe(1);
  expect(coerceChannel("errorRate", "42")).toBe(42);
});

test("add-model: 建模型身份 + 同时建默认 Configuration", async () => {
  const model = await cmdAddModel(["my-model"], { vendor: "grok", latencyMs: "500", promptTokens: "999" });
  expect(model.id).toBe("my-model");
  expect(model.vendor).toBe("grok");
  expect(model.format).toBe("openai"); // 从 vendor 推导

  const configs = store.getConfigsForModel("my-model");
  expect(configs.length).toBe(1);
  expect(configs[0].latencyMs).toBe(500);
  expect(configs[0].promptTokens).toBe(999);
  expect(configs[0].channelIds).toEqual([]);
});

test("add-model: 没给 id 报错", async () => {
  await expect(cmdAddModel([], {})).rejects.toThrow();
});

test("add-model: 未知字段报错", async () => {
  await expect(cmdAddModel(["m1"], { notARealField: "x" })).rejects.toThrow(/未知字段/);
});

test("add-model: --preset 套用已有预设的字段到默认 Configuration", async () => {
  await cmdAddPreset(["长延迟测试"], { latencyMode: "range", latencyMin: "3000", latencyMax: "9000", latencyDist: "normal" });
  await cmdAddModel(["m2"], { preset: "长延迟测试" });
  const [config] = store.getConfigsForModel("m2");
  expect(config.latencyMode).toBe("range");
  expect(config.latencyMin).toBe(3000);
});

test("add-model: 预设不存在报错", async () => {
  await expect(cmdAddModel(["m3"], { preset: "不存在的预设" })).rejects.toThrow(/预设不存在/);
});

test("add-config: 给已有模型加一份绑渠道的 Configuration", async () => {
  await cmdAddModel(["m4"], {});
  const saved = await cmdAddConfig(["m4", "m4-on-backup"], { name: "备用渠道版", channels: "backup,flaky", latencyMs: "800" });
  expect(saved.modelId).toBe("m4");
  expect(saved.channelIds).toEqual(["backup", "flaky"]);
  expect(saved.latencyMs).toBe(800);
  expect(store.getConfigsForModel("m4").length).toBe(2); // 默认那份 + 这份
});

test("add-config: 模型不存在报错", async () => {
  await expect(cmdAddConfig(["no-such-model", "c1"], {})).rejects.toThrow(/模型不存在/);
});

test("add-config: 未知字段报错", async () => {
  await cmdAddModel(["m5"], {});
  await expect(cmdAddConfig(["m5", "c1"], { notAField: "x" })).rejects.toThrow(/未知字段/);
});

test("add-preset: --from=<configId> 把配置当前行为字段存成新预设", async () => {
  await cmdAddModel(["src-model"], { latencyMode: "fixed", latencyMs: "777", completionTokens: "42" });
  const [srcConfig] = store.getConfigsForModel("src-model");
  const saved = await cmdAddPreset(["来自 src-model"], { from: srcConfig.id });
  expect(saved.patch.latencyMs).toBe(777);
  expect(saved.patch.completionTokens).toBe(42);
  expect(saved.patch.id).toBeUndefined();
  expect(saved.patch.modelId).toBeUndefined();
});

test("add-preset: --from 配置不存在报错", async () => {
  await expect(cmdAddPreset(["p1"], { from: "no-such-config" })).rejects.toThrow(/配置不存在/);
});

test("apply-preset: 套用后 Configuration 字段被覆盖", async () => {
  await cmdAddModel(["m6"], {});
  const [config] = store.getConfigsForModel("m6");
  await cmdAddPreset(["p-fast"], { latencyMs: "0", completionTokens: "10" });
  const updated = await cmdApplyPreset([config.id, "p-fast"]);
  expect(updated.completionTokens).toBe(10);
});

test("apply-preset: 配置或预设不存在报错", async () => {
  await expect(cmdApplyPreset(["no-config", "no-preset"])).rejects.toThrow();
});

test("list-models / list-configs / list-presets: 返回当前所有数据", async () => {
  await cmdAddModel(["m7"], {});
  const models = cmdListModels();
  expect(models.some((m) => m.id === "m7")).toBe(true);
  const configs = cmdListConfigs(["m7"]);
  expect(configs.length).toBe(1);
  const presets = cmdListPresets();
  expect(Array.isArray(presets)).toBe(true);
});

test("delete-model / delete-config / delete-preset: 删除后查不到", async () => {
  await cmdAddModel(["m8"], {});
  const [config] = store.getConfigsForModel("m8");
  await cmdDeleteModel(["m8"]);
  expect(store.getModel("m8")).toBeNull();
  expect(store.getConfig(config.id)).toBeNull(); // 级联删掉

  await cmdAddModel(["m9"], {});
  await cmdAddConfig(["m9", "extra-cfg"], {});
  await cmdDeleteConfig(["extra-cfg"]);
  expect(store.getConfig("extra-cfg")).toBeNull();

  await cmdAddPreset(["p-del"], {});
  await cmdDeletePreset(["p-del"]);
  const { presets } = store.getState();
  expect(presets.some((p) => p.name === "p-del")).toBe(false);
});

test("add-channel: 基本创建, 默认 name=id, 默认 enabled, 自动分配不冲突端口", async () => {
  const saved = await cmdAddChannel(["ch-a"], {});
  expect(saved.id).toBe("ch-a");
  expect(saved.name).toBe("ch-a");
  expect(saved.enabled).toBe(1);
  expect(saved.port).toBeGreaterThanOrEqual(8789); // 种子渠道占了 8789-8791, 这个自动分配的不该跟它们撞
});

test("add-channel: --enabled=false --errorRate=30 --extraLatencyMs=500 --port=9001", async () => {
  const saved = await cmdAddChannel(["ch-b"], { name: "慢渠道", port: "9001", enabled: "false", errorRate: "30", extraLatencyMs: "500" });
  expect(saved.name).toBe("慢渠道");
  expect(saved.port).toBe(9001);
  expect(saved.enabled).toBe(0);
  expect(saved.errorRate).toBe(30);
  expect(saved.extraLatencyMs).toBe(500);
});

test("add-channel: 显式指定的端口跟已有渠道冲突要报错", async () => {
  await expect(cmdAddChannel(["ch-conflict"], { port: "8789" })).rejects.toThrow(/占用/);
});

test("add-channel: 没给 id 报错", async () => {
  await expect(cmdAddChannel([], {})).rejects.toThrow();
});

test("add-channel: 未知字段报错", async () => {
  await expect(cmdAddChannel(["ch-c"], { notAField: "x" })).rejects.toThrow(/未知字段/);
});

test("list-channels / delete-channel", async () => {
  await cmdAddChannel(["ch-d"], {});
  const channels = cmdListChannels();
  expect(channels.some((c) => c.id === "ch-d")).toBe(true);
  await cmdDeleteChannel(["ch-d"]);
  expect(store.getChannel("ch-d")).toBeNull();
});
