<#
scripts/open-ports.ps1 —— Windows 服务器上一键放行入站端口(TCP)，用 Windows 防火墙 New-NetFirewallRule。
只管 Windows 系统自带防火墙；阿里云/腾讯云/AWS 等云厂商的"安全组"是另一层，控制台上还要单独放行一遍，这个脚本管不到。

用法（要「以管理员身份运行」PowerShell）：
  .\scripts\open-ports.ps1                              # 默认放行 8788,8789-8791
  .\scripts\open-ports.ps1 -Ports 8788,8789-8791,9999
#>
[CmdletBinding()]
param(
    [string[]]$Ports = @("8788", "8789-8791")
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限，请「以管理员身份运行」PowerShell 后重试。" -ForegroundColor Yellow
    exit 1
}

foreach ($p in $Ports) {
    $ruleName = "MockUpStream-$p"

    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

    New-NetFirewallRule -DisplayName $ruleName `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort $p `
        -Action Allow | Out-Null

    Write-Host "已放行: $p/tcp (规则名: $ruleName)"
}

Write-Host ""
Write-Host "Windows 防火墙已放行: $($Ports -join ', ')"
Write-Host "如果是阿里云/腾讯云/AWS 等云厂商服务器，还要去控制台「安全组」里放行同样的端口"
