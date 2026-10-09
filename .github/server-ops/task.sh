#!/bin/bash
# Задача 3: закрыть файл ключей от чтения другими пользователями (как в setup.sh)
# и убрать пустые копии Firestore (0 байт — дни, когда диск был полон).
# Секреты не читаются и не печатаются.
set -u
chmod 600 /etc/saas-gateway.env && ls -l /etc/saas-gateway.env | awk '{print $1, $NF}'
find /opt/saas-gateway/backups -name 'firestore-*.json.gz' -size 0 -print -delete
systemctl is-active saas-gateway pii-gateway
df -h / | tail -1
