# Mock 上游（多模型 · 三格式 · 带控制台）

不用真实 API key，给 new-api 提供一个可视化控制的假上游：**多模型档案 + 场景预设 + OpenAI/Claude/Gemini 三种协议 + SQLite 持久化**。

```
浏览器/客户端 ──▶ new-api（真实全流程）──▶ 本 mock（你在网页上控制输出）
                     鉴权/配额/计费/日志/流式 全真     只有 LLM 输出是假的
```

---

## 一键启动

> 端口默认 **8788**，控制台 `http://localhost:8788/`。首次启动自动生成 SQLite 库 `mock.db`（含 3 个示例模型 + 4 个预设）。
> 下面命令都**在本项目根目录（MockUpStream/）里执行**，用相对路径，拉到哪儿都能跑。
>
> ⚠️ **两件事互相独立，别搞混**：
> ① **怎么起 mock**（下面第 1 步，本地 or Docker）；
> ② **new-api 渠道 Base URL 填什么**（第 2 步，取决于 **new-api 在哪跑**，不是 mock 在哪跑）。



### 第 1 步：起 mock（二选一）

**方式 1 · 本地 bun**（宿主机装了 bun）
```bash
bun run server.js
```
自定义端口：Bash `MOCK_PORT=9999 bun run server.js`／PowerShell `$env:MOCK_PORT=9999; bun run server.js`／CMD `set MOCK_PORT=9999 && bun run server.js`

**方式 2 · Docker**（无需本机装 bun）
```bash
docker compose up            # 项目自带 docker-compose.yml
```
或一条 `docker run`（把当前目录挂进容器）：
- Bash/macOS/Linux：`docker run --rm -it -p 8788:8788 -v "$PWD":/app -w /app oven/bun:latest bun run server.js`
- PowerShell：`docker run --rm -it -p 8788:8788 -v ${PWD}:/app -w /app oven/bun:latest bun run server.js`
- CMD：`docker run --rm -it -p 8788:8788 -v %cd%:/app -w /app oven/bun:latest bun run server.js`

### 第 2 步：new-api 渠道 Base URL 填什么

**取决于 new-api（调用方）在哪跑**：

| new-api 在哪 | mock 在哪 | 渠道 Base URL |
|---|---|---|
| 本地 | 本地 | `http://localhost:8788` |
| **Docker** | **本地(宿主机)** | **`http://host.docker.internal:8788`** ← 常见：new-api 用 compose 起、mock 本地 `bun run` |
| Docker | Docker（独立 `docker run`/`compose up`） | `http://host.docker.internal:8788` |
| Docker | Docker（并入 new-api 同一 compose 网络） | `http://mock-upstream:8788`（服务名，最稳） |

> 核心规则：**容器里的 `localhost` 指容器自己**。只要 new-api 在容器里、mock 不在同一个容器网络，就用 `host.docker.internal`（Windows/Mac 的 Docker Desktop 内置该 DNS；Linux 需给 new-api 服务加 `extra_hosts: ["host.docker.internal:host-gateway"]`）。
>
> 验证容器能否连到 mock：`docker exec -it new-api sh -c "wget -qO- http://host.docker.internal:8788/v1/models"`，返回模型列表即通。



---

## 控制台用法

打开 `http://localhost:8788/`：

- **左栏 模型列表**：新建 / 复制 / 删除；点一行进入编辑；进页面自动选中第一个。
- **右栏 编辑器**：改模型名、协议格式、回复内容、输入/输出/缓存 token、延迟、流式块间隔、注入错误码+概率。改完点**保存**（整表 upsert）。
- **预设按钮**（正常基准 / 高缓存命中 / 超长上下文 / 超长输出 / 错误超时）：点一下**一次性填满整表**，仍需点保存写入。
- **预设管理**：可**新建 / 编辑（patch JSON）/ 删除**自定义预设，即时存库。
- **Base URL / endpoint 提示**：直接复制到 new-api 渠道；Docker 下把 `localhost` 换成 `host.docker.internal`。
- **最近请求**：实时表格，看每次调用的模型/格式/流/token/错误。

> 预置了常见模型：`grok-4.5` `deepseek-v4-flash` `qwen3-max` `kimi-k2` `glm-4.6` `mimo-v2.5`（均 openai 格式）、`gemini-2.5-pro`（gemini）、`claude-opus-4-8`（claude）。
> 注：grok/deepseek/qwen/kimi/glm/mimo 本身就是 **OpenAI 兼容格式**，所以 format=openai 是对的；只有 Gemini 和 Claude 用不同协议。新建模型可在「协议格式」下拉里改。

