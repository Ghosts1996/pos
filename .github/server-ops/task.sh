#!/bin/bash
# Диагностика Telegram-бота поддержки — только чтение, ничего не меняет.
set -u
echo "== Службы"
for s in saas-gateway nginx; do
  printf '%-14s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo нет)"
done
echo "== Версия кода: $(cat /opt/saas-gateway/VERSION 2>/dev/null || echo неизвестна)"
echo "== Квота Firestore за 2 часа: $(journalctl -u saas-gateway --since '-2h' --no-pager 2>/dev/null | grep -c -E 'RESOURCE_EXHAUSTED|Quota exceeded')"
echo "== Журнал бота и ошибок за 30 минут (без токенов)"
journalctl -u saas-gateway --since "-30min" --no-pager 2>/dev/null \
  | grep -i -E "telegram|support|tg |bot|error|ошиб|exhaust|quota|warn" \
  | grep -v -E "^\s+at " \
  | sed -E 's#bot[0-9]+:[A-Za-z0-9_-]+#bot***#g' \
  | grep -v -i -E "bearer|secret|password|key=" | tail -60
echo "Готово."
