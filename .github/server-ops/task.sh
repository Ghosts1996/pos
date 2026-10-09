#!/bin/bash
# Задача 19: почему кабинет пишет «Сервер не может достучаться до Telegram».
# Только чтение: ничего не меняет. Токены и адрес ретранслятора скрыты.
set -u
mask() { sed -E "s#bot[0-9]+:[A-Za-z0-9_-]+#bot***#g; s#https://[A-Za-z0-9.-]+\.workers\.dev/[A-Za-z0-9_-]+#<ретранслятор>#g"; }
ENV=/etc/saas-gateway.env

echo "== 1. Настройки шлюза"
for k in TELEGRAM_API_BASE TELEGRAM_HOOK_BASE; do
  if grep -q "^$k=" "$ENV"; then echo "$k: задан ($(grep "^$k=" "$ENV" | cut -d= -f2- | mask))"; else echo "$k: НЕ задан"; fi
done
PID=$(systemctl show -p MainPID --value saas-gateway)
echo "служба: $(systemctl is-active saas-gateway), PID $PID, запущена: $(systemctl show -p ActiveEnterTimestamp --value saas-gateway)"
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  echo "в процессе TELEGRAM_API_BASE: $(tr '\0' '\n' < /proc/$PID/environ | grep -c '^TELEGRAM_API_BASE=') (1 — подхвачен)"
fi

URL=$(grep '^TELEGRAM_API_BASE=' "$ENV" | cut -d= -f2- | tr -d '[:space:]')
echo "== 2. Сервер → ретранслятор → Telegram, 6 попыток (нужно 401)"
for i in 1 2 3 4 5 6; do
  r=$(curl -sS -o /dev/null -w "%{http_code} за %{time_total}с" -m 20 "$URL/bot123456:relay-check-not-a-real-token/getMe" 2>&1 | mask)
  echo "  попытка $i: $r"
  sleep 2
done
echo "== 3. Напрямую api.telegram.org (для сравнения)"
curl -sS -o /dev/null -w "  %{http_code} за %{time_total}с\n" -m 15 https://api.telegram.org/bot123456:x/getMe 2>&1 | mask
echo "== 4. DNS ретранслятора"
host=$(printf '%s' "$URL" | sed -E 's#https://([^/]+)/.*#\1#')
getent ahosts "$host" | awk '{print "  " $1}' | sort -u | head -4
echo "== 5. Журнал шлюза за 12 часов: Telegram"
journalctl -u saas-gateway --since "-12h" --no-pager 2>/dev/null | grep -iE "telegram|tgHook" | tail -25 | mask
echo "Готово."
