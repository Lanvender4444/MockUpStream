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
> **核心两步骤**：
> 
> ① **怎么起 mock**（下面第 1 步，本地 or Docker）；
> 
> ② **new-api 渠道 Base URL 填什么**（第 2 步，取决于 **new-api 在哪跑**，不是 mock 在哪跑）。



### 第 1 步：起 mock（二选一）

**方式 1 · 本地 bun**
```bash
bun run server.js
bun run https                 # 走 HTTPS，需要先跑一次 scripts/gen-cert.sh 生成证书
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

**方式 3 · 现成镜像**（不用 clone 仓库，CI 已自动构建并推到 GHCR）
```bash
docker run --rm -p 8788:8788 ghcr.io/lanvender4444/mockupstream:latest
```

### 第 2 步：new-api 渠道 Base URL 填什么

**取决于 new-api（调用方）在哪跑**：

| new-api 在哪 | mock 在哪 | 渠道 Base URL |
|---|---|---|
| 本地 | 本地 | `http://localhost:8788` |
| **Docker** | **本地(宿主机)** | **`http://host.docker.internal:8788`**  |
| Docker | Docker（独立 `docker run`/`compose up`） | `http://host.docker.internal:8788` |
| Docker | Docker（并入 new-api 同一 compose 网络） | `http://mock-upstream:8788`（服务名，最稳） |

> 核心规则：**容器里的 `localhost` 指容器自己**。只要 new-api 在容器里、mock 不在同一个容器网络，就用 `host.docker.internal`（Windows/Mac 的 Docker Desktop 内置该 DNS；Linux 需给 new-api 服务加 `extra_hosts: ["host.docker.internal:host-gateway"]`）。
>
> 验证容器能否连到 mock：`docker exec -it new-api sh -c "wget -qO- http://host.docker.internal:8788/v1/models"`，返回模型列表即通。

## New-API 界面配置
浏览器打开前端 → 用 root + 首启密码登录：

### 1. 建渠道（Channels）

    类型：OpenAI
    代理 / Base URL：参考上一章节
    密钥：随便填，如 sk-mock
    模型：gpt-3.5-turbo,gpt-4o
    保存后可点「测试」按钮（mock 的 /v1/models 会响应）


### 2. 配模型倍率（Model Ratio / 运营设置）

    确保 配置了对应模型倍率

### 3. 建令牌（Tokens）

    新建 → 复制出 sk-xxx

### 4. 修改 TierGroups

系统设置 → 倍率设置 修改TierGroups
```json
{
  "dev": {"groups": ["default"]},
  "pro": {"groups": ["default", "vip"]},
  "ent": {"groups": ["default", "vip", "svip"]}
}
```


---

## 控制台用法

打开 `http://localhost:8788/`：

- **左栏 模型列表**：新建 / 复制 / 删除；点一行进入编辑；进页面自动选中第一个。
- **右栏 编辑器**：改模型名、协议格式、回复内容、输入/输出/缓存 token、延迟、流式块间隔、注入错误码+概率。改完点**保存**（整表 upsert）。
- **预设按钮**（正常基准 / 高缓存命中 / 超长上下文 / 超长输出 / 错误超时）：点一下**一次性填满整表**，仍需点保存写入。
- **响应延迟**支持两种模式：`fixed`（固定 ms）和 `range`（区间内随机，每次请求重新采样）；`range` 下再选分布——`均匀随机数` 或 `正态分布随机数`（以区间中点为均值，区间的 1/6 为标准差，两端会被夹回区间内，不会溢出）。流式/非流式都吃得到，因为延迟是在两者共同的"发出响应前"那一步生效的。新增了一个内置预设「长延迟」（3000～10000ms，正态分布）。实际采样到的延迟值会记在「Recent Requests」的 Latency 列里。
- **预设管理**：可**新建 / 编辑（patch JSON）/ 删除**自定义预设，即时存库。
- **Model Configuration 表单**下面有个「另存为预设」按钮：把当前模型的行为字段（token/缓存/延迟/错误…，不含模型名和回复内容）直接存成一个新预设，只用输入个名字，不用切到 Presets 标签页重新填一遍。
- **Base URL / endpoint 提示**：直接复制到 new-api 渠道；Docker 下把 `localhost` 换成 `host.docker.internal`。
- **Channels 标签页**：模拟多个上游渠道（各自独立的 Base URL、开关、错误率、额外延迟），详见下面「多渠道模拟」一节。
- **最近请求**：实时表格，看每次调用的模型/格式/流/token/错误。

