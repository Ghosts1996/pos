#!/bin/bash
# Задача 6: проверить, что порт 8088 освобождён после удаления прокси подписок.
set -u
grep -rn "8088" /etc/nginx/ 2>/dev/null || echo "в настройках nginx 8088 нет"
ss -tln | grep -q ':8088 ' && { nginx -t >/dev/null 2>&1 && systemctl restart nginx; sleep 2; }
ss -tln | grep ':8088 ' || echo "порт 8088 закрыт"
printf 'nginx: '; systemctl is-active nginx
curl -s -o /dev/null -w "сайт: %{http_code}\n" -m 10 https://zalpos.ru/
