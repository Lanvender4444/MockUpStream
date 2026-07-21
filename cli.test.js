// cli.test.js —— bun test: 命令行增删模型/预设/渠道的核心逻辑(不测 process.exit/console，只测对 store 的读写效果)。
import { test, expect, beforeEach } from "bun:test";
import * as store from "./store.js";
import { parseArgs, coerce, coerceChannel, cmdAddModel, cmdApplyPreset, cmdAddPreset, cmdListModels, cmdListPresets, cmdDeleteModel, cmdDeletePreset, cmdAddChannel, cmdListChannels, cmdDeleteChannel } from "./scripts/cli.js";

beforeEach(async () => {
  await store.load(":memory:");
});

test("parseArgs: 混合位置参数和 --key=value", () => {
  const { positional, flags } = parseArgs(["grok-4.5", "--vendor=grok", "--latencyMs=200"]);
  expect(positional).toEqual(["grok-4.5"]);
  expect(flags).toEqual({ vendor: "grok", latencyMs: "200" });
});

test("coerce: 数字字段转 number, 字符串字段原样", () => {
  expect(coerce("latencyMs", "200")).toBe(200);
  expect(coerce("vendor", "grok")).toBe("grok");
});

test("add-model: 基本创建 + --vendor + 数字字段", async () => {
  const saved = await cmdAddModel(["my-model"], { vendor: "grok", latencyMs: "500", promptTokens: "999" });
  expect(saved.id).toBe("my-model");
  expect(saved.vendor).toBe("grok");
  expect(saved.format).toBe("openai"); // 从 vendor 推导
  expect(saved.latencyMs).toBe(500);
  expect(saved.promptTokens).toBe(999);
});

test("add-model: 没给 id 报错", async () => {
  await expect(cmdAddModel([], {})).rejects.toThrow();
});

test("add-model: 未知字段报错", async () => {
  await expect(cmdAddModel(["m1"], { notARealField: "x" })).rejects.toThrow(/未知字段/);
});

test("add-model: --preset 套用已有预设的字段", async () => {
  await cmdAddPreset(["长延迟测试"], { latencyMode: "range", latencyMin: "3000", latencyMax: "9000", latencyDist: "normal" });
  const saved = await cmdAddModel(["m2"], { preset: "长延迟测试" });
  expect(saved.latencyMode).toBe("range");
  expect(saved.latencyMin).toBe(3000);
  expect(saved.latencyMax).toBe(9000);
  expect(saved.latencyDist).toBe("normal");
});

test("add-model: 预设不存在报错", async () => {
  await expect(cmdAddModel(["m3"], { preset: "不存在的预设" })).rejects.toThrow(/预设不存在/);
});

test("add-preset: --from=<modelId> 把模型当前行为字段存成新预设", async () => {
  await cmdAddModel(["src-model"], { latencyMode: "fixed", latencyMs: "777", completionTokens: "42" });
  const saved = await cmdAddPreset(["来自 src-model"], { from: "src-model" });
  expect(saved.patch.latencyMs).toBe(777);
  expect(saved.patch.completionTokens).toBe(42);
  // 预设不应该带上 id/vendor/format/content 这些非行为字段
  expect(saved.patch.id).toBeUndefined();
  expect(saved.patch.vendor).toBeUndefined();
});

test("add-preset: --from 模型不存在报错", async () => {
  await expect(cmdAddPreset(["p1"], { from: "no-such-model" })).rejects.toThrow(/模型不存在/);
});

test("apply-preset: 套用后模型字段被覆盖", async () => {
  await cmdAddModel(["m4"], {});
  await cmdAddPreset(["p-fast"], { latencyMs: "0", completionTokens: "10" });
  const model = await cmdApplyPreset(["m4", "p-fast"]);
  expect(model.completionTokens).toBe(10);
});

test("apply-preset: 模型或预设不存在报错", async () => {
  await expect(cmdApplyPreset(["no-model", "no-preset"])).rejects.toThrow();
});

test("list-models / list-presets: 返回当前所有数据", async () => {
  await cmdAddModel(["m5"], {});
  const models = cmdListModels();
  expect(models.some((m) => m.id === "m5")).toBe(true);
  const presets = cmdListPresets();
  expect(Array.isArray(presets)).toBe(true);
});

test("delete-model / delete-preset: 删除后查不到", async () => {
  await cmdAddModel(["m6"], {});
  await cmdDeleteModel(["m6"]);
  expect(store.getModel("m6")).toBeNull();

  await cmdAddPreset(["p-del"], {});
  await cmdDeletePreset(["p-del"]);
  const { presets } = store.getState();
  expect(presets.some((p) => p.name === "p-del")).toBe(false);
});

test("coerceChannel: enabled 特殊处理, 其余数字字段照常转 number", () => {
  expect(coerceChannel("enabled", "false")).toBe(0);
  expect(coerceChannel("enabled", "0")).toBe(0);
  expect(coerceChannel("enabled", "true")).toBe(1);
  expect(coerceChannel("errorRate", "42")).toBe(42);
  expect(coerceChannel("name", "备用")).toBe("备用");
});

test("add-channel: 基本创建, 默认 name=id, 默认 enabled", async () => {
  const saved = await cmdAddChannel(["ch-a"], {});
  expect(saved.id).toBe("ch-a");
  expect(saved.name).toBe("ch-a");
  expect(saved.enabled).toBe(1);
});

test("add-channel: --enabled=false --errorRate=30 --extraLatencyMs=500", async () => {
  const saved = await cmdAddChannel(["ch-b"], { name: "慢渠道", enabled: "false", errorRate: "30", extraLatencyMs: "500" });
  expect(saved.name).toBe("慢渠道");
  expect(saved.enabled).toBe(0);
  expect(saved.errorRate).toBe(30);
  expect(saved.extraLatencyMs).toBe(500);
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