> 预置了常见模型：`grok-4.5` `deepseek-v4-flash` `qwen3-max` `kimi-k2` `glm-4.6` `mimo-v2.5`（均 openai 格式）、`gemini-2.5-pro`（gemini）、`claude-opus-4-8`（claude）。
> 注：grok/deepseek/qwen/kimi/glm/mimo 本身就是 **OpenAI 兼容格式**，所以 format=openai 是对的；只有 Gemini 和 Claude 用不同协议。新建模型可在「协议格式」下拉里改。

配置写入 SQLite 库 `mock.db`，重启不丢（每次提交即时落盘，抗强杀）。



---

## 发送API

> 此处 [localhost:3000](http://localhost:3000) 是 new-api 本地运行地址。

### Bash: 

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

## 团队合作

别忘了打开防火墙的 8788 端口


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

## HTTPS（可选，更安全）

默认是明文 HTTP —— 本地/纯局域网用没什么问题，但如果给局域网同事甚至公网用，"网络与安全"里设的管理密码是走 `/__auth/login` POST 明文传的，没有 HTTPS 会被同网段的人抓包看到。两种场景，做法不一样：

**局域网/自用：自签证书**
```bash
bash scripts/gen-cert.sh       # 生成证书，SAN 覆盖 localhost + 本机所有局域网 IP
```
然后带着两个环境变量启动：
- Bash：`MOCK_TLS_CERT=certs/cert.pem MOCK_TLS_KEY=certs/key.pem bun run server.js`
- PowerShell：`$env:MOCK_TLS_CERT="certs/cert.pem"; $env:MOCK_TLS_KEY="certs/key.pem"; bun run server.js`

两个环境变量都给了、且文件都存在，才会切到 HTTPS；没给就还是明文 HTTP，不影响现有用法。自签证书首次访问浏览器会报"不安全"，点"继续访问"/"高级 → 继续前往"即可 —— 传输已经加密了，只是没有公共 CA 背书，属于预期行为。`certs/` 已经在 `.gitignore` 和 `.dockerignore` 里，不会被提交或打进镜像。

`gen-cert.sh` 装了 [mkcert](https://github.com/FiloSottile/mkcert) 会优先用它（`winget install FiloSottile.mkcert` 装）：`mkcert -install` 把本地根证书装进系统信任库，之后浏览器访问不会有任何"不安全"警告，比 openssl 自签证书体验好。`bun run https` 默认读 `certs/cert.pem` + `certs/key.pem`，等价于上面那两行手动带环境变量启动。

**公网 + 域名：交给反代**
自签证书不适合真正暴露在公网（浏览器会一直报不可信）。有域名的话，推荐用 Caddy/nginx 之类的反代在前面终止 HTTPS（Caddy 能自动申请/续期 Let's Encrypt 证书），mock 自己留明文 HTTP、只监听在反代能访问到的地方即可。参考仓库里的 [`Caddyfile.example`](./Caddyfile.example)。

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
├── Dockerfile           # 自包含镜像（CI 构建并推到 GHCR，无需挂载）
├── .github/workflows/   # CI(bun test) + Docker 镜像发布
├── tls.js               # HTTPS 证书路径解析(自签证书场景)
├── package.json         # bun run start / bun run https 两个命令别名，没有依赖
├── scripts/gen-cert.sh  # 生成本地自签证书
├── scripts/cli.js       # 命令行增删模型/预设(bun run cli ...)
├── Caddyfile.example    # 公网+域名场景的反代示例(自动 HTTPS)
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

> `Authorization: Bearer sk-xxx` 这个 mock 完全不校验，随便填一个字符串（比如 `sk-mock`）甚至不带都行——鉴权是 new-api 自己做的，跟直接打 mock 没关系。
>
> PowerShell 里 `curl` 默认是 `Invoke-WebRequest` 的别名，`-H` 参数语法跟真 curl 不一样，直接抄上面 Bash 的命令会报参数绑定错误。用 `curl.exe`（Windows 自带的真 curl，显式带 `.exe` 后缀绕开别名）：
> ```powershell
> curl.exe http://localhost:8788/v1/chat/completions `
>   -H "Authorization: Bearer sk-mock" `
>   -H "Content-Type: application/json" `
>   -d "{\"model\":\"gpt-3.5-turbo\",\"messages\":[{\"role\":\"user\",\"content\":\"测试\"}]}"
> ```
> 或者用原生 PowerShell 语法：
> ```powershell
> Invoke-RestMethod -Uri "http://localhost:8788/v1/chat/completions" `
>   -Method Post -Headers @{ Authorization = "Bearer sk-mock" } -ContentType "application/json" `
>   -Body '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"测试"}]}'
> ```
> HTTPS 模式（见上面「HTTPS」一节）把 `http://` 换成 `https://`；自签证书场景 `curl.exe` 加 `-k` 跳过校验，`Invoke-RestMethod` 加 `-SkipCertificateCheck`。



---

## 命令行管理模型/预设（不用开网页）

`scripts/cli.js` 直接读写 `mock.db`（跟 `server.js` 用同一个 `store.js`），不需要服务在跑；服务在跑的时候也能用（SQLite 文件锁保证不会读到写一半的脏数据，但别跟网页控制台同时保存同一个模型）。

```bash
bun run cli add-model my-model --vendor=grok --preset=长延迟   # 新建/更新模型，直接套一个已有预设
bun run cli apply-preset my-model 长延迟                       # 给已有模型套预设
bun run cli add-preset 我的预设 --from=my-model                # 把某个模型当前的行为字段另存为新预设
bun run cli add-preset 我的预设 --latencyMode=range --latencyMin=3000 --latencyMax=9000 --latencyDist=normal  # 或者直接用字段拼一个
bun run cli list-models
bun run cli list-presets
bun run cli delete-model my-model
bun run cli delete-preset 我的预设
```

字段名（`--vendor` `--latencyMode` `--promptTokens` 等等）跟控制台里的字段一一对应，具体列表看 `store.js` 的 `MODEL_DEFAULTS`；`--preset`/`--from` 之外的 `--字段=值` 都会做数字/文本自动转换后直接写进模型或预设。

渠道也有对应命令：
```bash
bun run cli add-channel backup-2 --name="备用渠道 2" --extraLatencyMs=800   # 新建/更新渠道
bun run cli add-channel flaky-2 --errorRate=30                          # 偶发故障
bun run cli add-channel down-2 --enabled=false                          # 模拟这个渠道整个挂了
bun run cli list-channels
bun run cli delete-channel backup-2
```

---

## 多渠道模拟（Channels）

现在这个 mock 只有一个 Base URL，new-api 里配多个渠道时全都只能指向这一个地址，没法测"某个渠道挂了/限流/变慢，new-api 该转移到别的渠道"这类跨渠道逻辑（权重、失败转移、限流降级）。控制台的 **Channels** 标签页可以建任意多个渠道，每个都有自己的 Base URL：

```
http://localhost:8788/ch/<channelId>
```

不加 `/ch/` 前缀的原有请求路径（`http://localhost:8788` 直接打）完全不受影响，行为跟以前一模一样——渠道功能是纯新增的，不用也不影响任何现有用法。

每个渠道能单独控制：
- **Enabled**：关掉后，这个渠道下所有请求（不管打哪个模型）直接返回渠道级错误，模拟"渠道挂了"。
- **Error Rate %**：独立于模型自己的错误注入，按概率让请求失败，模拟"渠道不稳定，偶发故障"。
- **Extra Latency ms**：叠加在模型自身延迟之上，模拟"这个渠道网络更慢"。

首次建库会自动种 3 个示例渠道，直接对应典型的多渠道测试场景：`primary`（主渠道，正常）、`backup`（备用渠道，多 800ms 延迟）、`flaky`（不稳定渠道，30% 错误率）。在 new-api 里把这三个 Base URL 配成同一组的不同渠道（设权重/优先级），就能测权重分流、主渠道故障时是否正确转移到备用渠道、遇到 flaky 渠道时重试逻辑对不对。

「Recent Requests」表格的 Channel 列会标出每次请求实际走的是哪个渠道（没加前缀的直连请求显示 `—`），方便核对测试结果。

---

## 常见问题

- **端口被占用（EADDRINUSE）**：`MOCK_PORT=9999 bun run server.js`，或杀掉占用 8788 的旧进程。
- **想重置全部配置**：删掉 `mock.db` 重启，或调 `POST /__reset`。
- **Docker 下渠道连不上**：Base URL 别用 `localhost`，用 `host.docker.internal:8788` 或 compose 服务名 `mock-upstream:8788`。
- **命令行 curl 传中文预设名失败**：Windows 终端编码问题，与本工具无关；控制台网页（fetch UTF-8）和 new-api（发模型名）都正常。
- **new-api 侧分组 / Tier 路由报错**：那是 new-api 自身的渠道分组或 Tier 映射问题，与本 mock 无关（检查渠道分组是否覆盖令牌所属分组/Tier）。
