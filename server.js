// server.js —— 带 Web 控制台的多模型/多格式假上游。入口。
//
// 跑法：  bun run server.js            (默认端口 8788, 可用 MOCK_PORT 改)
// 控制台：http://localhost:8788/
// 上游 Base URL：
//   OpenAI  渠道 -> http://localhost:8788           (打 /v1/chat/completions)
//   Claude  渠道 -> http://localhost:8788           (打 /v1/messages)
//   Gemini  渠道 -> http://localhost:8788           (打 /v1beta/models/{m}:generateContent)
//   Docker 下把 localhost 换成 host.docker.internal 或 compose 服务名。

import * as store from "./store.js";
import { shouldInjectError } from "./usage.js";
import * as openai from "./formats/openai.js";
import * as claude from "./formats/claude.js";
import * as gemini from "./formats/gemini.js";

const PORT = Number(process.env.MOCK_PORT || 8788);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recent = [];
function record(e) { recent.unshift({ t: new Date().toISOString().slice(11, 19), ...e }); if (recent.length > 25) recent.pop(); }

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Mock-Upstream": "1" } });

await store.load();

// 通用: 处理一次上游请求(某格式)
async function handleUpstream(fmtName, fmt, req, url) {
  const body = await req.json().catch(() => ({}));
  const parsed = fmt.parseRequest(body, url);
  const cfg = store.resolveModel(parsed.model, fmtName);

  if (Number(cfg.latencyMs) > 0) await sleep(Number(cfg.latencyMs));

  // 注入错误
  if (shouldInjectError(cfg)) {
    record({ model: parsed.model || cfg.id, format: fmtName, stream: parsed.stream, result: `ERR ${cfg.errorStatus}` });
    return json(fmt.buildError(cfg), Number(cfg.errorStatus));
  }

  const modelName = parsed.model || cfg.id;

  // 非流式
  if (!parsed.stream) {
    const resp = fmt.buildResponse(cfg, parsed.messages, modelName);
    record({ model: modelName, format: fmtName, stream: false, result: usageTag(fmtName, resp) });
    return json(resp);
  }

  // 流式 (SSE)
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (line) => controller.enqueue(enc.encode(line));
      if (fmtName === "claude") {
        // Claude: 具名事件  event: X\n data: {...}\n\n
        await fmt.buildStream(cfg, parsed.messages, modelName, (event, data) => {
          push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }, sleep);
      } else {
        // openai / gemini: data: {...}\n\n ; openai 末尾 send("[DONE]")
        await fmt.buildStream(cfg, parsed.messages, modelName, (obj) => {
          if (obj === "[DONE]") push("data: [DONE]\n\n");
          else push(`data: ${JSON.stringify(obj)}\n\n`);
        }, sleep);
      }
      controller.close();
    },
  });
  record({ model: modelName, format: fmtName, stream: true, result: "stream" });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Mock-Upstream": "1" },
  });
}

function usageTag(fmtName, resp) {
  if (fmtName === "openai") { const u = resp.usage; return `p${u.prompt_tokens}/c${u.completion_tokens}/cache${u.prompt_tokens_details.cached_tokens}`; }
  if (fmtName === "claude") { const u = resp.usage; return `in${u.input_tokens}/out${u.output_tokens}/read${u.cache_read_input_tokens}`; }
  const u = resp.usageMetadata; return `p${u.promptTokenCount}/c${u.candidatesTokenCount}/cache${u.cachedContentTokenCount || 0}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---------- 控制台前端 ----------
    if (p === "/" || p === "/index.html")
      return new Response(Bun.file(import.meta.dir + "/panel.html"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/vendor/alpine.min.js")
      return new Response(Bun.file(import.meta.dir + "/vendor/alpine.min.js"), { headers: { "Content-Type": "text/javascript" } });

    // ---------- 管理 API ----------
    if (p === "/__state") return json({ ...store.getState(), port: PORT });
    if (p === "/__stats") return json({ recent });
    if (p === "/__models" && req.method === "POST") {
      const m = await req.json().catch(() => ({}));
      return json({ ok: true, model: await store.upsertModel(m) });
    }
    if (p.startsWith("/__models/") && req.method === "DELETE") {
      await store.deleteModel(decodeURIComponent(p.slice("/__models/".length)));
      return json({ ok: true });
    }
    if (p.match(/^\/__models\/.+\/apply-preset$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[2]);
      const { name } = await req.json().catch(() => ({}));
      const model = await store.applyPreset(id, name);
      return model ? json({ ok: true, model }) : json({ error: "model or preset not found" }, 404);
    }
    if (p === "/__reset" && req.method === "POST") return json({ ok: true, state: await store.reset() });

    // ---------- 上游 API ----------
    if (p === "/v1/models") {
      const data = store.getState().models
        .filter((m) => m.format === "openai")
        .map((m) => ({ id: m.id, object: "model", owned_by: "mock" }));
      if (!data.length) data.push({ id: "gpt-3.5-turbo", object: "model", owned_by: "mock" });
      return json({ object: "list", data });
    }
    if (p === "/v1/chat/completions" && req.method === "POST") return handleUpstream("openai", openai, req, url);
    if (p === "/v1/messages" && req.method === "POST") return handleUpstream("claude", claude, req, url);
    if (p.match(/\/models\/[^:]+:(generateContent|streamGenerateContent)/) && req.method === "POST")
      return handleUpstream("gemini", gemini, req, url);

    return new Response("mock upstream: not found " + p, { status: 404 });
  },
  error(e) {
    if (e.code === "EADDRINUSE")
      console.error(`\n端口 ${PORT} 被占用。改端口: MOCK_PORT=9999 bun run server.js  或先杀掉占用进程。\n`);
    throw e;
  },
});

console.log(`mock upstream listening on http://localhost:${PORT}`);
console.log(`→ 控制台:      http://localhost:${PORT}/`);
console.log(`→ 渠道 Base URL: http://localhost:${PORT}   (Docker: http://host.docker.internal:${PORT})`);
console.log(`  OpenAI /v1/chat/completions · Claude /v1/messages · Gemini /v1beta/models/{m}:generateContent`);
