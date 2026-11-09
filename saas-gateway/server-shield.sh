#!/bin/bash
# Защита самого сервера ZalPOS (от root). Запускает update-server.sh при
# каждом обновлении; можно и вручную:
#
#   bash /root/pos-deploy/saas-gateway/server-shield.sh
#
# Что делает (повторный запуск ничего не ломает):
#   * fail2ban: адрес, который подбирает вход по SSH, закрывается на час
#     (повторно — дольше, до суток);
#   * обновления безопасности Ubuntu ставятся сами, раз в сутки в 10:30 по
#     времени сервера (06:30 МСК), без перезагрузки;
#   * сетевые настройки ядра против подмены адресов и SYN-флуда;
#   * папки с данными, паролями и резервными копиями ZalPOS — только для
#     службы saas-gateway (другие программы на сервере их не прочитают),
#     файлы настроек с ключами — только для root;
#   * порты баз данных и служб, открытые наружу, закрываются на внешнем
#     интерфейсе (с самого сервера и из Docker они работают как раньше).
#
# Что НЕ делает: не трогает nginx, Docker и вход по SSH (настройки sshd
# только читает) — доступ к серверу и обновления не пропадут.
# В журнал — только итог, без адресов и ключей (журнал обновлений публичный).
#
#   --quick — только порты и итог в status.json (сторож, раз в 2 минуты).
set -u
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# needrestart при установке пакетов молчит: службы (nginx, базы) не перезапускаются.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
[[ $EUID -eq 0 ]] || { echo "запустите от root"; exit 1; }

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1
STATE=/var/lib/zalpos-shield
mkdir -p "$STATE"
chmod 755 "$STATE"
say() { [[ $QUICK -eq 1 ]] || echo "$*"; }

APT=(apt-get -y -q -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
need_pkgs() {
  local missing=()
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  say "ставлю: ${missing[*]}"
  "${APT[@]}" install "${missing[@]}" >/dev/null 2>&1 && return 0
  "${APT[@]}" update >/dev/null 2>&1 || true
  "${APT[@]}" install "${missing[@]}" >/dev/null 2>&1
}

# ---------------------------------------------------------------- ядро
if [[ $QUICK -eq 0 ]]; then
  cat > /etc/sysctl.d/90-zalpos-shield.conf <<'CONF'
# Создано server-shield.sh (ZalPOS): защита сетевого стека.
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
CONF
  if sysctl -q -p /etc/sysctl.d/90-zalpos-shield.conf >/dev/null 2>&1; then
    say "ok: сетевые настройки ядра"
  else
    say "!! часть настроек ядра не применилась (контейнер VPS?) — не страшно"
  fi
fi

# ---------------------------------------------------------------- права на данные
if [[ $QUICK -eq 0 ]]; then
  for d in /opt/saas-gateway/state /opt/saas-gateway/backups /opt/saas-gateway/support-uploads; do
    [[ -d "$d" ]] || continue
    owner="$(stat -c %U "$d" 2>/dev/null || true)"
    [[ "$owner" == "saas-gateway" ]] || continue
    chmod 700 "$d"
  done
  for f in /etc/saas-gateway.env /etc/pii-gateway.env /etc/zalpos-offsite.env; do
    [[ -f "$f" && "$(stat -c %U "$f" 2>/dev/null)" == "root" ]] && chmod 600 "$f"
  done
  say "ok: данные ZalPOS доступны только его службам"
fi

# ---------------------------------------------------------------- fail2ban
ssh_ports="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -u | paste -sd, -)"
[[ -n "$ssh_ports" ]] || ssh_ports=22
if [[ $QUICK -eq 0 ]]; then
  if need_pkgs fail2ban python3-systemd; then
    jail=/etc/fail2ban/jail.d/zalpos.local
    new="$(cat <<JAIL
# Создано server-shield.sh (ZalPOS): подбор входа по SSH — бан адреса.
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
bantime.increment = true
bantime.maxtime = 1d
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
backend = systemd
port = $ssh_ports
JAIL
)"
    changed=0
    if [[ "$(cat "$jail" 2>/dev/null)" != "$new" ]]; then
      printf '%s\n' "$new" > "$jail"
      changed=1
    fi
    if ! fail2ban-client -t >/dev/null 2>&1; then
      # Настройки не прошли проверку — убираем свои, fail2ban на своих.
      rm -f "$jail"
      say "!! настройки fail2ban не прошли проверку — оставил стандартные"
      changed=1
    fi
    systemctl enable fail2ban >/dev/null 2>&1 || true
    if [[ $changed -eq 1 ]] || ! systemctl is-active --quiet fail2ban; then
      systemctl restart fail2ban >/dev/null 2>&1 || true
      sleep 2
    fi
    if systemctl is-active --quiet fail2ban; then say "ok: fail2ban работает (SSH, порт $ssh_ports)"; else say "!! fail2ban не запустился: journalctl -u fail2ban -n 30"; fi
  else
    say "!! fail2ban не установился (нет доступа к репозиторию Ubuntu?) — повторю при следующем обновлении"
  fi
