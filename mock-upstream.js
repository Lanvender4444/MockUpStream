// mock-upstream.js —— 带 Web 控制台的假 OpenAI 兼容上游
//
// 跑法：  bun run mock-upstream.js          (默认端口 8788, 可用 MOCK_PORT 改)
// 控制台：浏览器打开  http://localhost:8788/
// 上游地址：new-api 渠道 Base URL 填  http://localhost:8788
//          (Docker 下用 http://host.docker.internal:8788 或 compose 服务名)
//
// 特点：所有输出参数（token 数 / 缓存 / 流式分块 / 延迟 / 注入错误）都在网页上实时调，
//       改完立即生效，无需重启。配置存内存，重启回默认。

const PORT = Number(process.env.MOCK_PORT || 8788);

const DEFAULTS = {
  model: "gpt-3.5-turbo",
  content: "这是来自 mock 上游的假回复，用于测试 new-api 全链路计费与日志。",
  promptMode: "auto",          // auto=按输入字符估算 / fixed=用下面固定值
  promptTokens: 100,           // promptMode=fixed 时生效
  completionTokens: 30,        // 输出 token 数
  cacheMode: "ratio",          // ratio=按输入比例 / fixed=固定值
  cacheRatio: 0.5,             // cacheMode=ratio 时, 缓存命中占输入的比例 0~1
  cachedTokens: 0,             // cacheMode=fixed 时的缓存命中 token 数
  cacheCreationTokens: 0,      // Claude 缓存写入 token 数(放进 prompt_tokens_details)
  latencyMs: 0,                // 首字节前的人为延迟(测超时/慢响应)
  chunkDelayMs: 40,            // 流式每块之间的间隔(测打字机/流式)
  errorStatus: 0,              // 注入错误状态码: 0=不注入 / 400 401 403 429 500 503
  errorRate: 0,                // 错误触发概率 0~100 (%)
  errorMessage: "mock injected error",
};

let cfg = { ...DEFAULTS };
const recent = [];           // 最近请求记录(给控制台看)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function countPromptTokens(messages = []) {
  const text = messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" ");
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildUsage(messages) {
  const promptTokens =
    cfg.promptMode === "fixed" ? Number(cfg.promptTokens) : countPromptTokens(messages);
  let cachedTokens =
    cfg.cacheMode === "ratio"
      ? Math.floor(promptTokens * Number(cfg.cacheRatio))
      : Number(cfg.cachedTokens);
  cachedTokens = Math.min(Math.max(cachedTokens, 0), promptTokens); // 缓存夹在 0~输入 之间
  const completionTokens = Number(cfg.completionTokens);
  const details = { cached_tokens: cachedTokens };
  if (Number(cfg.cacheCreationTokens) > 0)
    details.cache_creation_tokens = Number(cfg.cacheCreationTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: details,
  };
}

function record(entry) {
  recent.unshift({ t: new Date().toISOString().slice(11, 19), ...entry });
  if (recent.length > 25) recent.pop();
}

function coerce(input) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in input)) continue;
    const def = DEFAULTS[k];
    out[k] = typeof def === "number" ? Number(input[k]) : String(input[k]);
  }
  return out;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "X-Mock-Upstream": "1" },
  });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---------- 控制台前端 ----------
    if (p === "/" || p === "/index.html") {
      return new Response(Bun.file(import.meta.dir + "/panel.html"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (p === "/__config" && req.method === "GET") return json({ cfg, defaults: DEFAULTS });
    if (p === "/__config" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      cfg = { ...cfg, ...coerce(body) };
      return json({ ok: true, cfg });
    }
    if (p === "/__reset" && req.method === "POST") {
      cfg = { ...DEFAULTS };
      return json({ ok: true, cfg });
    }
    if (p === "/__stats") return json({ recent });

    // ---------- 假上游 API ----------
    if (p === "/v1/models") {
      return json({
        object: "list",
        data: [
          { id: cfg.model, object: "model", owned_by: "mock" },
          { id: "gpt-4o", object: "model", owned_by: "mock" },
        ],
      });
    }

    if (p === "/v1/chat/completions" && req.method === "POST") {
      const reqBody = await req.json().catch(() => ({}));
      const model = reqBody.model || cfg.model;
      const streaming = !!reqBody.stream;

      // 人为延迟
      if (Number(cfg.latencyMs) > 0) await sleep(Number(cfg.latencyMs));

      // 注入错误
      if (Number(cfg.errorStatus) > 0 && Math.random() * 100 < Number(cfg.errorRate)) {
        record({ model, stream: streaming, result: `ERR ${cfg.errorStatus}` });
        return json(
          { error: { message: cfg.errorMessage, type: "mock_error", code: String(cfg.errorStatus) } },
          Number(cfg.errorStatus)
        );
      }

      const usage = buildUsage(reqBody.messages);
      const id = "chatcmpl-mock-0001";
      const created = 1700000000;
      record({
        model,
        stream: streaming,
        result: `p${usage.prompt_tokens}/c${usage.completion_tokens}/cache${usage.prompt_tokens_details.cached_tokens}`,
      });

      // 流式
      if (streaming) {
        const enc = new TextEncoder();
        const chunkDelay = Number(cfg.chunkDelayMs);
        const content = cfg.content;
        const stream = new ReadableStream({
          async start(controller) {
            const send = (o) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            send({ id, object: "chat.completion.chunk", created, model,
                   choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            for (const ch of content.match(/.{1,8}/gs) || [content]) {
              if (chunkDelay > 0) await sleep(chunkDelay);
              send({ id, object: "chat.completion.chunk", created, model,
                     choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
            }
            send({ id, object: "chat.completion.chunk", created, model,
                   choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            send({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                     "Connection": "keep-alive", "X-Mock-Upstream": "1" },
        });
      }

      // 非流式
      return json({
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: cfg.content }, finish_reason: "stop" }],
        usage,
      });
    }

    return new Response("mock upstream: not found " + p, { status: 404 });
  },
});

console.log(`mock upstream listening on http://localhost:${PORT}`);
console.log(`→ 控制台:  http://localhost:${PORT}/`);
console.log(`→ 渠道 Base URL 填:  http://localhost:${PORT}   (Docker: http://host.docker.internal:${PORT})`);
