// server.js —— 带 Web 控制台的多模型/多格式假上游。入口。
//
// 跑法：  bun run server.js            (默认端口 8788, 可用 MOCK_PORT 改)
// 控制台：http://localhost:8788/
// 上游 Base URL：
//   OpenAI  渠道 -> http://localhost:8788           (打 /v1/chat/completions)
//   Claude  渠道 -> http://localhost:8788           (打 /v1/messages)
//   Gemini  渠道 -> http://localhost:8788           (打 /v1beta/models/{m}:generateContent)
//   Docker 下把 localhost 换成 host.docker.internal 或 compose 服务名。
//
// HTTPS：给 MOCK_TLS_CERT / MOCK_TLS_KEY 两个环境变量(证书/私钥文件路径)即可原生起 HTTPS，见 tls.js。
// 局域网自用：bash scripts/gen-cert.sh 生成自签证书。公网+域名：推荐 Caddy/nginx 反代终止 HTTPS，
// mock 自己留 HTTP 就行，见 Caddyfile.example 和 README「HTTPS」一节。
//
// 局域网/公网访问 + 控制台身份验证：
//   面板"网络与安全"区块可设置管理密码 + 信任 IP 正则，落库 mock.db（重启不丢，跟模型/预设一样）。
//   未设置密码时，控制台和 /v1/* 一样保持完全开放（不影响现有本地用法）。

import { networkInterfaces } from "os";
import * as store from "./store.js";
import * as auth from "./auth.js";
import { resolveTls } from "./tls.js";
import { shouldInjectError, resolveLatencyMs, shouldChannelFail } from "./usage.js";
import * as openai from "./formats/openai.js";
import * as claude from "./formats/claude.js";
import * as gemini from "./formats/gemini.js";
import * as testRunner from "./testRunner.js";

const PORT = Number(process.env.MOCK_PORT || 8788);
const TLS = resolveTls();
const PROTOCOL = TLS ? "https" : "http";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recent = [];
let recSeq = 0; // 单调自增游标：给每条记录一个稳定 id，测试用它框出"本次跑批期间产生的记录"。
function record(e) { recent.unshift({ _id: recSeq++, t: new Date().toISOString().slice(11, 19), ...e }); if (recent.length > 1000) recent.pop(); }

const json = (obj, status = 200, extraHeaders) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Mock-Upstream": "1", ...(extraHeaders || {}) } });

await store.load();