配置写入 SQLite 库 `mock.db`，重启不丢（每次提交即时落盘，抗强杀）。



---

## 发送API

### **Bash: **

**流式**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"测试"}]}'
```

**非流式**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-3.5-turbo","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"测试"}]}'
```



### PowerShell

**流式**

```powershell
curl http://localhost:3000/v1/chat/completions `
  -H "Authorization: Bearer sk-your-api-key" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"gpt-3.5-turbo\",\"messages\":[{\"role\":\"user\",\"content\":\"测试\"}]}"
```

**非流式**

```powershell
curl http://localhost:3000/v1/chat/completions `
  -H "Authorization: Bearer sk-your-api-key" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"gpt-3.5-turbo\",\"stream\":true,\"stream_options\":{\"include_usage\":true},\"messages\":[{\"role\":\"user\",\"content\":\"测试\"}]}"
```



### Windows CMD / DOS 

**流式**

```cmd
curl http://localhost:3000/v1/chat/completions ^
  -H "Authorization: Bearer sk-your-api-key" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"gpt-3.5-turbo\",\"messages\":[{\"role\":\"user\",\"content\":\"测试\"}]}"
```

**非流式**

```cmd
curl http://localhost:3000/v1/chat/completions ^
  -H "Authorization: Bearer sk-your-api-key" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"gpt-3.5-turbo\",\"stream\":true,\"stream_options\":{\"include_usage\":true},\"messages\":[{\"role\":\"user\",\"content\":\"测试\"}]}"
```



---

## APIFox 接入

<p align="left">
    <a href="./APIFox.md">APIFox</a>
<p>



---

## 三种协议 / endpoint

| 格式 | new-api 渠道类型 | endpoint | usage 语义 |
|---|---|---|---|
| openai | OpenAI（含 grok/deepseek/qwen/kimi 等兼容） | `POST /v1/chat/completions` | `prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens` |
| claude | Anthropic / Claude | `POST /v1/messages` | `input_tokens(=prompt−cached−creation) / output_tokens / cache_read_input_tokens / cache_creation_input_tokens` |
| gemini | Gemini | `POST /v1beta/models/{model}:generateContent`（流式 `:streamGenerateContent`） | `usageMetadata.promptTokenCount / candidatesTokenCount / cachedContentTokenCount` |

> **响应格式由请求打到哪个 endpoint 决定**，不是看模型的 format 字段。format 字段只影响面板分组和 `/v1/models` 列表。



---

## 目录结构

```
MockUpStream/
├── server.js            # 入口 + 路由分发
├── store.js             # SQLite(bun:sqlite) 读写 / 模型·预设增删改
├── presets.js           # 4 个内置场景预设
├── usage.js             # 格式无关的 token 计算
├── formats/
│   ├── openai.js
│   ├── claude.js
│   └── gemini.js
├── vendor/alpine.min.js # 本地 Alpine（无联网依赖）
├── panel.html           # 控制台
├── docker-compose.yml   # 独立 Docker 运行（相对挂载）
├── mock.db              # SQLite 持久化（自动生成，可删除以重置；已 gitignore）
└── formats.test.js      # bun test
```

跑测试：`bun test`



---

## 快速自测（不经 new-api，直接打 mock）

```bash
# OpenAI
curl -s http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"grok-4.5","messages":[{"role":"user","content":"hi"}]}'
# Claude
curl -s http://localhost:8788/v1/messages -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus","messages":[{"role":"user","content":"hi"}]}'
# Gemini
curl -s "http://localhost:8788/v1beta/models/gemini-2.5-pro:generateContent" -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
```



---

## 常见问题

- **端口被占用（EADDRINUSE）**：`MOCK_PORT=9999 bun run server.js`，或杀掉占用 8788 的旧进程。
- **想重置全部配置**：删掉 `mock.db` 重启，或调 `POST /__reset`。
- **Docker 下渠道连不上**：Base URL 别用 `localhost`，用 `host.docker.internal:8788` 或 compose 服务名 `mock-upstream:8788`。
- **命令行 curl 传中文预设名失败**：Windows 终端编码问题，与本工具无关；控制台网页（fetch UTF-8）和 new-api（发模型名）都正常。
- **new-api 侧分组 / Tier 路由报错**：那是 new-api 自身的渠道分组或 Tier 映射问题，与本 mock 无关（检查渠道分组是否覆盖令牌所属分组/Tier）。
