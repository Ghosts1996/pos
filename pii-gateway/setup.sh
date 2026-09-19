#!/usr/bin/env bash
# Установка pii-gateway на чистый Ubuntu 22.04: PostgreSQL + Node.js 20 +
# systemd-сервис. Запускать от root на самом сервере (см. README.md).
# TLS/nginx — отдельный шаг, см. README.md (нужен домен, тут его нет).
set -euo pipefail

echo "== 1/6: обновление пакетов и установка PostgreSQL + Node.js 20 =="
apt-get update -y
apt-get install -y postgresql curl
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "== 2/6: создание пользователя и базы Postgres =="
echo "Пароль лучше без кавычек, \$ и обратных слэшей — просто буквы и цифры,"
echo "они ниже подставляются в SQL напрямую."
read -rsp "Придумайте пароль для пользователя базы pii_gateway: " PGPASS
echo
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pii_gateway') THEN
    CREATE ROLE pii_gateway LOGIN PASSWORD '${PGPASS}';
  ELSE
    ALTER ROLE pii_gateway WITH PASSWORD '${PGPASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE pii_gateway OWNER pii_gateway'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pii_gateway')\gexec
SQL

echo "== 3/6: применение схемы =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -d pii_gateway -f "$(dirname "$0")/schema.sql"

echo "== 4/6: копирование сервиса в /opt/pii-gateway =="
mkdir -p /opt/pii-gateway
cp -r "$(dirname "$0")"/* /opt/pii-gateway/
cd /opt/pii-gateway
npm install --omit=dev

if ! id pii-gateway >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin pii-gateway
fi
chown -R pii-gateway:pii-gateway /opt/pii-gateway

echo "== 5/6: настройка окружения =="
echo "Вставьте содержимое JSON-ключа сервисного аккаунта Firebase проекта hoocah-pos"
echo "(Firebase Console -> hoocah-pos -> Project settings -> Service accounts -> Generate new private key),"
echo "закодированное в base64 одной строкой. Как получить: base64 -w0 файл.json"
read -rp "FIREBASE_SERVICE_ACCOUNT_B64=" FIREBASE_B64

cat > /etc/pii-gateway.env <<ENV
PORT=8080
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=pii_gateway
PGUSER=pii_gateway
PGPASSWORD=${PGPASS}
FIREBASE_SERVICE_ACCOUNT_B64=${FIREBASE_B64}
ENV
chmod 600 /etc/pii-gateway.env

echo "== 6/6: systemd-сервис =="
cp /opt/pii-gateway/pii-gateway.service /etc/systemd/system/pii-gateway.service
systemctl daemon-reload
systemctl enable --now pii-gateway

sleep 1
echo
echo "Готово. Проверка:"
curl -sS http://127.0.0.1:8080/health && echo
echo "Если выше {\"ok\":true} — сервис работает. Дальше — nginx + TLS, см. README.md."
