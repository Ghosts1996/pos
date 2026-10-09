#!/bin/bash
# Задача 5: удалить всё, что относится к VPN (по просьбе владельца):
# контейнер 3x-ui и его данные, xray-ru-relay, пересылки casc-23001..23005,
# nginx-прокси подписок на 8088. Сайт, касса и базы не трогаются.
set -u
for u in xray-ru-relay casc-23001 casc-23002 casc-23003 casc-23004 casc-23005; do
  systemctl disable --now $u >/dev/null 2>&1; rm -f /etc/systemd/system/$u.service; echo "убран сервис $u"
done
systemctl daemon-reload; systemctl reset-failed
rm -f /usr/local/bin/xray-relay /etc/xray-ru-relay.json && echo "убраны xray-relay и его настройки"
docker rm -f 3x-ui >/dev/null 2>&1 && echo "удалён контейнер 3x-ui"
docker rmi ghcr.io/mhsanaei/3x-ui:2.4.11 >/dev/null 2>&1 && echo "удалён образ 3x-ui"
rm -rf /opt/3x-ui /root/x-ui.db && echo "удалены данные 3x-ui"
if [ -f /etc/nginx/conf.d/sub-proxy.conf ]; then
  mv /etc/nginx/conf.d/sub-proxy.conf /tmp/sub-proxy.conf.removed
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; rm -f /tmp/sub-proxy.conf.removed; echo "убран nginx-прокси 8088"
  else mv /tmp/sub-proxy.conf.removed /etc/nginx/conf.d/sub-proxy.conf; echo "nginx -t не прошёл — прокси 8088 оставлен"; fi
fi
echo "== проверка"
for s in nginx saas-gateway pii-gateway postgresql; do printf '%s: ' $s; systemctl is-active $s; done
ss -tlnp | awk 'NR>1 && $4 !~ /^127\.|^\[::1\]/{print $4, $6}' | sed 's/users:((//;s/,pid.*//'
curl -s -o /dev/null -w "сайт: %{http_code}\n" -m 10 https://zalpos.ru/
docker ps -a --format '{{.Names}}' | sed 's/^/контейнер: /'
df -h / | tail -1
