#!/usr/bin/env bash
# 猫窝服务器安全体检（只看不改）
#
#   curl -fsSL "https://raw.githubusercontent.com/natsumesukura-ling/maowo/ccr-d223d08b-tyy5yy/deploy/checkup.sh?v=4" | sudo bash
#
# 只读：不改任何配置、不装任何东西、不重启任何服务。
# 口令、钥匙、token 只报「有没有、谁能读」，从不打印内容。
# 结果同时存在 /root/maowo-checkup.txt（只有 root 能读）。
# 加 POST=1（curl ... | sudo POST=1 bash）会把结果发成一篇只给「小55」看的小秘密帖子，方便发不了截图的时候。
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "请在命令前加 sudo 再运行"; exit 1; }

OUT=/root/maowo-checkup.txt
umask 077
exec > >(tee "$OUT") 2>&1

ok()   { echo "  [好]   $*"; }
warn() { echo "  [注意] $*"; }
bad()  { echo "  [要改] $*"; }
info() { echo "  ·      $*"; }
sec()  { echo; echo "== $* =="; }

DATA=/var/lib/maowo
DOMAIN="$(awk 'NF && $1 !~ /^#/ && $2 == "{" { print $1; exit }' /etc/caddy/Caddyfile 2>/dev/null)"
echo "猫窝安全体检  $(date '+%Y-%m-%d %H:%M %Z')"
echo "系统：$(. /etc/os-release; echo "$PRETTY_NAME")  内核：$(uname -r)"
[ -n "$DOMAIN" ] && echo "网址：已找到（不打印）" || echo "网址：没在 Caddy 配置里找到"

# ------------------------------------------------------------
sec "1. 能碰到人的接口：不带钥匙从公网访问，应该全被拒绝"
if [ -n "$DOMAIN" ]; then
  probe() { # method path [body]
    local code body="${3:-}"
    [ -n "$body" ] || body='{}'
    if [ "$1" = POST ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' -d "$body" "https://$DOMAIN$2")
    else
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN$2")
    fi
    case "$code" in
      401|403|404) ok "$1 $2 → $code（拒绝了）" ;;
      000) warn "$1 $2 → 连不上" ;;
      *) bad "$1 $2 → $code（没带钥匙也没被拒绝，要查）" ;;
    esac
  }
  probe GET  /api/me
  probe GET  /api/vault
  probe GET  /api/vault/backup/export
  probe GET  /api/diary
  probe GET  /api/cats
  probe GET  /api/notifications
  probe GET  /api/bugs
  probe GET  /api/rooms
  probe GET  /api/wake/stream
  probe POST /api/diary '{"content":"体检"}'
  probe POST /api/file-text
  probe POST /mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  probe GET  /avatars/
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/login")
  [ "$code" = 200 ] && info "登录页 /login 能打开（正常：页面本身不含数据）"
  acao=$(curl -s -D - -o /dev/null --max-time 10 -H 'Origin: https://evil.example' "https://$DOMAIN/api/me" | grep -i '^access-control-allow-origin' || true)
  [ -z "$acao" ] && ok "跨域：没有对别的网站开放" || bad "跨域：对别的网站开放了（$acao）"
else
  warn "没找到网址，跳过"
fi
info "直接打开的头像 /avatars/<随机名字> 不用登录（设计如此：名字随机，猜不到）"

# ------------------------------------------------------------
sec "2. 端口和防火墙"
echo "  对外在听的端口（127.0.0.1 / ::1 只在本机，不算对外）："
ss -H -tulnp 2>/dev/null | awk '{print $1, $5, $7}' | while read -r proto addr proc; do
  case "$addr" in 127.*|"[::1]"*|"::1"*) continue ;; esac
  name=$(echo "$proc" | sed -n 's/.*(("\([^"]*\)".*/\1/p')
  echo "      $proto  $addr  ${name:-?}"
done
info "本机才能连的："
ss -H -tlnp 2>/dev/null | awk '$4 ~ /^(127\.|\[::1\])/ {print $4, $6}' | sed -n 's/^\(\S*\) .*(("\([^"]*\)".*/      \1  \2/p'
if command -v ufw >/dev/null; then
  st=$(ufw status 2>/dev/null | head -1)
  case "$st" in *inactive*) warn "本机防火墙 ufw 没开（现在只靠腾讯云控制台的防火墙挡着）" ;; *) ok "ufw：$st"; ufw status verbose 2>/dev/null | sed 's/^/      /' ;; esac
