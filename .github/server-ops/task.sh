#!/bin/bash
# Диагностика «сайт крутит загрузку» — только чтение, ничего не меняет.
set -u
echo "== Службы"
for s in saas-gateway nginx pii-gateway; do
  printf '%-14s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo нет)"
done
echo "== Версия кода: $(cat /opt/saas-gateway/VERSION 2>/dev/null || echo неизвестна)"
echo "== Нагрузка: $(cat /proc/loadavg)"
free -m | head -2

t() { curl -s -o /dev/null --max-time 25 -w "%{http_code} dns=%{time_namelookup} tls=%{time_appconnect} ttfb=%{time_starttransfer} всего=%{time_total} размер=%{size_download} ip=%{remote_ip}\n" "$@"; }
echo "== Сайт и API снаружи (по домену)"
for u in https://zalpos.ru/ https://zalpos.ru/console.js https://zalpos.ru/zal-db.js https://zalpos.ru/zal-auth.js \
         https://pii.zalpos.ru/saas/health https://pii.zalpos.ru/saas/db/status https://pii.zalpos.ru/saas/auth/status; do
  printf '%-45s ' "$u"; t -H 'Accept-Encoding: gzip' "$u"
done
echo "== Заголовки console.js"
curl -s -D - -o /dev/null --max-time 20 -H 'Accept-Encoding: gzip' https://zalpos.ru/console.js | grep -i -E "^HTTP|content-(type|encoding|length)|cache-control|etag|last-modified"
echo "== Первые строки index.html (есть ли текст лендинга)"
curl -s --max-time 20 https://zalpos.ru/ | grep -c 'id="prerender"'
curl -s --max-time 20 https://zalpos.ru/ | grep -o '<script[^>]*src="[^"]*"' | head
echo "== Синтаксис console.js на сервере"
node --check /opt/zalpos-site/console.js 2>&1 | tail -3 || true
ls -la /opt/zalpos-site/console.js /opt/zalpos-site/zal-db.js /opt/zalpos-site/index.html 2>&1
grep -c "Promise.resolve().then(boot)" /opt/zalpos-site/console.js
echo "== OPTIONS и POST к API (как браузер)"
curl -s -o /dev/null -X OPTIONS --max-time 15 -w "OPTIONS /db/session %{http_code} %{time_total}s\n" \
  -H 'Origin: https://zalpos.ru' -H 'Access-Control-Request-Method: POST' https://pii.zalpos.ru/saas/db/session
curl -s --max-time 15 -w "\nPOST /db/session без входа %{http_code} %{time_total}s\n" -X POST -H 'Content-Type: application/json' \
  -H 'Origin: https://zalpos.ru' -d '{}' https://pii.zalpos.ru/saas/db/session | head -c 200
echo "== Ошибки nginx за 2 часа"
for f in /var/log/nginx/error.log; do [ -f "$f" ] && tail -n 300 "$f" | awk -v d="$(date -d '-2 hour' '+%Y/%m/%d %H:%M')" '$1" "$2 >= d' | tail -25; done
echo "== Журнал saas-gateway за 30 минут: ошибки"
journalctl -u saas-gateway --since "-30min" --no-pager 2>/dev/null \
  | grep -i -E "error|ошиб|exception|uncaught|listen|data-server|EADDR|crash" \
  | grep -v -E "^\s+at " \
  | grep -v -i -E "bearer|secret|password|key=|token" | tail -40
echo "== Перезапуски saas-gateway за 2 часа: $(journalctl -u saas-gateway --since '-2h' --no-pager 2>/dev/null | grep -c -E 'Started|listening')"
echo "Готово."
