<#
scripts/deploy.ps1 —— 本地 docker build 打包镜像，scp 上传到云服务器，远端 load 并重启容器。
不依赖 GHCR/公网镜像仓库，服务器能连本机 ssh 就行。云服务器默认按 Linux 处理（远端命令是 bash）。

用法：
  .\scripts\deploy.ps1 -DeployHost user@1.2.3.4
  .\scripts\deploy.ps1 -DeployHost root@1.2.3.4 -DeployPort 2222 -DeployKey ~/.ssh/id_ed25519

需要本机装了 Docker Desktop，以及 Windows 自带的 OpenSSH 客户端（ssh.exe/scp.exe，Win10 1809+ 默认自带；
没有的话：设置 -> 应用 -> 可选功能 -> 添加"OpenSSH 客户端"，或 winget install Microsoft.OpenSSH.Beta）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DeployHost,

    [int]$DeployPort = 22,
    [string]$DeployKey = "",
    [string]$DeployDir = "mockupstream",
    [string]$ImageName = "mockupstream",
    [string]$ImageTag = "latest",
    [string]$ContainerName = "mock-upstream",
    [string]$DbVolume = "",
    [string[]]$Ports = @("8788:8788", "8789:8789", "8790:8790", "8791:8791")
)

$ErrorActionPreference = "Stop"

if (-not $DbVolume) { $DbVolume = "$ContainerName-db" }

$RootDir = Split-Path -Parent $PSScriptRoot
$TarName = "$ImageName-$ImageTag.tar"
$LocalTar = Join-Path $env:TEMP $TarName

$SshOpts = @("-p", "$DeployPort")
if ($DeployKey -ne "") { $SshOpts += @("-i", $DeployKey) }

function Invoke-Checked {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) { throw "$Description 失败（退出码 $LASTEXITCODE）" }
}

try {
    Write-Host "==> [1/4] 本地构建镜像 ${ImageName}:${ImageTag}"
    docker build -t "${ImageName}:${ImageTag}" $RootDir
    Invoke-Checked "docker build"

    Write-Host "==> [2/4] 导出镜像为 $LocalTar"
    docker save -o $LocalTar "${ImageName}:${ImageTag}"
    Invoke-Checked "docker save"

    Write-Host "==> [3/4] 上传到 ${DeployHost}:${DeployDir}/${TarName}"
    ssh @SshOpts $DeployHost "mkdir -p '$DeployDir'"
    Invoke-Checked "ssh mkdir"
    scp @SshOpts $LocalTar "${DeployHost}:${DeployDir}/${TarName}"
    Invoke-Checked "scp upload"

    Write-Host "==> [4/4] 远端 load 镜像并重启容器 $ContainerName"
    $portArgs = ($Ports | ForEach-Object { "-p $_" }) -join " "

    # 远端是 Linux/bash；用 `$( 转义让 docker ps 的 $(...) 留到远端执行，其余变量在本地插值好再传过去。
    $remoteScript = @"
set -e
cd '$DeployDir'
docker load -i '$TarName'
rm -f '$TarName'
docker rm -f '$ContainerName' >/dev/null 2>&1 || true
docker volume create '$DbVolume' >/dev/null
docker run -d --name '$ContainerName' --restart unless-stopped $portArgs -v '${DbVolume}:/app/mock.db' '${ImageName}:${ImageTag}'
echo "容器已启动: `$(docker ps --filter name='$ContainerName' --format '{{.Names}} {{.Status}} {{.Ports}}')"
"@

    $remoteScript | ssh @SshOpts $DeployHost "bash -s"
    Invoke-Checked "远端部署"

    Write-Host ""
    Write-Host "部署完成。控制台: http://<服务器IP>:8788/"
    Write-Host "记得在云服务器安全组/防火墙放行用到的端口（默认 8788、8789-8791）。"
}
finally {
    if (Test-Path $LocalTar) { Remove-Item $LocalTar -Force }
}
