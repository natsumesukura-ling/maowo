#!/usr/bin/env bash
# 关掉 SSH 的密码登录 + 装防爆破 fail2ban（绫 2026-11-05 点头的）
#
#   curl -fsSL "https://raw.githubusercontent.com/natsumesukura-ling/maowo/ccr-d223d08b-tyy5yy/deploy/ssh-lockdown.sh?v=1" | sudo bash
#
# 只做两件事：
#   1. 加 /etc/ssh/sshd_config.d/00-maowo.conf：不许用密码登录，root 只能用钥匙。原来的设置文件不动。
#      （sshd 取第一次读到的值，00- 排在云镜像自带的 50-cloud-init.conf 前面，所以它说了算。）
#   2. 装 fail2ban：同一个地址 10 分钟里错 3 次，封一天。只管 SSH。
# 腾讯云小程序的「免密连接」走 tat_agent，不经过 SSH，这里改什么都影响不到它。
#
# 撤销：
#   sudo rm /etc/ssh/sshd_config.d/00-maowo.conf && sudo systemctl restart ssh
#   sudo apt-get remove -y fail2ban
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "请在命令前加 sudo 再运行"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
CONF=/etc/ssh/sshd_config.d/00-maowo.conf
say()  { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
good() { printf '  \033[1;32m[好]\033[0m %s\n' "$*"; }
oops() { printf '  \033[1;31m[没成]\033[0m %s\n' "$*"; }

# ------------------------------------------------------------
say "1/2 关掉 SSH 的密码登录"
cat > "$CONF" <<'EOF'
# 猫窝：不许用密码登录 SSH，root 只能用钥匙（2026-11-05）。撤销就删掉这个文件再 systemctl restart ssh。
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
chmod 644 "$CONF"

if ! sshd -t 2>/tmp/maowo-sshd-test; then
  oops "设置自检没通过，已经撤掉，什么都没改：$(head -c 300 /tmp/maowo-sshd-test)"
  rm -f "$CONF" /tmp/maowo-sshd-test
  exit 1
fi
rm -f /tmp/maowo-sshd-test
T=$(sshd -T 2>/dev/null)
v() { echo "$T" | awk -v k="$1" '$1==k {print $2; exit}'; }
if [ "$(v passwordauthentication)" != no ]; then
  oops "写进去了但没生效（PasswordAuthentication 还是 $(v passwordauthentication)），已经撤掉"
  rm -f "$CONF"
  exit 1
fi
# The daemon reads its settings when it starts: restart it if it is running (ssh.socket starts it on demand otherwise).
systemctl try-restart ssh.service 2>/dev/null || true
good "密码登录：$(v passwordauthentication)    键盘交互：$(v kbdinteractiveauthentication)    root：$(v permitrootlogin)"

# Knock on our own door with a password, the way the guessers do: it must not even offer password.
if command -v ssh >/dev/null; then
  r=$(timeout 15 ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR nobody@127.0.0.1 true 2>&1)
  case "$r" in
    *"Permission denied (publickey)"*) good "自己敲门试了一下：只认钥匙，不给输密码了" ;;
    *) oops "自己敲门的结果不太对，截图给小55看：$(echo "$r" | head -c 200)" ;;
  esac
fi

# ------------------------------------------------------------
say "2/2 装防爆破 fail2ban"
apt-get update -y >/dev/null 2>&1 || true
if apt-get install -y fail2ban python3-systemd >/dev/null 2>&1; then
  cat > /etc/fail2ban/jail.d/maowo.conf <<'EOF'
# 猫窝：同一个地址 10 分钟里错 3 次，封一天。只管 SSH。
[sshd]
enabled  = true
backend  = systemd
maxretry = 3
findtime = 10m
bantime  = 1d
EOF
  systemctl enable fail2ban >/dev/null 2>&1
  systemctl restart fail2ban
  sleep 3
  if fail2ban-client status sshd >/dev/null 2>&1; then
    good "fail2ban 在跑，正在看着 SSH 的门"
  else
    oops "fail2ban 装上了但没跑起来，截图给小55看：$(systemctl status fail2ban --no-pager 2>&1 | tail -3 | tr '\n' ' ' | head -c 300)"
  fi
else
  oops "fail2ban 没装上（可能是网络或软件源的问题）。第一步已经生效，这一步可以过会儿再运行一次这个命令"
fi

echo
echo "做完了。现在另开一个新的「免密连接」试试，能进就说明一切正常。"
