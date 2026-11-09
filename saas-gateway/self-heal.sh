#!/bin/bash
# Сторож сервера ZalPOS — таймер zalpos-heal (update-server.sh), раз в 2 минуты:
#   * saas-gateway / pii-gateway остановились или зависли (два раза подряд
#     не ответили на /health) — перезапуск;
#   * nginx остановлен — запуск, если его настройки исправны (сами
#     настройки не трогаем);
#   * файлы сайта пропали — сайт собирается заново (build-site.sh);
#   * сертификату осталось меньше 14 дней — продление (раз в сутки);
#   * на диске меньше 1 ГБ — чистка журналов systemd и кэша apt;
#   * fail2ban остановился — запуск; порты баз снаружи закрыты (server-shield.sh).
# Пока идёт обновление сервера, сторож ничего не делает. В журнал
# (/var/log/zalpos-heal.log) пишет только то, что сделал или заметил.
set -u
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE=/var/lib/zalpos-heal
mkdir -p "$STATE"
log() { echo "$(date '+%F %T') $*"; }

# Идёт обновление (оно само перезапускает службы) — не мешаем.
if pgrep -f "update-server.sh" >/dev/null 2>&1 || pgrep -f "move-site-to-server.sh" >/dev/null 2>&1; then
  exit 0
fi

# Порт, который слушает главный процесс службы (без чтения её настроек).
port_of() {
  local pid
  pid="$(systemctl show -p MainPID --value "$1" 2>/dev/null)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  ss -ltnpH 2>/dev/null | grep "pid=$pid," | awk '{print $4}' | sed 's/.*://' | head -1
}

check_service() {
  local svc="$1" fails="$STATE/$1.fails" port n
  systemctl cat "$svc" >/dev/null 2>&1 || return 0
  # Выключена намеренно (не в автозапуске) — не наше дело.
  [[ "$(systemctl is-enabled "$svc" 2>/dev/null)" == "enabled" ]] || return 0
  local st
  st="$(systemctl is-active "$svc" 2>/dev/null)"
  [[ "$st" == "activating" || "$st" == "reloading" || "$st" == "deactivating" ]] && return 0
  if [[ "$st" != "active" ]]; then
    log "$svc не запущена ($st) — запускаю"
    systemctl restart "$svc" || log "!! $svc не запустилась: journalctl -u $svc -n 50"
    echo 0 > "$fails"
    return
  fi
  port="$(port_of "$svc" || true)"
  [[ -n "$port" ]] || return 0
  if curl -fs -o /dev/null --max-time 10 "http://127.0.0.1:$port/health"; then
    echo 0 > "$fails"
    return
  fi
  n=$(( $(cat "$fails" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$fails"
  if (( n >= 2 )); then
    log "$svc не отвечает на /health ($n раза подряд) — перезапускаю"
    systemctl restart "$svc" || log "!! $svc не перезапустилась: journalctl -u $svc -n 50"
    echo 0 > "$fails"
  else
    log "$svc не ответил на /health — проверю ещё раз через 2 минуты"
  fi
}

check_service saas-gateway
check_service pii-gateway
check_service fail2ban

# Защита: порты баз закрыты снаружи и после перезагрузки, итог — в сводку
# бота (server-shield.sh --quick; пишет в журнал, только если что-то закрыл).
[[ -f "$REPO/saas-gateway/server-shield.sh" ]] && bash "$REPO/saas-gateway/server-shield.sh" --quick 2>/dev/null

if command -v nginx >/dev/null && ! systemctl is-active --quiet nginx; then
  if nginx -t >/dev/null 2>&1; then
    log "nginx остановлен — запускаю"
    systemctl start nginx || log "!! nginx не запустился: journalctl -u nginx -n 50"
  else
    log "!! nginx остановлен, а его настройки с ошибкой — сам не запускаю: nginx -t"
  fi
fi

# Сайт на этом сервере: главные файлы на месте.
if [[ -d /opt/zalpos-site ]]; then
  if [[ ! -s /opt/zalpos-site/index.html || ! -s /opt/zalpos-site/console.js ]]; then
    log "файлы сайта пропали — собираю заново"
    bash "$REPO/saas-gateway/build-site.sh" /opt/zalpos-site >/dev/null 2>&1 \
      && log "ok: сайт собран" || log "!! сайт не собрался: bash $REPO/saas-gateway/build-site.sh /opt/zalpos-site"
  fi
fi

# Сертификаты: меньше 14 дней — продление, не чаще раза в сутки.
if command -v openssl >/dev/null && command -v certbot >/dev/null; then
  soon=""
  for c in /etc/letsencrypt/live/*/cert.pem; do
    [[ -f "$c" ]] || continue
    openssl x509 -checkend $((14 * 86400)) -noout -in "$c" >/dev/null 2>&1 || soon="$soon $(basename "$(dirname "$c")")"
  done
  stamp="$STATE/renew.day"
  if [[ -n "$soon" && "$(cat "$stamp" 2>/dev/null)" != "$(date +%F)" ]]; then
    date +%F > "$stamp"
    log "сертификаты скоро истекают:$soon — продлеваю"
    if certbot renew --quiet; then log "ok: продление прошло"; else log "!! продление не прошло: /var/log/letsencrypt/letsencrypt.log"; fi
  fi
fi

# Место на диске.
free_mb="$(df -Pm / | awk 'NR==2{print $4}')"
if [[ "$free_mb" =~ ^[0-9]+$ ]] && (( free_mb < 1024 )); then
  log "на диске свободно ${free_mb} МБ — чищу журналы systemd и кэш apt"
  journalctl --vacuum-size=200M >/dev/null 2>&1 || true
  apt-get clean >/dev/null 2>&1 || true
  log "свободно теперь $(df -Pm / | awk 'NR==2{print $4}') МБ"
fi
exit 0
