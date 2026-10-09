#!/bin/bash
# Задача 13: проверка Telegram-ботов заведений после выкладки.
set -u
echo "== шлюз"
systemctl is-active saas-gateway
curl -s -o /dev/null -w "tgHook без секрета (ждём 403): %{http_code}\n" -m 10 -X POST https://pii.zalpos.ru/saas/tgHook/test -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w "deliveryAddress с плохой подписью (ждём 403): %{http_code}\n" -m 10 "https://pii.zalpos.ru/saas/deliveryAddress?t=a&s=b&e=1&k=x"
echo "== доступ к Telegram с сервера"
curl -s -o /dev/null -w "api.telegram.org: %{http_code} за %{time_total}s\n" -m 15 https://api.telegram.org/
echo "== ошибки шлюза за 10 минут"
journalctl -u saas-gateway --since "-10 min" --no-pager 2>/dev/null | grep -iE "telegram|error" | grep -viE "token|secret" | tail -10
