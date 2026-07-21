#!/usr/bin/env bun
// scripts/cli.js —— 命令行增删改模型/预设/渠道，不用开控制台网页也能管理 mock.db。
// 直接读写 mock.db(跟 server.js 用同一个 store.js)，不需要服务在跑；服务在跑的时候也能用，
// SQLite 文件锁保证不会读到写一半的脏数据，但别跟网页控制台同时保存同一个模型/渠道(最后写的赢)。
//
// 用法：
//   bun scripts/cli.js add-model <id> [--vendor=openai] [--preset=长延迟] [--字段=值 ...]
//   bun scripts/cli.js apply-preset <modelId> <presetName>
//   bun scripts/cli.js add-preset <name> [--from=<modelId>] [--字段=值 ...]
//   bun scripts/cli.js list-models
//   bun scripts/cli.js list-presets
//   bun scripts/cli.js delete-model <id>
//   bun scripts/cli.js delete-preset <name>
//   bun scripts/cli.js add-channel <id> [--name=..] [--enabled=false] [--errorRate=30] [--extraLatencyMs=800]
//   bun scripts/cli.js list-channels
//   bun scripts/cli.js delete-channel <id>
//
// 字段名/取值跟控制台里的字段一一对应(vendor/promptMode/latencyMode/latencyMin/... 等等)，
// 具体有哪些字段看 store.js 的 MODEL_DEFAULTS / CHANNEL_DEFAULTS。

import * as store from "../store.js";

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else positional.push(arg);
  }
  return { positional, flags };
}

export function coerce(key, value) {
  return typeof store.MODEL_DEFAULTS[key] === "number" ? Number(value) : value;
}

// enabled 是渠道唯一的"布尔味"字段，用 --enabled=false/0 关掉，其余都当开；其它数字字段照常用 Number()。
export function coerceChannel(key, value) {
  if (key === "enabled") return value === "false" || value === "0" ? 0 : 1;
  return typeof store.CHANNEL_DEFAULTS[key] === "number" ? Number(value) : value;
}

// 命令函数只管抛错(不 process.exit)，方便单测；真正的进程退出码在 main() 里统一处理。
function fail(msg) {
  throw new Error(msg);
}

function usage() {
  console.log(`用法:
  bun scripts/cli.js add-model <id> [--vendor=openai] [--preset=名称] [--字段=值 ...]
  bun scripts/cli.js apply-preset <modelId> <presetName>
  bun scripts/cli.js add-preset <name> [--from=<modelId>] [--字段=值 ...]
  bun scripts/cli.js list-models
  bun scripts/cli.js list-presets
  bun scripts/cli.js delete-model <id>
  bun scripts/cli.js delete-preset <name>
  bun scripts/cli.js add-channel <id> [--name=..] [--enabled=false] [--errorRate=30] [--extraLatencyMs=800]
  bun scripts/cli.js list-channels
  bun scripts/cli.js delete-channel <id>`);
}

export async function cmdAddModel(positional, flags) {
  const id = positional[0];
  if (!id) return fail("用法: add-model <id> [--vendor=..] [--preset=..] [--字段=值 ...]");

  let model = { ...store.MODEL_DEFAULTS, id };
  if (flags.vendor) model.vendor = flags.vendor;
  if (flags.content) model.content = flags.content;

  if (flags.preset) {
    const { presets } = store.getState();
    const preset = presets.find((p) => p.name === flags.preset);
    if (!preset) return fail(`预设不存在: ${flags.preset}（先跑 list-presets 看看有哪些）`);
    model = { ...model, ...preset.patch };
  }

  for (const [k, v] of Object.entries(flags)) {
    if (k === "vendor" || k === "content" || k === "preset") continue;
    if (!(k in store.MODEL_DEFAULTS)) return fail(`未知字段: ${k}`);
    model[k] = coerce(k, v);
  }

  const saved = await store.upsertModel(model);
  console.log(`已创建/更新模型: ${saved.id}  vendor=${saved.vendor}  format=${saved.format}`);
  return saved;
}

export async function cmdApplyPreset(positional) {
  const [modelId, presetName] = positional;
  if (!modelId || !presetName) return fail("用法: apply-preset <modelId> <presetName>");
  const model = await store.applyPreset(modelId, presetName);
  if (!model) return fail("模型或预设不存在");
  console.log(`已给 ${modelId} 套用预设「${presetName}」`);
  return model;
}

