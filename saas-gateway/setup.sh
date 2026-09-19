#!/usr/bin/env bash
# Установка saas-gateway на Ubuntu 22.04 (тот же сервер, что и pii-gateway).
# Запускать от root, из директории, куда скопирован этот репозиторий (см.
# README.md) — например /tmp/saas-gateway, НЕ обязательно /root/... (Node
# читает файлы сам, права root's home тут ни при чём, в отличие от Postgres
# в pii-gateway/setup.sh).
set -euo pipefail

echo "== 1/4: Node.js 20 (пропускается, если уже установлен) =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "== 2/4: копирование сервиса в /opt/saas-gateway =="
mkdir -p /opt/saas-gateway
cp -r "$(dirname "$0")"/* /opt/saas-gateway/
cd /opt/saas-gateway
npm install --omit=dev

if ! id saas-gateway >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin saas-gateway
fi
chown -R saas-gateway:saas-gateway /opt/saas-gateway

echo "== 3/4: настройка окружения =="
echo "Вставьте содержимое JSON-ключа сервисного аккаунта Firebase проекта saas-3bdc8"
echo "(ИМЕННО saas-3bdc8, не hoocah-pos!) — Firebase Console -> saas-3bdc8 -> Project"
echo "settings -> Service accounts -> Generate new private key, закодированное в"
echo "base64 одной строкой. Как получить: base64 -w0 файл.json"
read -rp "FIREBASE_SERVICE_ACCOUNT_B64=" FIREBASE_B64

echo
echo "GitHub personal access token (fine-grained) с правами ТОЛЬКО 'Actions:"
echo "read and write' на репозиторий Ghosts1996/pos — создаётся на"
echo "github.com/settings/tokens?type=beta. Нужен, чтобы этот сервис мог сам"
echo "запускать сборку APK (workflow_dispatch)."
read -rsp "GITHUB_PAT=" GITHUB_PAT
echo

echo
echo "Секрет для проверки обратного вызова от GitHub Actions после сборки —"
echo "придумайте случайную строку (например: openssl rand -hex 24) и"
echo "запомните её: то же самое значение нужно будет прописать в GitHub"
echo "как секрет репозитория BUILD_CALLBACK_SECRET."
read -rsp "BUILD_CALLBACK_SECRET=" BUILD_CALLBACK_SECRET
echo

cat > /etc/saas-gateway.env <<ENV
PORT=8081
FIREBASE_SERVICE_ACCOUNT_B64=${FIREBASE_B64}
GITHUB_PAT=${GITHUB_PAT}
BUILD_CALLBACK_SECRET=${BUILD_CALLBACK_SECRET}
ENV
chmod 600 /etc/saas-gateway.env

echo "== 4/4: systemd-сервис =="
cp /opt/saas-gateway/saas-gateway.service /etc/systemd/system/saas-gateway.service
systemctl daemon-reload
systemctl enable --now saas-gateway

sleep 1
echo
echo "Готово. Проверка:"
curl -sS http://127.0.0.1:8081/health && echo
echo "Если выше {\"ok\":true} — сервис работает."
echo
echo "Дальше — добавить в nginx маршрут /saas/ к этому сервису (см. README.md,"
echo "раздел «nginx»), обновить секреты репозитория (SAAS_GATEWAY_URL,"
echo "SAAS_COMPLETE_BUILD_JOB_URL, BUILD_CALLBACK_SECRET) и указать в console.js"
echo "адрес этого сервиса — всё расписано в README.md."