fi

# ---------------------------------------------------------------- обновления безопасности
if [[ $QUICK -eq 0 ]]; then
  if need_pkgs unattended-upgrades; then
    cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
// Создано server-shield.sh (ZalPOS): каждый день — списки пакетов и обновления безопасности.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
    cat > /etc/apt/apt.conf.d/52zalpos-unattended <<'CONF'
// Создано server-shield.sh (ZalPOS): только обновления безопасности Ubuntu
// (Docker, Node.js и прочие сторонние репозитории не трогаются), без перезагрузки.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::MinimalSteps "true";
CONF
    # Время — тихое для заведений: 10:30 по времени сервера (06:30 МСК).
    mkdir -p /etc/systemd/system/apt-daily-upgrade.timer.d
    cat > /etc/systemd/system/apt-daily-upgrade.timer.d/zalpos.conf <<'CONF'
# Создано server-shield.sh (ZalPOS): обновления безопасности в тихое время.
[Timer]
OnCalendar=
OnCalendar=*-*-* 10:30
RandomizedDelaySec=20m
CONF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
    say "ok: обновления безопасности ставятся сами (10:30 по времени сервера)"
  else
    say "!! unattended-upgrades не установился — повторю при следующем обновлении"
  fi
fi

# ---------------------------------------------------------------- порты наружу
# Базы и внутренние службы не должны быть видны из интернета. Закрываем их
# только на внешнем интерфейсе: с самого сервера и из контейнеров — как раньше.
# Порты, опубликованные Docker, не трогаем (это чужие программы) — только
# показываем в сводке. Список: базы данных, API Docker и внутренние службы
# ZalPOS (pii-gateway, saas-gateway).
PORTS_RE='^(5432|3306|33060|6379|27017|27018|9200|9300|11211|5984|2375|2376|8080|8081)$'
ext_if="$(ip -o route show default 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") {print $(i + 1); exit}}')"
host_open=()
docker_open=()
while read -r local proc; do
  addr="${local%:*}"
  port="${local##*:}"
  [[ "$port" =~ $PORTS_RE ]] || continue
  case "$addr" in
    127.*|"[::1]"|"::1") continue ;;
  esac
  if [[ "$proc" == *docker-proxy* ]]; then docker_open+=("$port"); else host_open+=("$port"); fi
done < <(ss -ltnpH 2>/dev/null | awk '{print $4, $6}')