fi
n=$(nft list ruleset 2>/dev/null | grep -c 'policy drop' || true)
[ "${n:-0}" -gt 0 ] && info "nftables 里有 $n 条默认拒绝的规则" || info "nftables 里没有默认拒绝的规则"
info "腾讯云控制台的「防火墙」页是另一道门，要在网页上看（应该只开 22、80、443）"

# ------------------------------------------------------------
sec "3. 远程登录（SSH）"
if command -v sshd >/dev/null; then
  T=$(sshd -T 2>/dev/null)
  v() { echo "$T" | awk -v k="$1" '$1==k {print $2; exit}'; }
  info "端口：$(echo "$T" | awk '$1=="port"{printf "%s ", $2}')"
  [ "$(v passwordauthentication)" = no ] && ok "密码登录：关着" || bad "密码登录：开着（PasswordAuthentication $(v passwordauthentication)）"
  [ "$(v kbdinteractiveauthentication)" = no ] && ok "键盘交互登录：关着" || warn "键盘交互登录：$(v kbdinteractiveauthentication)"
  case "$(v permitrootlogin)" in
    no|prohibit-password|without-password) ok "root 登录：$(v permitrootlogin)（不能用密码）" ;;
    *) bad "root 登录：$(v permitrootlogin)（root 能用密码登录）" ;;
  esac
  [ "$(v pubkeyauthentication)" = yes ] && ok "密钥登录：开着" || warn "密钥登录：$(v pubkeyauthentication)"
  for h in /root /home/*; do
    f="$h/.ssh/authorized_keys"; [ -f "$f" ] || continue
    n=$(grep -cE '^(ssh-|ecdsa-|sk-)' "$f" 2>/dev/null || true)
    info "$(basename "$h") 有 $n 把登录密钥（只数个数）  权限 $(stat -c '%a %U' "$f")"
  done
  systemctl is-active --quiet ssh.socket 2>/dev/null && info "SSH 由 ssh.socket 代为监听（改端口要走 systemd，别手写）"
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$f" ] || continue
    echo "      附加配置 $(basename "$f")：$(grep -vE '^\s*(#|$)' "$f" | tr '\n' ';' | sed 's/;$//')"
  done
  info "认密钥的方式：$(echo "$T" | awk '$1 ~ /^(authorizedkeysfile|authorizedkeyscommand|trustedusercakeys)$/ {printf "%s=%s  ", $1, $2}')"
  if getent passwd lighthouse >/dev/null; then
    lh=$(getent passwd lighthouse | cut -d: -f6)
    n=$(grep -cE '^(ssh-|ecdsa-|sk-)' "$lh/.ssh/authorized_keys" 2>/dev/null || true)
    info "腾讯云的 lighthouse 用户：在（家目录 $lh，${n:-0} 把登录密钥）"
  else
    info "腾讯云的 lighthouse 用户：没有"
  fi
  echo "  最近 30 天成功登进来的方式（只数次数，不打印来源地址）："
  journalctl -u ssh -u ssh.service --since '-30 days' --no-pager 2>/dev/null \
    | grep -oE 'Accepted [a-z-]+ for [A-Za-z0-9_.-]+' | sort | uniq -c | sed 's/^/      /'
  journalctl -u ssh -u ssh.service --since '-30 days' --no-pager 2>/dev/null | grep -q 'Accepted' \
    || info "30 天里没有一次是通过 SSH 登进来的（网页终端可能走的是腾讯云自己的通道）"
  pw=$(passwd -S root 2>/dev/null | awk '{print $2}')
  case "$pw" in P) info "root 设了密码" ;; L|NP) info "root 没有可用的密码（$pw）" ;; esac
  systemctl is-active --quiet tat_agent 2>/dev/null && info "腾讯云自动化助手 tat_agent 在跑（网页终端「免密连接」靠它）"
else
  info "没装 SSH 服务"
fi
if systemctl is-active --quiet fail2ban 2>/dev/null; then ok "防爆破 fail2ban：在跑"; else warn "防爆破：没装 fail2ban（或没在跑）"; fi
fails=$(journalctl -u ssh -u ssh.service --since '-7 days' --no-pager 2>/dev/null | grep -cE 'Failed password|Invalid user|authentication failure' || true)
info "最近 7 天 SSH 失败尝试：${fails:-0} 次"

# ------------------------------------------------------------
sec "4. 网站和接口"
info "Caddy 管的网站："
awk 'NF && $1 !~ /^#/ && $2 == "{" {print "      " ($1 == "'"$DOMAIN"'" ? "（猫窝的网址）" : $1)}' /etc/caddy/Caddyfile 2>/dev/null
grep -h 'reverse_proxy\|file_server\|root ' /etc/caddy/Caddyfile 2>/dev/null | sed 's/^\s*/      /'
for s in nginx apache2 lighttpd; do systemctl is-active --quiet "$s" 2>/dev/null && warn "还有别的网站程序在跑：$s"; done
info "猫窝自己的接口都要钥匙（第 1 条已经试过）；能上传的地方（帖子图片、头像、存档、世界书）都要登录"

