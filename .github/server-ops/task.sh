#!/bin/bash
# Диагностика удаления устройства в кабинете — только чтение, ничего не меняет.
set -u
echo "== Службы"
for s in saas-gateway nginx; do
  printf '%-14s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo нет)"
done
echo "== Версия кода: $(cat /opt/saas-gateway/VERSION 2>/dev/null || echo неизвестна)"
grep -c "handleRestoreDevice" /opt/saas-gateway/server.js 2>/dev/null | sed 's/^/restoreDevice в коде сервера: /'
echo "== Ошибки удаления и восстановления устройств за сутки (без токенов)"
journalctl -u saas-gateway --since "-24h" --no-pager 2>/dev/null \
  | grep -E -A12 "saas-gateway /(removeDevice|restoreDevice|setDeviceEnabled)" \
  | grep -v -i -E "bearer|token|secret|password|key=" | tail -80
echo "Готово."
