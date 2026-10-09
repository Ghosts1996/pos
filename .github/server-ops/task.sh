#!/bin/bash
# Задача 17: доступен ли Cloudflare (Workers) с сервера и нет ли замедления.
set -u
for u in https://workers.dev/ https://workers.cloudflare.com/ https://www.cloudflare.com/cdn-cgi/trace; do
  printf "%-45s " "$u"; curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" -m 10 "$u" 2>&1 | tail -1
done
echo "== скачивание 200 КБ (замедление обрывает после ~16 КБ)"
curl -sS -o /dev/null -w "%{http_code} %{size_download} байт %{time_total}s\n" -m 20 "https://speed.cloudflare.com/__down?bytes=200000" 2>&1 | tail -1
echo "== api.telegram.org напрямую (для сравнения)"
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" -m 8 https://api.telegram.org/ 2>&1 | tail -1
