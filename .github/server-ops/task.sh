#!/bin/bash
# Задача 18: Telegram через ретранслятор Cloudflare. Адрес приходит из
# секрета GitHub TELEGRAM_RELAY_URL (через stdin, в журнал не печатается).
# Сначала проверка в обе стороны, и только потом запись в окружение шлюза.
set -u
URL="${TELEGRAM_RELAY_URL%/}"
if ! printf '%s' "$URL" | grep -Eq '^https://[A-Za-z0-9.-]+\.workers\.dev/[A-Za-z0-9_-]{16,}$'; then
  echo "СТОП: секрет TELEGRAM_RELAY_URL не задан или не вида https://<имя>.<аккаунт>.workers.dev/<секрет> (секрет — от 16 латинских букв и цифр)"
  exit 1
fi

echo "== 1. Сервер → ретранслятор → Telegram"
# На выдуманный токен Telegram отвечает 401 — значит, путь до него открыт.
c1=$(curl -sS -o /dev/null -w "%{http_code}" -m 15 "$URL/bot123456:relay-check-not-a-real-token/getMe" 2>/dev/null)
echo "ответ: $c1 (нужно 401)"

echo "== 2. Ретранслятор → наш сервер (как нажатие кнопки в боте)"
# Без подписи наш сервер отвечает 403 — значит, Cloudflare до него достучался.
c2=$(curl -sS -o /dev/null -w "%{http_code}" -m 20 -X POST -H "Content-Type: application/json" -d '{}' "$URL/hook/relay-check" 2>/dev/null)
echo "ответ: $c2 (нужно 403)"

if [ "$c1" != "401" ] || [ "$c2" != "403" ]; then
  case "$c1" in
    404) echo "СТОП: ретранслятор ответил 404 — секрет в адресе не совпадает с RELAY_SECRET в Cloudflare, или в Worker не тот код";;
    000) echo "СТОП: ретранслятор недоступен с сервера — проверьте адрес Worker";;
  esac
  echo "Окружение шлюза не менялось."
  exit 1
fi

ENV=/etc/saas-gateway.env
mkdir -p /root/backups
cp -a "$ENV" "/root/backups/saas-gateway.env.bak-$(date +%Y%m%d%H%M%S)"
tmp=$(mktemp)
grep -vE '^(TELEGRAM_API_BASE|TELEGRAM_HOOK_BASE)=' "$ENV" > "$tmp"
printf 'TELEGRAM_API_BASE=%s\nTELEGRAM_HOOK_BASE=%s/hook\n' "$URL" "$URL" >> "$tmp"
cat "$tmp" > "$ENV"   # cat, а не mv: владелец и права файла остаются прежними
rm -f "$tmp"
echo "== 3. Записано в $ENV (копия в /root/backups), перезапуск шлюза"
systemctl restart saas-gateway
sleep 5
echo "служба: $(systemctl is-active saas-gateway)"
echo "health: $(curl -sS -o /dev/null -w "%{http_code}" -m 10 https://pii.zalpos.ru/saas/health 2>/dev/null)"
echo "== журнал Telegram после перезапуска (токены и адрес скрыты)"
journalctl -u saas-gateway --since "-1min" --no-pager 2>/dev/null | grep -i telegram | tail -10 \
  | sed -E "s#bot[0-9]+:[A-Za-z0-9_-]+#bot***#g; s#https://[A-Za-z0-9.-]+\.workers\.dev/[A-Za-z0-9_-]+#<ретранслятор>#g"
echo "Готово."
