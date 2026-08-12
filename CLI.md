# 命令行操作手册（CLI Reference）

这份文档汇总了这个项目里**所有能用命令行完成的操作**——启动服务、管理模型/预设/渠道、跑测试、直接打 mock 自测、打包部署到云服务器、云服务器防火墙放行。按操作类型分节，每节给出确切命令 + 参数含义 + 例子。

不涉及网页控制台怎么点——那部分见 [README「控制台用法」](./README.md#控制台用法)。

---

## 目录

1. [启动服务](#1-启动服务)
2. [模型 / 配置 / 预设 / 渠道管理（scripts/cli.js）](#2-模型--配置--预设--渠道管理scriptsclijs)
3. [跑测试套件](#3-跑测试套件)
4. [直接打 mock 自测（不经 new-api）](#4-直接打-mock-自测不经-new-api)
5. [打 new-api（走完整链路）](#5-打-new-api走完整链路)
6. [Docker](#6-docker)
7. [打包部署到云服务器](#7-打包部署到云服务器)
8. [云服务器防火墙一键放行](#8-云服务器防火墙一键放行)
9. [测试工具（scripts/test-helper.js）](#9-测试工具scriptstest-helperjs)
10. [环境变量总表](#10-环境变量总表)

---

## 1. 启动服务

```bash
bun run server.js          # 等价于 bun run start；默认端口 8788
bun run start               # package.json 里的别名，跟上面完全一样
MOCK_PORT=9999 bun run server.js     # 改端口
```

**HTTPS**（局域网自用场景，自签证书）：

```bash
bash scripts/gen-cert.sh    # 生成证书到 certs/，装了 mkcert 会优先用（浏览器不报警告）；没装退回 openssl 自签
bun run https                # 等价于 bun run scripts/start-https.js，默认读 certs/cert.pem + certs/key.pem
```

或者手动带两个环境变量启动（不依赖 `certs/` 默认路径，自己指定证书位置）：

```bash
MOCK_TLS_CERT=certs/cert.pem MOCK_TLS_KEY=certs/key.pem bun run server.js
```
```powershell
$env:MOCK_TLS_CERT="certs/cert.pem"; $env:MOCK_TLS_KEY="certs/key.pem"; bun run server.js
```

公网+域名场景不建议用自签证书，交给 Caddy/nginx 反代终止 HTTPS，见 [`Caddyfile.example`](./Caddyfile.example) 和 README「HTTPS」一节。

---

## 2. 模型 / 配置 / 预设 / 渠道管理（`scripts/cli.js`）

不用开网页，直接读写 `mock.db`（跟 `server.js` 用同一个 `store.js`），服务不在跑也能用；服务在跑的时候也能用（SQLite 文件锁保证不会读到写一半的脏数据，但别跟网页控制台同时保存同一个模型/配置/渠道——最后写的赢）。

```bash
bun run cli <命令> [参数...]     # package.json 别名，等价于 bun scripts/cli.js <命令> ...
```

### 模型

```bash
bun run cli add-model <id> [--vendor=openai] [--preset=预设名] [--字段=值 ...]
```
新建/更新模型身份，同时建/改它的默认 Configuration（单步完成，不用分两条命令）。`--vendor` 决定协议格式（见 `store.js` 的 `VENDOR_FORMAT_MAP`：openai/deepseek/kimi/glm/qwen/hunyuan/mistral/grok/llama/minimax/ernie/mimo → openai 协议；claude → claude 协议；gemini → gemini 协议；seedance → Doubao / Seedance 异步视频任务协议；custom-openai/custom-gemini/custom-claude → 对应协议，不确定选哪个厂商就用这三个）。

```bash
bun run cli list-models              # 列出全部模型 + 各自的 Configuration 数量
bun run cli delete-model <id>
```

### Configuration（模型的行为快照：回复内容/token/缓存/延迟/错误注入）

```bash
bun run cli add-config <modelId> <configId> [--name=..] [--channels=ch1,ch2] [--preset=..] [--字段=值 ...]
```
给已有模型再加一份 Configuration，可以绑定到指定渠道（`--channels`）。不绑渠道 = 这份配置只是"另一份可选的默认候选"，请求按 `(modelId, channelId)` 找专属配置，找不到就退回该模型 `ord` 最小的那份。

```bash
bun run cli list-configs <modelId>   # 列出某个模型下的全部 Configuration
bun run cli delete-config <configId>
bun run cli apply-preset <configId> <presetName>   # 给已有 Configuration 套用一个预设
```

字段名（`--latencyMode` `--promptTokens` `--errorRate` 等）跟控制台里的字段一一对应，完整列表看 `store.js` 的 `CONFIG_DEFAULTS`：

| 字段 | 说明 |
|---|---|
| `content` | 回复正文（原样返回，不截断） |
| `promptMode` | `auto`（按输入估算）/ `fixed`（固定值） |
| `promptTokens` / `completionTokens` | 输入/输出 token（`fixed` 模式下生效，或作为计费上报数字） |
| `seedanceVideoUrl` / `seedanceFinalStatus` | Seedance 成功视频 URL / 最终状态（`succeeded` 或 `failed`） |
| `seedanceLastFrameUrl` | 请求 `return_last_frame: true` 时返回的尾帧 URL |
| `seedanceFailureCode` / `seedanceFailureMessage` | Seedance 失败终态的 `error` 字段 |
| `seedanceQueuedPolls` / `seedanceRunningPolls` | Seedance 返回最终状态前的 queued / running 查询次数 |
| `seedanceSeed` / `seedanceResolution` / `seedanceDuration` / `seedanceRatio` / `seedanceFramesPerSecond` | Seedance 查询响应的任务属性（请求值优先） |
| `seedanceServiceTier` / `seedanceExecutionExpiresAfter` | Seedance 服务档和任务超时默认值（请求值优先） |
| `cacheMode` | `none` / `ratio`（按比例） / `fixed`（固定值） |
| `cacheRatio` / `cachedTokens` / `cacheCreationTokens` | 缓存命中/写入相关 |
| `latencyMode` | `fixed`（固定 `latencyMs`）/ `range`（区间随机，见下） |
| `latencyMs` | `fixed` 模式下的延迟(ms) |
| `latencyMin` / `latencyMax` / `latencyDist` | `range` 模式下的区间和分布（`uniform` 均匀 / `normal` 正态，以区间中点为均值、区间 1/6 为标准差） |
| `chunkDelayMs` | 流式每块之间的间隔(ms) |
| `errorStatus` / `errorRate` / `errorMessage` | 注入错误：`errorRate`% 概率返回 `errorStatus` 状态码 + `errorMessage` |

### 预设

```bash
bun run cli add-preset <name> [--from=<configId>] [--字段=值 ...]   # 从已有配置另存，或直接用字段拼一个新预设
bun run cli list-presets
bun run cli delete-preset <name>
```

例：
```bash
bun run cli add-model my-model --vendor=grok --preset=长延迟
bun run cli apply-preset my-model-default 长延迟
bun run cli add-preset 我的预设 --from=my-model-default
bun run cli add-preset 我的预设 --latencyMode=range --latencyMin=3000 --latencyMax=9000 --latencyDist=normal
```

### 渠道

```bash
bun run cli add-channel <id> [--name=..] [--port=8792] [--enabled=false] [--errorRate=30] [--extraLatencyMs=800]
bun run cli list-channels
bun run cli delete-channel <id>
```
字段对照 `store.js` 的 `CHANNEL_DEFAULTS`：`port`（不填自动分配不冲突的端口）、`enabled`（`false`/`0` = 整个渠道恒失败，模拟"渠道挂了"）、`errorRate`（0-100，独立于 Configuration 自己的错误率，模拟偶发故障）、`errorStatus`/`errorMessage`、`extraLatencyMs`（叠加在 Configuration 自身延迟之上）。

例：
```bash
bun run cli add-channel backup-2 --name="备用渠道 2" --extraLatencyMs=800
bun run cli add-channel custom-3 --port=9001
bun run cli add-channel flaky-2 --errorRate=30
bun run cli add-channel down-2 --enabled=false
```

---

## 3. 跑测试套件

```bash
bun test
```
跑全部 `*.test.js`（`formats.test.js` / `auth.test.js` / `channels.test.js` / `cli.test.js` / `tls.test.js`）。

---

## 4. 直接打 mock 自测（不经 new-api）

`Authorization: Bearer sk-xxx` 这个 mock 完全不校验，随便填一个字符串（比如 `sk-mock`）甚至不带都行——鉴权是 new-api 自己做的。

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

PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，`-H` 语法跟真 curl 不一样，直接抄上面的 Bash 命令会报参数绑定错误。用 `curl.exe`（显式带 `.exe` 后缀绕开别名）：

```powershell
curl.exe http://localhost:8788/v1/chat/completions `
  -H "Authorization: Bearer sk-mock" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"gpt-3.5-turbo\",\"messages\":[{\"role\":\"user\",\"content\":\"测试\"}]}"
```

或者用原生 PowerShell 语法（`Invoke-RestMethod` 自动把返回的 JSON 解析成对象，不用再 `ConvertFrom-Json`）：

```powershell
Invoke-RestMethod -Uri "http://localhost:8788/v1/chat/completions" `
  -Method Post -Headers @{ Authorization = "Bearer sk-mock" } -ContentType "application/json" `
  -Body '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"测试"}]}'
```

HTTPS 模式把 `http://` 换成 `https://`；自签证书场景 `curl.exe` 加 `-k` 跳过校验，`Invoke-RestMethod` 加 `-SkipCertificateCheck`。

渠道自己的端口（比如种子渠道的 8789/8790/8791）打法完全一样，把 `8788` 换成对应渠道端口即可，不用改路径。

---

## 5. 打 new-api（走完整链路）

`localhost:3000` 是 new-api 本地运行地址（不是这个 mock），走这条链路会真的经过 new-api 的鉴权/计费/日志。

**Bash（流式）**
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"测试"}]}'
```

**Bash（非流式，带 usage）**
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-3.5-turbo","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"测试"}]}'
```

**PowerShell** 和 **Windows CMD** 版本（反斜杠续行符不同：PowerShell 用 `` ` ``，CMD 用 `^`；两者 body 都要转义双引号）见 [README「团队合作」](./README.md#团队合作)一节，命令结构跟上面 Bash 版一一对应。

---

## 6. Docker

```bash
docker compose up                      # 项目自带 docker-compose.yml，独立运行本 mock
```

或一条 `docker run`（把当前目录挂进容器，不用装 bun）：

```bash
# Bash/macOS/Linux
docker run --rm -it -p 8788:8788 -v "$PWD":/app -w /app oven/bun:latest bun run server.js
# PowerShell
docker run --rm -it -p 8788:8788 -v ${PWD}:/app -w /app oven/bun:latest bun run server.js
# CMD
docker run --rm -it -p 8788:8788 -v %cd%:/app -w /app oven/bun:latest bun run server.js
```

现成镜像（不用 clone 仓库，CI 已自动构建推到 GHCR）：

```bash
docker run --rm -p 8788:8788 ghcr.io/lanvender4444/mockupstream:latest
```

---

## 7. 打包部署到云服务器

CI 已经把镜像自动推到了 GHCR，云服务器上直接 `docker pull` 是最省事的路子。`scripts/deploy.sh`/`scripts/deploy.ps1` 提供另一条不依赖公网镜像仓库的路：本地 `docker build` 打包镜像 → `scp` 传到服务器 → 远端 `docker load` 并重启容器，只要本机能 ssh 到服务器就行。数据用 docker named volume 挂到容器内的 `/app/mock.db`，重新部署不丢数据。

**Bash/macOS/Linux**（`scripts/deploy.sh`，参数走环境变量）：

```bash
DEPLOY_HOST=user@1.2.3.4 bash scripts/deploy.sh
DEPLOY_HOST=root@1.2.3.4 DEPLOY_PORT=2222 DEPLOY_KEY=~/.ssh/id_ed25519 bash scripts/deploy.sh
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEPLOY_HOST` | 无（必填） | `user@host`，或 `~/.ssh/config` 里配好的别名 |
| `DEPLOY_PORT` | `22` | ssh 端口 |
| `DEPLOY_KEY` | 空（走 ssh-agent/默认身份） | ssh 私钥路径 |
| `DEPLOY_DIR` | `mockupstream` | 远端存放镜像包的目录（相对远端登录用户 home） |
| `IMAGE_NAME` | `mockupstream` | 镜像名 |
| `IMAGE_TAG` | `latest` | 镜像 tag |
| `CONTAINER_NAME` | `mock-upstream` | 远端容器名 |
| `DB_VOLUME` | `<CONTAINER_NAME>-db` | 远端 named volume，挂到容器内 `/app/mock.db` |
| `PORTS` | `8788:8788 8789:8789 8790:8790 8791:8791` | 端口映射，空格分隔 |

**PowerShell**（`scripts/deploy.ps1`，参数走命名参数，需要 Windows 自带的 OpenSSH 客户端）：

```powershell
.\scripts\deploy.ps1 -DeployHost user@1.2.3.4
.\scripts\deploy.ps1 -DeployHost root@1.2.3.4 -DeployPort 2222 -DeployKey ~/.ssh/id_ed25519
```

参数跟上面环境变量表一一对应（`-DeployHost` `-DeployPort` `-DeployKey` `-DeployDir` `-ImageName` `-ImageTag` `-ContainerName` `-DbVolume` `-Ports`），默认值相同。

两个脚本逻辑一致：build → 导出 tar → 上传 → 远端 `docker load` + `docker rm -f` 旧容器 + `docker run -d --restart unless-stopped` 起新容器。重复跑是幂等的，改了代码后再跑一次就是升级。

---

## 8. 云服务器防火墙一键放行

只管**操作系统自带防火墙**（Linux 自动识别 firewalld/ufw；Windows 用 `New-NetFirewallRule`）——阿里云/腾讯云/AWS 等云厂商的**安全组**是另一层，控制台上还要照样单独放行一遍，这两个脚本管不到那一层。

**Linux**（`scripts/open-ports.sh`，要 root/sudo）：

```bash
sudo bash scripts/open-ports.sh                          # 默认放行 8788 8789-8791
sudo PORTS="8788 8789-8791 9999" bash scripts/open-ports.sh
```

**Windows**（`scripts/open-ports.ps1`，要「以管理员身份运行」PowerShell）：

```powershell
.\scripts\open-ports.ps1
.\scripts\open-ports.ps1 -Ports 8788,8789-8791,9999
```

`open-ports.sh` 检测到 ufw 处于 inactive 时只会提示，不会替你 `ufw enable`——开启前自己确认 22(ssh) 端口在放行名单里，免得把自己锁在门外。

---

## 9. 测试工具（scripts/test-helper.js）

向任意 OpenAI 兼容 endpoint（这个 mock 自己、或一个真实 new-api 实例）发请求，看响应内容或统计错误率/延迟分布，命令行版本，跟控制台「Test」页签功能等价、共享同一份核心逻辑（`testRunner.js`）；面板操作步骤见 [README「测试工具」一节](./README.md#测试工具test)。

```bash
bun scripts/test-helper.js --target=http://localhost:8788 --model=grok-4.5 --count=20 --concurrency=5
bun scripts/test-helper.js --target=http://192.168.1.100:3000 --model=gpt-3.5-turbo --api-key=sk-your-api-key --count=1
```

| 参数 | 说明 |
|---|---|
| `--target` | 必填，目标地址（这个 mock 自己的地址，或一个真实 new-api 实例的地址） |
| `--model` | 必填，要测的模型名 |
| `--format` | 协议，`openai`(默认)/`claude`/`gemini` |
| `--api-key` | 目标要求的凭证；测这个 mock 时随便填（不校验），测真实 new-api 时填真的 |
| `--prompt` | 不填走默认值 |
| `--stream` | 加上则测试流式请求 |
| `--count` | 条数，1-1000，默认 20；`--count=1` 时自动额外打印完整响应体（单次模式） |
| `--concurrency` | 并发数，1-50，默认 5 |
| `--verbose` | 额外打印逐条明细（默认只打印汇总，避免刷屏） |

---

## 10. 环境变量总表

| 变量 | 用在哪 | 默认值 | 说明 |
|---|---|---|---|
| `MOCK_PORT` | `bun run server.js` | `8788` | 主端口 |
| `MOCK_TLS_CERT` / `MOCK_TLS_KEY` | `bun run server.js` / `bun run https` | 未设置(明文 HTTP) | 两个都给了、且文件都存在才启用 HTTPS |
| `DEPLOY_HOST` / `DEPLOY_PORT` / `DEPLOY_KEY` / `DEPLOY_DIR` / `IMAGE_NAME` / `IMAGE_TAG` / `CONTAINER_NAME` / `DB_VOLUME` / `PORTS` | `scripts/deploy.sh` | 见[第 7 节](#7-打包部署到云服务器) | 部署脚本参数 |
| `PORTS` | `scripts/open-ports.sh` | `8788 8789-8791` | 要放行的端口列表 |

PowerShell 版脚本（`deploy.ps1` / `open-ports.ps1`）走命名参数而不是环境变量，见对应小节。
