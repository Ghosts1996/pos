#!/bin/bash
# Задача 10: безопасные настройки по итогам аудита.
# nginx: скрыть версию, только TLS 1.2/1.3, заголовки безопасности.
# SSH: выключить X11 (не нужен). Вход по паролю не трогаем.
# Любая ошибка проверки nginx — откат.
set -u
cp -p /etc/nginx/nginx.conf /root/nginx.conf.bak-audit
sed -i 's/^\(\s*\)#\s*server_tokens off;/\1server_tokens off;/' /etc/nginx/nginx.conf
sed -i 's/^\(\s*\)ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;.*/\1ssl_protocols TLSv1.2 TLSv1.3;/' /etc/nginx/nginx.conf
cat > /etc/nginx/conf.d/security-headers.conf <<'H'
# Заголовки безопасности для всех сайтов (ZalPOS).
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Strict-Transport-Security "max-age=15552000" always;
H
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx && echo "nginx: настройки применены"; rm -f /root/nginx.conf.bak-audit
else
  echo "nginx -t не прошёл — откат:"; nginx -t 2>&1 | tail -3
  cp -p /root/nginx.conf.bak-audit /etc/nginx/nginx.conf; rm -f /etc/nginx/conf.d/security-headers.conf; systemctl reload nginx
fi
sed -i 's/^\s*X11Forwarding yes/X11Forwarding no/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh && echo "ssh: X11 выключен"
echo "== проверка"
curl -sI -m 10 https://zalpos.ru/ | grep -iE "^HTTP|^server:|strict-transport|x-content-type|referrer-policy"
curl -s -o /dev/null -w "pii health: %{http_code}\n" -m 10 https://pii.zalpos.ru/saas/health
