#!/usr/bin/env bash
# 猫窝一键安装 / 更新（Ubuntu 22.04 / 24.04）
#
#   curl -fsSL https://raw.githubusercontent.com/natsumesukura-ling/maowo/ccr-d223d08b-tyy5yy/deploy/install.sh | sudo bash
#
# 再运行一次就是更新：拉取最新代码并重启。数据在 /var/lib/maowo，不会被动到。
# 有自己的域名时：curl ... | sudo DOMAIN=example.com bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/natsumesukura-ling/maowo.git}"
BRANCH="${BRANCH:-ccr-d223d08b-tyy5yy}"
APP_DIR=/opt/maowo
DATA_DIR=/var/lib/maowo
APP_USER=maowo
PORT=3000

step() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请在命令前加 sudo 再运行"
export DEBIAN_FRONTEND=noninteractive
# A fresh server often runs automatic updates for its first minutes. Make every apt call
# (including the Node.js setup script's) wait for them instead of failing.
echo 'DPkg::Lock::Timeout "900";' > /etc/apt/apt.conf.d/99maowo-lock-timeout

step "1/6 安装基础软件"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg build-essential python3 \
  debian-keyring debian-archive-keyring apt-transport-https

step "2/6 安装 Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

step "3/6 下载猫窝"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
git -C "$APP_DIR" log -1 --format='当前版本：%h %s'

step "4/6 安装依赖"
cd "$APP_DIR"
npm ci --omit=dev

step "5/6 设置开机自动启动"
cat > /etc/systemd/system/maowo.service <<EOF
[Unit]
Description=maowo
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT HOST=127.0.0.1 DB_PATH=$DATA_DIR/games.db NODE_ENV=production
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable maowo >/dev/null
systemctl restart maowo

step "6/6 配置 HTTPS"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
if [ -z "${DOMAIN:-}" ]; then
  # Without a domain of its own, <ip-with-dashes>.sslip.io resolves to this server and can get a certificate.
  IP="$(curl -fsS --max-time 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null \
    || curl -fsS --max-time 5 https://api.ipify.org)" || fail "查不到这台服务器的公网 IP"
  DOMAIN="${IP//./-}.sslip.io"
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
# Caddy is built with Go 1.24+, which listens with Multipath TCP when the kernel allows it.
# 猫窝 does not need MPTCP, and CVE-2026-98432 (TCP use-after-free, 2026-10) was shown exploitable
# for remote root through MPTCP listeners, so it stays off. Caddy restarts below to listen without it.
echo 'net.mptcp.enabled = 0' > /etc/sysctl.d/99-maowo-no-mptcp.conf
sysctl -q -w net.mptcp.enabled=0 2>/dev/null || true
systemctl enable caddy >/dev/null
systemctl restart caddy

echo "等待 HTTPS 证书……"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 -o /dev/null "https://$DOMAIN/vault"; then
    cat <<EOF

$(printf '\033[1;32m')猫窝装好啦！$(printf '\033[0m')

  存档页面： https://$DOMAIN/vault
  MCP 地址： https://$DOMAIN/mcp?token=<你的 token>

查看 token（只给自己看，不要截图或发给别人）：
  sudo cat $DATA_DIR/maowo-token.txt

以后更新：再运行一次同样的安装命令。
EOF
    # A kernel security update only counts after a reboot.
    if [ -f /var/run/reboot-required ]; then
      echo; echo "$(printf '\033[1;33m')系统装了需要重启才生效的更新（比如内核补丁）。方便的时候运行：sudo reboot$(printf '\033[0m')"
    fi
    exit 0
  fi
  sleep 4
done

systemctl --no-pager status maowo | head -5 || true
fail "https://$DOMAIN 连不上。请在腾讯云控制台的「防火墙」里确认 80 和 443 端口已经放行，然后再运行一次安装命令。"
