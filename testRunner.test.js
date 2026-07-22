// testRunner.test.js —— bun test: 压测核心逻辑(resolveTarget / buildRequestBody / runBurstTest)。
import { test, expect } from "bun:test";
import { resolveTarget } from "./testRunner.js";

const STATE = {
  port: 8788,
  models: [
    { id: "grok-4.5", vendor: "grok", format: "openai" },
    { id: "claude-opus-4-8", vendor: "claude", format: "claude" },
    { id: "gemini-2.5-pro", vendor: "gemini", format: "gemini" },
  ],
  channels: [
    { id: "primary", name: "主渠道", port: 8789, enabled: 1 },
    { id: "backup", name: "备用渠道", port: 8790, enabled: 1 },
  ],
};

test("resolveTarget: 不指定渠道 -> 主端口 + 模型自己的协议格式", () => {
  const r = resolveTarget(STATE, { modelId: "grok-4.5", channelId: null });
  expect(r).toEqual({ format: "openai", port: 8788 });
});

test("resolveTarget: 指定已有渠道 -> 该渠道的端口", () => {
  const r = resolveTarget(STATE, { modelId: "claude-opus-4-8", channelId: "backup" });
  expect(r).toEqual({ format: "claude", port: 8790 });
});

test("resolveTarget: gemini 模型解析出 gemini 协议", () => {
  const r = resolveTarget(STATE, { modelId: "gemini-2.5-pro", channelId: "primary" });
  expect(r).toEqual({ format: "gemini", port: 8789 });
});

test("resolveTarget: 未知 modelId 抛错", () => {
  expect(() => resolveTarget(STATE, { modelId: "no-such-model", channelId: null }))
    .toThrow(/未知模型/);
});

test("resolveTarget: 未知 channelId 抛错(不静默回退主端口)", () => {
  expect(() => resolveTarget(STATE, { modelId: "grok-4.5", channelId: "no-such-channel" }))
    .toThrow(/未知渠道/);
});

test("resolveTarget: channelId 传空字符串等同不指定渠道 -> 主端口", () => {
  const r = resolveTarget(STATE, { modelId: "grok-4.5", channelId: "" });
  expect(r).toEqual({ format: "openai", port: 8788 });
});
