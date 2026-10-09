#!/bin/bash
# Задача 15: убрать остаток удалённого VPN-ретранслятора из /etc/hosts —
# строка «127.0.0.1 api.telegram.org» заворачивала Telegram на сам сервер,
# где ретранслятора уже нет. Копия файла — /root/hosts.bak-telegram.
set -u
cp -p /etc/hosts /root/hosts.bak-telegram
sed -i '/^[[:space:]]*127\.0\.0\.1[[:space:]]\+api\.telegram\.org[[:space:]]*$/d' /etc/hosts
echo "== telegram в /etc/hosts:"; grep -i telegram /etc/hosts || echo "нет записей"
echo "== проверка"
curl -sS -o /dev/null -w "api.telegram.org: %{http_code} за %{time_total}s\n" -m 15 https://api.telegram.org/ 2>&1 | head -2
systemctl restart saas-gateway && sleep 3 && systemctl is-active saas-gateway
curl -s -o /dev/null -w "gateway health: %{http_code}\n" -m 10 https://pii.zalpos.ru/saas/health