function lanIps() {
  const nets = networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function loginPageHtml() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Log In · mockupstream</title>
<style>
  @font-face { font-family:"JetBrains Mono"; src:url("/vendor/jetbrains-mono/JetBrainsMono-Regular.woff2") format("woff2"); font-weight:400; font-style:normal; font-display:swap; }
  @font-face { font-family:"JetBrains Mono"; src:url("/vendor/jetbrains-mono/JetBrainsMono-Medium.woff2") format("woff2"); font-weight:500; font-style:normal; font-display:swap; }
  @font-face { font-family:"JetBrains Mono"; src:url("/vendor/jetbrains-mono/JetBrainsMono-SemiBold.woff2") format("woff2"); font-weight:600; font-style:normal; font-display:swap; }
  :root { --bg:#1e1f22; --panel:#2b2d30; --border:#393b40; --fg:#dfe1e5; --mut:#8b8f97; --accent:#3574f0; --err:#db5c5c; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--fg);
         font-family:"JetBrains Mono",ui-monospace,"Cascadia Code","SFMono-Regular",Consolas,monospace; font-size:12.5px; }
  form { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:0; width:340px; box-shadow:0 8px 32px rgba(0,0,0,.4); }
  .titlebar { padding:11px 16px; border-bottom:1px solid var(--border); color:var(--fg); font-size:12px; font-weight:600; }
  .body { padding:20px 20px 22px; }
  .sub { color:var(--mut); font-size:11.5px; margin:0 0 16px; }
  label { display:block; color:var(--mut); font-size:11px; margin-bottom:6px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
  input { width:100%; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:5px;
          padding:8px 10px; font:12.5px "JetBrains Mono",ui-monospace,Consolas,monospace; margin-bottom:6px; }
  input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(53,116,240,.14); }
  .hint { color:var(--mut); font-size:11px; margin:0 0 16px; line-height:1.5; }
  button { width:100%; background:var(--accent); border:1px solid var(--accent); color:#fff; font-weight:500; padding:8px;
           border-radius:5px; cursor:pointer; font-family:inherit; font-size:12.5px; }
  button:hover { background:#4682f5; }
  .err { color:var(--err); font-size:12px; min-height:16px; margin:0 0 10px; }
</style></head>
<body>
<form id="f">
  <div class="titlebar">mockupstream</div>
  <div class="body">
    <p class="sub">控制台已启用密码保护</p>
    <div class="err" id="err"></div>
    <label for="pw">Password</label>
    <input type="password" id="pw" placeholder="••••••••" autocomplete="off" autofocus />
    <p class="hint">密码只经服务端 bcrypt 校验一次性传输，不写入 localStorage / Cookie 明文，浏览器也不会缓存这个值。</p>
    <button type="submit">Log In</button>
  </div>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const r = await fetch("/__auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }) });
  if (r.ok) { location.href = "/"; return; }
  if (r.status === 429) { const d = await r.json(); err.textContent = "失败次数过多，" + Math.ceil(d.retryAfterMs / 60000) + " 分钟后再试"; return; }
  err.textContent = "密码错误";
  document.getElementById("pw").value = "";
});
</script>
</body></html>`;
}

// 通用: 处理一次上游请求(某格式)。channel 为 null 表示走的是主端口的直连请求(不经过任何渠道)。
async function handleUpstream(fmtName, fmt, req, url, channel) {
  const body = await req.json().catch(() => ({}));
  const parsed = fmt.parseRequest(body, url);

  const channelLabel = channel ? `${channel.name} :${channel.port}` : null;

  // 渠道级门禁(渠道被关掉/偶发故障): 直接失败, 不等模型自己的延迟——渠道都连不上, 没有"先等会再失败"这回事。
  if (shouldChannelFail(channel)) {
    const s = Number(channel.errorStatus) || 503;
    record({ model: parsed.model || "(unknown)", format: fmtName, stream: parsed.stream, result: `ERR ${s}(channel)`, channel: channelLabel });
    return json(fmt.buildError({ errorMessage: channel.errorMessage, errorStatus: s }), s);
  }

  const cfg = store.resolveModel(parsed.model, fmtName, channel ? channel.id : null);

  const latencyMs = resolveLatencyMs(cfg) + (channel ? Number(channel.extraLatencyMs) || 0 : 0);
  if (latencyMs > 0) await sleep(latencyMs);

  // 注入错误
  if (shouldInjectError(cfg)) {
    record({ model: parsed.model || cfg.id, format: fmtName, stream: parsed.stream, result: `ERR ${cfg.errorStatus}`, latencyMs, channel: channelLabel });
    return json(fmt.buildError(cfg), Number(cfg.errorStatus));
  }

  const modelName = parsed.model || cfg.id;

  // 非流式
  if (!parsed.stream) {
    const resp = fmt.buildResponse(cfg, parsed.messages, modelName);
    record({ model: modelName, format: fmtName, stream: false, result: usageTag(fmtName, resp), latencyMs, channel: channelLabel });
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
  record({ model: modelName, format: fmtName, stream: true, result: "stream", latencyMs, channel: channelLabel });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Mock-Upstream": "1" },
  });
}

function usageTag(fmtName, resp) {
  if (fmtName === "openai") { const u = resp.usage; return `p${u.prompt_tokens}/c${u.completion_tokens}/cache${u.prompt_tokens_details.cached_tokens}`; }
  if (fmtName === "claude") { const u = resp.usage; return `in${u.input_tokens}/out${u.output_tokens}/read${u.cache_read_input_tokens}`; }
  const u = resp.usageMetadata; return `p${u.promptTokenCount}/c${u.candidatesTokenCount}/cache${u.cachedContentTokenCount || 0}`;
}

// 上游三种协议的路由表，主端口(channel=null)和每个渠道自己的独立端口都复用这一份。
// 返回 Response 表示命中了；返回 null 表示这条路径不归这层管，调用方自己接着 404。
async function routeUpstream(p, req, url, channel) {
  if (p === "/v1/models") {
    if (shouldChannelFail(channel)) { const s = Number(channel.errorStatus) || 503; return json({ error: { message: channel.errorMessage, type: "channel_unavailable" } }, s); }
    const data = store.getState().models
      .filter((m) => m.format === "openai")
      .map((m) => ({ id: m.id, object: "model", owned_by: "mock" }));
    if (!data.length) data.push({ id: "gpt-3.5-turbo", object: "model", owned_by: "mock" });
    return json({ object: "list", data });
  }
  if (p === "/v1/chat/completions" && req.method === "POST") return handleUpstream("openai", openai, req, url, channel);
  if (p === "/v1/messages" && req.method === "POST") return handleUpstream("claude", claude, req, url, channel);
  if (p.match(/\/models\/[^:]+:(generateContent|streamGenerateContent)/) && req.method === "POST")
    return handleUpstream("gemini", gemini, req, url, channel);
  return null;
}

// ---------- 每个渠道一个独立端口，动态起停(改端口/新建/删除都不用重启主进程) ----------
const channelListeners = new Map(); // channelId -> Bun.serve() 实例

function startChannelListener(channel) {
  const existing = channelListeners.get(channel.id);
  if (existing) {
    if (existing.port === channel.port) return; // 端口没变, 现成的接着用
    try { existing.stop(); } catch {}
    channelListeners.delete(channel.id);
  }
  try {
    const srv = Bun.serve({
      port: channel.port,
      ...(TLS ? { tls: { cert: Bun.file(TLS.certPath), key: Bun.file(TLS.keyPath) } } : {}),
      async fetch(req) {
        const url = new URL(req.url);
        // 实时查一次渠道(不是闭包里存的那份快照)：enabled/errorRate 这些字段改了立刻生效，不用重启监听。
        const live = store.getChannel(channel.id);
        if (!live) return new Response("mock upstream: channel removed", { status: 404 });
        const resp = await routeUpstream(url.pathname, req, url, live);
        return resp || new Response(`mock upstream(渠道 ${live.id}): not found ` + url.pathname, { status: 404 });
      },
    });
    channelListeners.set(channel.id, srv);
    return true;
  } catch (e) {
    console.error(`  渠道「${channel.name}」端口 ${channel.port} 启动失败(可能被占用): ${e.message}`);
    return false;
  }
}

function stopChannelListener(channelId) {
  const existing = channelListeners.get(channelId);
  if (existing) { try { existing.stop(); } catch {} channelListeners.delete(channelId); }
}

Bun.serve({
  port: PORT,
  ...(TLS ? { tls: { cert: Bun.file(TLS.certPath), key: Bun.file(TLS.keyPath) } } : {}),
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---------- 身份验证网关：控制台页面 + 全部 /__* 管理接口 ----------
    const authExempt = p === "/__auth/login" || p === "/__auth/status" || p.startsWith("/vendor/");
    const authGated = !authExempt && (p === "/" || p === "/index.html" || p.startsWith("/__"));
    if (authGated) {
      const access = auth.checkAccess(req, server, store.getAuthConfig());
      if (!access.allowed) {
        if (p === "/" || p === "/index.html")
          return new Response(loginPageHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        return json({ error: "unauthorized" }, 401);
      }
    }

    // ---------- 认证相关路由 ----------
    if (p === "/__auth/status" && req.method === "GET") {
      const cfg = store.getAuthConfig();
      return json({
        passwordSet: !!cfg.passwordHash,
        trustedByIp: cfg.passwordHash ? auth.isTrustedIp(auth.getClientIp(req, server), cfg) : true,
        authenticated: auth.hasValidSession(req),
        lan: cfg.lan,
        public: cfg.public,
      });
    }
    if (p === "/__auth/login" && req.method === "POST") {
      const ip = auth.getClientIp(req, server);
      const remain = auth.isLocked(ip);
      if (remain > 0) return json({ error: "locked", retryAfterMs: remain }, 429);
      const { password } = await req.json().catch(() => ({}));
      const cfg = store.getAuthConfig();
      const ok = await auth.verifyPassword(password || "", cfg.passwordHash);
      if (!ok) { auth.recordFailure(ip); return json({ error: "bad password" }, 401); }
      auth.recordSuccess(ip);
      const token = auth.createSession();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": auth.sessionCookieHeader(token, !!TLS) },
      });
    }
    if (p === "/__auth/logout" && req.method === "POST") {
      auth.destroySession(req);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": auth.clearSessionCookieHeader(!!TLS) },
      });
    }
    if (p === "/__auth/config" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const patch = {};
      if (body.password) patch.passwordHash = await auth.hashPassword(body.password);
      if (body.lan && typeof body.lan === "object") {
        patch.lan = {};
        if (auth.TRUST_MODES.includes(body.lan.mode)) patch.lan.mode = body.lan.mode;
        if (typeof body.lan.list === "string") patch.lan.list = body.lan.list.trim() || null;
      }
      if (body.public && typeof body.public === "object") {
        patch.public = {};
        if (auth.TRUST_MODES.includes(body.public.mode)) patch.public.mode = body.public.mode;
        if (typeof body.public.list === "string") patch.public.list = body.public.list.trim() || null;
      }
      const next = store.setAuthConfig(patch);
      return json({ ok: true, passwordSet: !!next.passwordHash, lan: next.lan, public: next.public });
    }

    // ---------- 控制台前端 ----------
    if (p === "/" || p === "/index.html")
      return new Response(Bun.file(import.meta.dir + "/panel.html"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p.startsWith("/vendor/")) {
      const rel = p.slice("/vendor/".length);
      if (rel.includes("..")) return new Response("forbidden", { status: 403 });
      const ext = rel.split(".").pop();
      const type = { js: "text/javascript", woff2: "font/woff2", txt: "text/plain" }[ext] || "application/octet-stream";
      const file = Bun.file(import.meta.dir + "/vendor/" + rel);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "Content-Type": type } });
    }

    // ---------- 管理 API ----------
    if (p === "/__state") return json({ ...store.getState(), port: PORT, lanIps: lanIps() });
    if (p === "/__stats") return json({ recent });
    if (p === "/__models" && req.method === "POST") {
      const m = await req.json().catch(() => ({}));
      return json({ ok: true, model: await store.upsertModel(m) });
    }
    if (p.startsWith("/__models/") && req.method === "DELETE") {
      await store.deleteModel(decodeURIComponent(p.slice("/__models/".length)));
      return json({ ok: true });
    }
    if (p === "/__configs" && req.method === "POST") {
      const c = await req.json().catch(() => ({}));
      return json({ ok: true, config: await store.upsertConfig(c) });
    }
    if (p.startsWith("/__configs/") && req.method === "DELETE") {
      await store.deleteConfig(decodeURIComponent(p.slice("/__configs/".length)));
      return json({ ok: true });
    }
    if (p.match(/^\/__configs\/.+\/apply-preset$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[2]);
      const { name } = await req.json().catch(() => ({}));
      const config = await store.applyPreset(id, name);
      return config ? json({ ok: true, config }) : json({ error: "configuration or preset not found" }, 404);
    }
    if (p === "/__presets" && req.method === "POST") {
      const { name, patch } = await req.json().catch(() => ({}));
      const pr = await store.upsertPreset(name, patch);
      return pr ? json({ ok: true, preset: pr }) : json({ error: "preset name required" }, 400);
    }
    if (p.startsWith("/__presets/") && req.method === "DELETE") {
      await store.deletePreset(decodeURIComponent(p.slice("/__presets/".length)));
      return json({ ok: true });
    }
    if (p === "/__channels" && req.method === "POST") {
      const c = await req.json().catch(() => ({}));
      if (c.port != null && Number(c.port) === PORT)
        return json({ error: `端口 ${PORT} 是主服务自己在用的，换一个` }, 400);
      let saved;
      try {
        saved = await store.upsertChannel(c);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
      const ok = startChannelListener(saved);
      return json({ ok: true, channel: saved, listening: ok });
    }
    if (p.startsWith("/__channels/") && req.method === "DELETE") {
      const id = decodeURIComponent(p.slice("/__channels/".length));
      stopChannelListener(id);
      await store.deleteChannel(id);
      return json({ ok: true });
    }
    if (p === "/__reset" && req.method === "POST") {
      for (const id of [...channelListeners.keys()]) stopChannelListener(id);
      const state = await store.reset();
      for (const channel of state.channels) startChannelListener(channel);
      return json({ ok: true, state });
    }

    // ---------- 测试配置 CRUD ----------
    if (p === "/__test-configs" && req.method === "GET") {
      return json(store.getTestConfigs());
    }
    if (p === "/__test-configs" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if ("password" in body) {
        if (body.password) body.passwordHash = await auth.hashPassword(body.password);
        else body.passwordHash = "";
        delete body.password;
      }
      const cfg = await store.upsertTestConfig(body);
      return json({ ok: true, config: cfg });
    }
    if (p.startsWith("/__test-configs/") && req.method === "DELETE") {
      await store.deleteTestConfig(decodeURIComponent(p.slice("/__test-configs/".length)));
      return json({ ok: true });
    }
    if (p === "/__test-unlock" && req.method === "POST") {
      const { configId, password } = await req.json().catch(() => ({}));
      const cfg = store.getTestConfig(configId);
      if (!cfg) return json({ error: "not found" }, 404);
      if (!cfg.hasPassword) return json(store.getTestResult(configId) || { summary: null, requests: [] });
      const ok = await auth.verifyPassword(password || "", cfg._passwordHash);
      if (!ok) return json({ error: "密码错误" }, 401);
      return json(store.getTestResult(configId) || { summary: null, requests: [] });
    }

    if (p === "/__test/run" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const count = Number(b.count);
      const concurrency = Number(b.concurrency);

      const sse = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const push = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));

          if (!Number.isInteger(count) || count < 1 || count > 1000) {
            push({ type: "error", message: "条数(count)必须是 1-1000 的整数" });
            return controller.close();
          }
          if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
            push({ type: "error", message: "并发数(concurrency)必须是 1-50 的整数" });
            return controller.close();
          }

          const targetUrl = (b.targetUrl || "").replace(/\/+$/, "");
          if (!targetUrl) {
            push({ type: "error", message: "请填写目标地址(targetUrl)" });
            return controller.close();
          }

          try {
            const captureBody = count === 1;
            // 逐条明细里的"渠道"要跟 Recent Requests 对齐:
            // 先按显式选的 channelId; 没选就按 targetUrl 的端口反查命中的渠道
            // (直连主端口 = 无渠道, 保持空, 前端显示 "-", 跟 Recent 的直连一致)。
            let channelLabel = "";
            if (b.channelId) {
              const ch = store.getChannel(b.channelId);
              if (ch) channelLabel = `${ch.name} :${ch.port}`;
            }
            if (!channelLabel) {
              try {
                const tPort = Number(new URL(targetUrl).port);
                const ch = store.getState().channels.find((c) => Number(c.port) === tPort);
                if (ch) channelLabel = `${ch.name} :${ch.port}`;
              } catch {}
            }
            const startSeq = recSeq; // 记录本次跑批开始时的游标

            // 逐条明细(实时 + 最终)全部以 Recent Requests 那一份服务端记录为准，字段/格式完全一致。
            // 每有请求完成，就把本次跑批期间新产生的记录按顺序推给前端(与最终结果同源同值，
            // 不会出现"跑的时候一个样、结束又跳成另一个样")。
            let liveIdx = 0;
            let pushedUpTo = startSeq;
            const rowFromRecord = (r, index) => ({
              index,
              ok: !String(r.result).startsWith("ERR"),
              status: r.result,
              latencyMs: r.latencyMs ?? null,
              channel: r.channel || "",
              format: r.format,
              model: r.model,
              stream: !!r.stream,
            });
            const drainRecords = () => {
              const fresh = recent.filter((r) => r._id >= pushedUpTo).sort((a, b2) => a._id - b2._id);
              for (const r of fresh) {
                push({ type: "progress", ...rowFromRecord(r, liveIdx++) });
                pushedUpTo = r._id + 1;
              }
            };

            const { summary, requests } = await testRunner.runTest(
              {
                baseUrl: targetUrl,
                format: b.format || "openai",
                model: b.model,
                token: b.apiKey || "",
                prompt: b.prompt || "",
                stream: !!b.stream,
                count,
                concurrency,
                captureBody,
                channel: channelLabel,
              },
              // testRunner 的 progress 只当"有一条完成了"的触发器，去捞对应的权威记录；
              // done/error 原样透传。
              (evt) => {
                if (evt.type === "progress") drainRecords();
                else if (evt.type === "done") { drainRecords(); push(evt); }
                else push(evt);
              }
            );
            drainRecords(); // 收尾，捞掉最后可能晚到的记录

            // 最终再按完整时间窗重排一次(index 连续、无遗漏)，替换实时结果。
            const recs = recent
              .filter((r) => r._id >= startSeq)
              .sort((a, b2) => a._id - b2._id);
            let detail = requests;
            if (recs.length) {
              detail = recs.map((r, i) => rowFromRecord(r, i));
              push({ type: "detail", requests: detail });
            }
            if (b.configId) {
              store.setTestResult(b.configId, summary, detail);
            }
          } catch (e) {
            push({ type: "error", message: e.message });
          }
          controller.close();
        },
      });

      return new Response(sse, { headers: { "Content-Type": "application/x-ndjson" } });
    }

    // ---------- 上游 API(不带渠道，直连默认行为——渠道专属的走各自独立端口，见文件末尾) ----------
    const upstreamResp = await routeUpstream(p, req, url, null);
    if (upstreamResp) return upstreamResp;

    return new Response("mock upstream: not found " + p, { status: 404 });
  },
  error(e) {
    if (e.code === "EADDRINUSE")
      console.error(`\n端口 ${PORT} 被占用。改端口: MOCK_PORT=9999 bun run server.js  或先杀掉占用进程。\n`);
    throw e;
  },
});

console.log(`mock upstream listening on ${PROTOCOL}://localhost:${PORT}`);
console.log(`→ 控制台:      ${PROTOCOL}://localhost:${PORT}/`);
console.log(`→ 渠道 Base URL: ${PROTOCOL}://localhost:${PORT}   (Docker: ${PROTOCOL}://host.docker.internal:${PORT})`);
console.log(`  OpenAI /v1/chat/completions · Claude /v1/messages · Gemini /v1beta/models/{m}:generateContent`);
if (TLS) console.log(`  HTTPS 已启用(证书: ${TLS.certPath})。自签证书首次访问浏览器会报不可信，点"继续访问"即可；公网+域名场景建议改用 Caddy/nginx 反代，见 README。`);
if (!store.getAuthConfig().passwordHash) {
  console.log(`  提醒: 控制台尚未设置密码，谁都能访问和修改配置。要给局域网/公网同事用之前，去面板"网络与安全"设一个。`);
}

// ---------- 每个渠道一个独立端口 ----------
// 不用路径前缀(/ch/<id>)：很多 OpenAI 兼容客户端拼 URL 时用"前导斜杠"相对路径解析(new URL("/v1/...", base))，
// 会把 base 自带的路径整段吃掉退回裸 host:port——独立端口跟主端口结构完全一样，没有路径可丢，对任何客户端零风险。
// 渠道专属端口只服务 /v1/* 这几条上游路由，不服务控制台/管理接口(那些是主端口的事)。
// 某个渠道的端口被占用不该拖累主服务和其它渠道，startChannelListener() 内部自己 try/catch，失败了打日志继续。
const seededChannels = store.getState().channels;
if (seededChannels.length) {
  console.log(`  模拟多渠道(在控制台 Channels 标签页管理，可增删/开关/调错误率延迟/改端口，改了立刻生效不用重启)：`);
  for (const channel of seededChannels) {
    if (startChannelListener(channel)) console.log(`    ${channel.name.padEnd(14)} ${PROTOCOL}://localhost:${channel.port}`);
  }
}

