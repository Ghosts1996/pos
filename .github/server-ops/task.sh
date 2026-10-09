#!/bin/bash
# Задача 14: почему с сервера нет доступа к api.telegram.org.
set -u
echo "== DNS"; getent ahosts api.telegram.org | head -4
echo "== IPv4"; curl -4 -sS -o /dev/null -w "%{http_code} %{time_total}s\n" -m 15 https://api.telegram.org/ 2>&1 | head -2
echo "== IPv6"; curl -6 -sS -o /dev/null -w "%{http_code} %{time_total}s\n" -m 15 https://api.telegram.org/ 2>&1 | head -2
echo "== по IP 149.154.167.220"; curl -sS -o /dev/null -w "%{http_code}\n" -m 15 --resolve api.telegram.org:443:149.154.167.220 https://api.telegram.org/ 2>&1 | head -2
echo "== прокси в окружении"; env | grep -iE "^(https?|all|no)_proxy=" | sed 's/=.*@/=***@/' || true
echo "== firewall (OUTPUT)"; iptables -S OUTPUT 2>/dev/null | head -10; nft list ruleset 2>/dev/null | grep -iE "149\.154|91\.108|telegram" | head -5
echo "== /etc/hosts"; grep -i telegram /etc/hosts || echo "нет записей"
echo "== для сравнения"; curl -sS -o /dev/null -w "google: %{http_code}\n" -m 10 https://www.google.com/ 2>&1 | head -1
