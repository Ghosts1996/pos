#!/bin/bash
# Проверка состояния сервера — только чтение, ничего не меняет.
set -u
echo "== Службы"
for s in saas-gateway pii-gateway nginx postgresql; do
  printf '%-14s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo нет)"
done
echo "== Версия кода: $(cat /opt/saas-gateway/VERSION 2>/dev/null || echo неизвестна)"
echo "== Откуда сервер берёт код"
url=$(git -C /root/pos-deploy remote get-url origin 2>/dev/null | sed -E 's#//[^@/]+@#//***@#')
echo "origin: ${url:-не найден}"
grep -q '^GITHUB_PAT=.' /etc/saas-gateway.env 2>/dev/null && echo "GITHUB_PAT: задан" || echo "GITHUB_PAT: НЕ задан"
echo "== Диск"
df -h / | tail -1
echo "Готово."