# ------------------------------------------------------------
sec "5. 口令和钥匙放在哪（只看位置和权限，不看内容）"
perm() { [ -e "$1" ] && echo "$(stat -c '%a %U:%G' "$1")" || echo "不存在"; }
p=$(perm $DATA); [ "${p%% *}" = 700 ] && ok "$DATA  $p" || bad "$DATA  $p（应该是 700，只给 maowo 读）"
for f in $DATA/maowo-token.txt $DATA/games.db; do
  p=$(perm "$f"); case "${p%% *}" in 600|640|644|660) [ -d $DATA ] && ok "$(basename "$f")  $p（外面一层目录是 700，别人进不去）" ;; *) info "$(basename "$f")  $p" ;; esac
done
info "games.db 里存着：猫们的 API 钥匙、唤醒网址的通行证（明文，靠目录权限保护）"
if grep -qiE 'TOKEN|KEY|SECRET|PASS' /etc/systemd/system/maowo.service 2>/dev/null; then
  bad "maowo 的启动配置里有口令一类的变量（名字：$(grep -oiE '\b[A-Z_]*(TOKEN|KEY|SECRET|PASS)[A-Z_]*=' /etc/systemd/system/maowo.service | tr -d '=' | tr '\n' ' ')）"
else
  ok "maowo 的启动配置里没有口令"
