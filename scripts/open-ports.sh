#!/usr/bin/env bash
# scripts/open-ports.sh —— 云服务器上一键放行端口(TCP)。自动识别 firewalld / ufw。
# 只管操作系统自带防火墙；阿里云/腾讯云/AWS 等云厂商的"安全组"是另一层，控制台上还要单独放行一遍，这个脚本管不到。
#
# 用法（要 root/sudo）：
#   sudo bash scripts/open-ports.sh                          # 默认放行 8788 8789-8791
#   sudo PORTS="8788 8789-8791 9999" bash scripts/open-ports.sh
set -e

PORTS="${PORTS:-8788 8789-8791}"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root 权限，请用 sudo 运行: sudo bash $0" >&2
  exit 1
fi

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
  echo "==> 检测到 firewalld 正在运行，逐条放行(--permanent)..."
  for p in $PORTS; do
    firewall-cmd --permanent --add-port="${p}/tcp"
  done
  firewall-cmd --reload
  echo "已放行端口:"
  firewall-cmd --list-ports

elif command -v ufw >/dev/null 2>&1; then
  echo "==> 检测到 ufw，逐条放行..."
  for p in $PORTS; do
    ufw allow "${p/-/:}/tcp"
  done
  if ufw status | grep -q "^Status: inactive"; then
    echo "注意: ufw 当前是 inactive，规则已加但不会生效——要不要执行 sudo ufw enable 自己决定，"
    echo "启用前确认 22(ssh) 端口也在放行名单里，否则可能把自己锁在门外。"
  else
    ufw reload
  fi
  echo "已放行端口(ufw 规则):"
  ufw status numbered

else
  echo "没找到 firewalld / ufw，可能是裸 iptables 或没装防火墙管理工具。" >&2
  echo "手动放行示例: iptables -A INPUT -p tcp --dport 8788 -j ACCEPT" >&2
  exit 1
fi

echo
echo "系统防火墙已放行: $PORTS"
echo "如果是阿里云/腾讯云/AWS 等云厂商服务器，还要去控制台「安全组」里放行同样的端口"