fw_rules=0
fw_closed=()
if [[ -n "$ext_if" ]] && command -v iptables >/dev/null; then
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null || continue
    # Закрывать нечего и цепочки ещё нет — ничего не создаём.
    if [[ ${#host_open[@]} -eq 0 ]] && ! "$ipt" -w -n -L ZALPOS-SHIELD >/dev/null 2>&1; then continue; fi
    "$ipt" -w -N ZALPOS-SHIELD >/dev/null 2>&1 || true
    "$ipt" -w -F ZALPOS-SHIELD >/dev/null 2>&1 || continue
    "$ipt" -w -C INPUT -j ZALPOS-SHIELD >/dev/null 2>&1 || "$ipt" -w -I INPUT 1 -j ZALPOS-SHIELD >/dev/null 2>&1 || continue
    for port in $(printf '%s\n' "${host_open[@]}" | sort -u); do
      [[ -n "$port" ]] || continue
      if "$ipt" -w -A ZALPOS-SHIELD -i "$ext_if" -p tcp --dport "$port" -j DROP >/dev/null 2>&1; then
        fw_rules=$((fw_rules + 1))
        [[ "$ipt" == iptables ]] && fw_closed+=("$port")
      fi
    done
  done
fi
closed="$(printf '%s\n' "${fw_closed[@]}" | sort -u | paste -sd, -)"
# Открытые наружу и не закрытые (Docker или правило не встало) — в сводку.
exposed="$(printf '%s\n' "${docker_open[@]}" "${host_open[@]}" | sort -u | grep -vxF -f <(printf '%s\n' "${fw_closed[@]}" | grep .) | paste -sd, -)"
prev_closed="$(cat "$STATE/closed" 2>/dev/null || true)"
if [[ $QUICK -eq 1 && -n "$closed" && "$closed" != "$prev_closed" ]]; then
  echo "$(date '+%F %T') закрыты снаружи порты: $closed (служба слушала все адреса)"
fi
printf '%s' "$closed" > "$STATE/closed"
if [[ $QUICK -eq 0 ]]; then
  if [[ -n "$closed" ]]; then say "ok: снаружи закрыты порты: $closed"; else say "ok: базы данных наружу не открыты"; fi
  [[ -n "$exposed" ]] && say "!! наружу открыты порты баз: $exposed (программы в Docker или правило не встало) — закройте их в настройках этих программ"
fi

# ---------------------------------------------------------------- итог для сводки
f2b="none"
banned=0
if command -v fail2ban-client >/dev/null; then
  if systemctl is-active --quiet fail2ban; then
    f2b="active"
    banned="$(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/ {gsub(/[^0-9]/, "", $2); print $2}')"
  else
    f2b="off"
  fi
fi
[[ "$banned" =~ ^[0-9]+$ ]] || banned=0
auto="off"
if [[ -f /etc/apt/apt.conf.d/20auto-upgrades ]] && grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades \
   && dpkg -s unattended-upgrades >/dev/null 2>&1; then auto="on"; fi
pw="$(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}')"
case "$pw" in yes) pw=on ;; no) pw=off ;; *) pw=unknown ;; esac
reboot=false
[[ -f /var/run/reboot-required ]] && reboot=true
json_list() { local s="$1"; [[ -z "$s" ]] && { echo "[]"; return; }; echo "[\"${s//,/\",\"}\"]"; }
cat > "$STATE/status.json.tmp" <<JSON
{"at":"$(date -Is)","fail2ban":"$f2b","sshBanned":$banned,"autoUpdates":"$auto","sshPassword":"$pw","closed":$(json_list "$closed"),"exposed":$(json_list "$exposed"),"firewallRules":$fw_rules,"rebootRequired":$reboot}
JSON
mv "$STATE/status.json.tmp" "$STATE/status.json"
chmod 644 "$STATE/status.json"
if [[ $QUICK -eq 0 ]]; then
  [[ "$pw" == "on" ]] && say "!! вход по паролю SSH включён — лучше только по ключу (PasswordAuthentication no)"
  [[ "$reboot" == "true" ]] && say "i: обновления ждут перезагрузки сервера — перезагрузите в тихое время: reboot"
fi
exit 0
