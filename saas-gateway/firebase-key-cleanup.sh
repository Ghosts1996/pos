#!/bin/bash
# Ключ Firebase (Google, США) больше не нужен — убираем его сами.
# Сервер (задание firebase-exit в server.js) удаляет старую копию данных и
# учётные записи из Google и, когда там пусто, пишет
# /opt/saas-gateway/state/firebase-exit.json с "done": true. Тогда этот скрипт
# (его вызывают сторож self-heal.sh и update-server.sh) удаляет из настроек
# только строки с ключами Firebase платформы и перезапускает службы.
# Файлы настроек целиком не читаются и не печатаются; ключ hoocah-pos
# (FIREBASE_SERVICE_ACCOUNT_B64 в /etc/pii-gateway.env) — другой проект, не трогаем.
set -u
MARK="${FIREBASE_EXIT_MARK:-/opt/saas-gateway/state/firebase-exit.json}"
SAAS_ENV="${SAAS_ENV_FILE:-/etc/saas-gateway.env}"
PII_ENV="${PII_ENV_FILE:-/etc/pii-gateway.env}"
log() { echo "$(date '+%F %T') $*"; }

[[ -f "$MARK" ]] && grep -Eq '"done":[[:space:]]*true' "$MARK" || exit 0

drop() { # файл, имя переменной → 0, если строка была и удалена
  local f="$1" key="$2"
  [[ -f "$f" ]] || return 1
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$f" || return 1
  sed -i -E "/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=/d" "$f"
}

saas=0; pii=0
drop "$SAAS_ENV" FIREBASE_SERVICE_ACCOUNT_B64 && saas=1
drop "$SAAS_ENV" FIREBASE_WEB_CONFIG_JSON && saas=1
drop "$SAAS_ENV" GOOGLE_APPLICATION_CREDENTIALS && saas=1
drop "$PII_ENV" SAAS_FIREBASE_SERVICE_ACCOUNT_B64 && pii=1

if (( saas )); then
  log "Firebase: в Google пусто — ключ Firebase убран из $SAAS_ENV, перезапускаю saas-gateway"
  [[ "${NO_RESTART:-}" == "1" ]] || systemctl restart saas-gateway || log "!! saas-gateway не перезапустилась: journalctl -u saas-gateway -n 50"
fi
if (( pii )); then
  log "Firebase: ключ проекта платформы убран из $PII_ENV, перезапускаю pii-gateway"
  [[ "${NO_RESTART:-}" == "1" ]] || systemctl restart pii-gateway || log "!! pii-gateway не перезапустилась: journalctl -u pii-gateway -n 50"
fi
exit 0
