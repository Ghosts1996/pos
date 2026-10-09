#!/bin/bash
# Задача 16: какие адреса api.telegram.org доступны с сервера.
set -u
echo "== DNS (v4/v6)"; getent ahostsv4 api.telegram.org | awk '{print $1}' | sort -u; getent ahostsv6 api.telegram.org | awk '{print $1}' | sort -u | head -3
for ip in $(getent ahostsv4 api.telegram.org | awk '{print $1}' | sort -u) 149.154.167.220 149.154.166.110 149.154.167.99; do
  printf "%-16s " "$ip"; curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" -m 8 --resolve "api.telegram.org:443:$ip" https://api.telegram.org/ 2>&1 | tail -1
done
echo "== резолвер"; grep -E "^nameserver" /etc/resolv.conf; resolvectl status 2>/dev/null | grep -E "DNS Servers" | head -2