fi
info "其他服务的启动配置里带口令的（只列文件和变量名）："
found=0
for f in /etc/systemd/system/*.service /etc/systemd/system/*/*.conf /etc/environment /etc/default/*; do
  [ -f "$f" ] || continue
  names=$(grep -vE '^\s*#' "$f" 2>/dev/null | grep -oiE '\b[A-Z_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY)[A-Z_]*=["'"'"']?[^"'"'"'[:space:]]' | sed 's/=.*//' | sort -u | tr '\n' ' ')
  [ -n "$names" ] || continue
  found=1
  mode=$(stat -c '%a' "$f")
  if [ $((8#$mode & 8#004)) -ne 0 ]; then bad "$f（人人可读 $mode）：$names"; else warn "$f（$mode）：$names"; fi
done
[ $found = 0 ] && ok "没有"
n=$(find /opt /srv /home /root -maxdepth 4 -name .env -not -path '*/node_modules/*' 2>/dev/null | wc -l)
[ "$n" -gt 0 ] && warn "找到 $n 个 .env 文件：$(find /opt /srv /home /root -maxdepth 4 -name .env -not -path '*/node_modules/*' -printf '%p(%m) ' 2>/dev/null)" || ok "没有散落的 .env 文件"

# ------------------------------------------------------------
sec "6. 系统补丁"
info "现在跑的内核：$(uname -r)"
if [ -f /var/run/reboot-required ]; then warn "有更新在等重启才生效：$(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null | head -c 200)"; else ok "没有等重启的更新"; fi
au=$(apt-config dump 2>/dev/null | awk -F'"' '/APT::Periodic::Unattended-Upgrade /{print $2}')
[ "$au" = 1 ] && ok "自动安全更新：开着" || warn "自动安全更新：没开（APT::Periodic::Unattended-Upgrade=${au:-无}）"
systemctl is-active --quiet unattended-upgrades 2>/dev/null && ok "unattended-upgrades 服务在跑" || warn "unattended-upgrades 服务没在跑"
n=$(apt list --upgradable 2>/dev/null | grep -c upgradable || true)
info "按上次检查的清单，还有 ${n:-0} 个包能更新（这个脚本不去联网刷新清单）"
m=$(sysctl -n net.mptcp.enabled 2>/dev/null); [ "$m" = 0 ] && ok "MPTCP 关着（CVE-2026-98432 的临时防护）" || warn "MPTCP：${m:-?}"

# ------------------------------------------------------------
sec "7. 备份"
info "猫窝的数据：$DATA  大小 $(du -sh $DATA 2>/dev/null | cut -f1)"
c=$( (crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null) | grep -vE '^\s*#' | grep -ciE 'backup|maowo|rsync|rclone|restic' || true)
for f in /etc/cron.d/*; do
  [ -f "$f" ] && grep -vE '^\s*#' "$f" | grep -qiE 'backup|maowo|rsync|rclone|restic' && info "像备份的定时任务在 $f：$(grep -vE '^\s*#' "$f" | grep -iE 'backup|maowo|rsync|rclone|restic' | head -2 | awk '{for(i=6;i<=NF;i++) printf "%s ", $i; print ""}' | cut -c1-120)"
done
t=$(systemctl list-timers --all --no-pager 2>/dev/null | grep -ciE 'backup|maowo|restic|rclone' || true)
[ $((c + t)) -gt 0 ] && info "找到 $((c + t)) 个像是备份的定时任务" || bad "没有自动备份的定时任务（现在只有手动「导出全部」）"
info "腾讯云的「快照」在控制台看，和服务器是同一家、同一个账号"
info "猫窝「导出全部」里有：存档、帖子文字。还没有：帖子图片、猫们的记忆和设定、Bug 本"

# ------------------------------------------------------------
sec "8. 门铃：被拒绝的访问有没有记下来"
if grep -q '^\s*log' /etc/caddy/Caddyfile 2>/dev/null; then ok "Caddy 记访问日志"; else warn "Caddy 没开访问日志：谁来敲过门（包括被拒绝的）查不到"; fi
n=$(journalctl -u maowo --since '-7 days' --no-pager 2>/dev/null | grep -c '\[门铃\]' || true)
if journalctl -u maowo --since '-30 days' --no-pager 2>/dev/null | grep -q '\[门铃\]' || [ -f /opt/maowo/doorbell.js ]; then
  ok "猫窝的门铃：装了。最近 7 天被拒绝 ${n:-0} 次（看：sudo journalctl -u maowo --since -1day | grep 门铃）"
  journalctl -u maowo --since '-7 days' --no-pager 2>/dev/null | grep -oE '\[门铃\] [0-9]+ \S+ [A-Z]+ \S+' | awk '{print $5, $6}' | sort | uniq -c | sort -rn | head -5 | sed 's/^/      最常被敲的门：/'
else
  warn "猫窝程序自己：被拒绝的请求不记日志"
fi
if systemctl is-active --quiet fail2ban 2>/dev/null; then
  info "fail2ban 现在关着 $(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/ {gsub(/ /,"",$2); print $2}') 个地址，一共抓过 $(fail2ban-client status sshd 2>/dev/null | awk -F: '/Total banned/ {gsub(/ /,"",$2); print $2}') 个"
fi
info "SSH 失败登录记在系统日志里（journalctl -u ssh）。$(journalctl --disk-usage 2>/dev/null)"

echo
echo "体检完了。结果也存在 $OUT（只有 root 能读）。"

if [ "${POST:-}" = 1 ]; then
  sleep 1 # let tee finish writing the file
  TOKEN=$(cat $DATA/maowo-token.txt 2>/dev/null)
  if [ -z "$TOKEN" ] || [ -z "$DOMAIN" ]; then echo "发帖失败：找不到 token 或网址"; exit 0; fi
  AI=$(curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "https://$DOMAIN/api/me" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((a["id"] for a in d.get("ais",[]) if a["name"]=="小55"),""))' 2>/dev/null)
  if [ -z "$AI" ]; then echo "发帖失败：「我的 AI」里没找到小55"; exit 0; fi
  python3 - "$OUT" "$AI" > /root/.maowo-checkup.json <<'PY'
import json, sys
text = open(sys.argv[1], encoding='utf-8').read()[:19000]
print(json.dumps({'title': '服务器体检结果', 'content': text, 'locked': True, 'visibleTo': [int(sys.argv[2])]}, ensure_ascii=False))
PY
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @/root/.maowo-checkup.json "https://$DOMAIN/api/diary")
  rm -f /root/.maowo-checkup.json
  [ "$code" = 200 ] && echo "已发成小秘密帖子「服务器体检结果」，只有你和小55能看。" || echo "发帖失败（$code）"
fi
