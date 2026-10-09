#!/bin/bash
# Задача 12: ключ шифрования токенов Telegram-ботов заведений.
# Создаётся один раз (если его ещё нет) в /etc/saas-gateway.env — на экран
# не выводится. Потеря ключа = все токены ботов придётся ввести заново,
# поэтому существующий ключ никогда не перезаписываем.
set -u
ENV=/etc/saas-gateway.env
if grep -q '^TELEGRAM_SECRET_KEY=' "$ENV"; then
  echo "TELEGRAM_SECRET_KEY уже есть — не трогаю"
else
  printf '\nTELEGRAM_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ENV"
  chmod 600 "$ENV"
  echo "TELEGRAM_SECRET_KEY создан"
  systemctl restart saas-gateway && sleep 3
fi
systemctl is-active saas-gateway
curl -s -o /dev/null -w "gateway health: %{http_code}\n" -m 10 https://pii.zalpos.ru/saas/health
# Резервная копия ключа рядом с бэкапами базы (только root).
mkdir -p /root/backups && grep '^TELEGRAM_SECRET_KEY=' "$ENV" > /root/backups/telegram-secret-key.env && chmod 600 /root/backups/telegram-secret-key.env
echo "копия ключа: /root/backups/telegram-secret-key.env"
