#!/bin/bash
# Обычное обновление сервера после изменений в коде (от root):
#
#   bash /root/pos-deploy/saas-gateway/update-server.sh
#
# Что делает: веб-версия гостя, saas-gateway (новое демо, оплаты и т.п.),
# pii-gateway со схемой базы, сайт zalpos.ru (Firebase Hosting — если на
# сервере есть вошедший firebase CLI). Сертификаты и nginx не трогает —
# это делает migrate-domain.sh, его хватило запустить один раз.
# То же самое делает автообновление (auto-deploy.sh) после каждого пуша.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
say() { echo; echo "== $*"; }
die() { echo; echo "ОШИБКА: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "запустите от root"

say "Веб-версия гостя"
mkdir -p /opt/saas-guest-web
cp -r "$REPO/saas/guest-web/"* /opt/saas-guest-web/
chown -R www-data:www-data /opt/saas-guest-web
echo "ok"

say "saas-gateway"
command -v rsync >/dev/null || apt-get install -y rsync >/dev/null
rsync -a --exclude node_modules "$REPO/saas-gateway/" /opt/saas-gateway/
git -C "$REPO" rev-parse --short HEAD > /opt/saas-gateway/VERSION 2>/dev/null || true
(cd /opt/saas-gateway && npm install --omit=dev --no-audit --no-fund >/dev/null)
chown -R saas-gateway:saas-gateway /opt/saas-gateway
systemctl restart saas-gateway
sleep 3
systemctl is-active --quiet saas-gateway || die "saas-gateway не запустился — посмотрите: journalctl -u saas-gateway -n 50"
echo "ok, версия $(cat /opt/saas-gateway/VERSION 2>/dev/null || echo '?')"

if [[ -d /opt/pii-gateway ]]; then
  say "pii-gateway (данные в РФ)"
  rsync -a --exclude node_modules "$REPO/pii-gateway/" /opt/pii-gateway/
  (cd /opt/pii-gateway && npm install --omit=dev --no-audit --no-fund >/dev/null)
  chown -R pii-gateway:pii-gateway /opt/pii-gateway
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pii_gateway -f /opt/pii-gateway/schema.sql
  systemctl restart pii-gateway
  sleep 2
  systemctl is-active --quiet pii-gateway || die "pii-gateway не запустился — посмотрите: journalctl -u pii-gateway -n 50"
  echo "ok"
fi

say "Сайт zalpos.ru (Firebase Hosting), правила и индексы базы"
if command -v firebase >/dev/null; then
  if (cd "$REPO/saas" && firebase deploy --only hosting,firestore --non-interactive); then
    echo "ok"
  else
    echo "не вышло — выполните вручную: cd $REPO/saas && firebase login && firebase deploy --only hosting,firestore"
  fi
else
  echo "firebase CLI на сервере нет — сайт обновите вручную: cd $REPO/saas && firebase deploy --only hosting,firestore"
fi

echo
echo "Готово. Проверка: curl -s https://pii.zalpos.ru/saas/health"