export async function cmdAddPreset(positional, flags) {
  const name = positional[0];
  if (!name) return fail("用法: add-preset <name> [--from=<modelId>] [--字段=值 ...]");

  let patch = {};
  if (flags.from) {
    const model = store.getModel(flags.from);
    if (!model) return fail(`模型不存在: ${flags.from}`);
    patch = { ...model }; // upsertPreset 内部只会挑 PRESET_FIELDS，id/vendor/format/content 会被自动忽略
  }
  for (const [k, v] of Object.entries(flags)) {
    if (k === "from") continue;
    if (!(k in store.MODEL_DEFAULTS)) return fail(`未知字段: ${k}`);
    patch[k] = coerce(k, v);
  }

  const saved = await store.upsertPreset(name, patch);
  console.log(`已保存预设: ${saved.name}`);
  return saved;
}

export function cmdListModels() {
  const { models } = store.getState();
  for (const m of models) {
    const latency = m.latencyMode === "range" ? `${m.latencyMin}~${m.latencyMax}ms(${m.latencyDist})` : `${m.latencyMs}ms`;
    console.log(`${m.id}\tvendor=${m.vendor}\tformat=${m.format}\tlatency=${latency}`);
  }
  console.log(`共 ${models.length} 个模型`);
  return models;
}

export function cmdListPresets() {
  const { presets } = store.getState();
  for (const p of presets) console.log(`${p.name}\t${JSON.stringify(p.patch)}`);
  console.log(`共 ${presets.length} 个预设`);
  return presets;
}

export async function cmdDeleteModel(positional) {
  const id = positional[0];
  if (!id) return fail("用法: delete-model <id>");
  await store.deleteModel(id);
  console.log(`已删除模型: ${id}`);
}

export async function cmdDeletePreset(positional) {
  const name = positional[0];
  if (!name) return fail("用法: delete-preset <name>");
  await store.deletePreset(name);
  console.log(`已删除预设: ${name}`);
}

export async function cmdAddChannel(positional, flags) {
  const id = positional[0];
  if (!id) return fail("用法: add-channel <id> [--name=..] [--enabled=false] [--errorRate=30] [--extraLatencyMs=800]");

  let channel = { ...store.CHANNEL_DEFAULTS, id, name: id };
  for (const [k, v] of Object.entries(flags)) {
    if (!(k in store.CHANNEL_DEFAULTS)) return fail(`未知字段: ${k}`);
    channel[k] = coerceChannel(k, v);
  }

  const saved = await store.upsertChannel(channel);
  console.log(`已创建/更新渠道: ${saved.id}  name=${saved.name}  enabled=${!!saved.enabled}`);
  return saved;
}

export function cmdListChannels() {
  const { channels } = store.getState();
  for (const c of channels) console.log(`${c.id}\tname=${c.name}\tenabled=${!!c.enabled}\terrorRate=${c.errorRate}%\textraLatency=${c.extraLatencyMs}ms`);
  console.log(`共 ${channels.length} 个渠道`);
  return channels;
}

export async function cmdDeleteChannel(positional) {
  const id = positional[0];
  if (!id) return fail("用法: delete-channel <id>");
  await store.deleteChannel(id);
  console.log(`已删除渠道: ${id}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (!cmd || cmd === "-h" || cmd === "--help") return usage();

  await store.load();

  try {
    if (cmd === "add-model") return await cmdAddModel(positional, flags);
    if (cmd === "apply-preset") return await cmdApplyPreset(positional);
    if (cmd === "add-preset") return await cmdAddPreset(positional, flags);
    if (cmd === "list-models") return cmdListModels();
    if (cmd === "list-presets") return cmdListPresets();
    if (cmd === "delete-model") return await cmdDeleteModel(positional);
    if (cmd === "delete-preset") return await cmdDeletePreset(positional);
    if (cmd === "add-channel") return await cmdAddChannel(positional, flags);
    if (cmd === "list-channels") return cmdListChannels();
    if (cmd === "delete-channel") return await cmdDeleteChannel(positional);
    throw new Error(`未知命令: ${cmd}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (import.meta.main) await main();
