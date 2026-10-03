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

# Полный диск роняет Postgres и не даёт обновиться. Если свободно меньше
# 1 ГБ, чистим то, что безопасно удалять (кэши apt и npm, старые журналы
# systemd), и печатаем, что занимает место, — разбор виден в логе.
say "Место на диске"
free_mb() { df -Pm / | awk 'NR==2 {print $4}'; }
echo "свободно: $(free_mb) МБ"
if (( $(free_mb) < 1024 )); then
  echo "меньше 1 ГБ — чищу кэши apt и npm и журналы старше недели"
  apt-get clean >/dev/null 2>&1 || true
  journalctl --vacuum-time=7d --vacuum-size=300M >/dev/null 2>&1 || true
  npm cache clean --force >/dev/null 2>&1 || true
  echo "после уборки свободно: $(free_mb) МБ"
  echo "крупнее всего:"
  du -xhd1 / 2>/dev/null | sort -rh | head -n 10 || true
  du -xhd1 /opt /var /root /home /var/lib /var/log 2>/dev/null | sort -rh | head -n 25 || true
  du -xhd1 /opt/saas-gateway/tenant-builds 2>/dev/null | sort -rh | head -n 15 || true
  ls -la /swapfile /swap.img 2>/dev/null || true
fi

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

if [[ -d /opt/pii-gateway ]]; then
  say "pii-gateway (данные в РФ)"
  rsync -a --exclude node_modules "$REPO/pii-gateway/" /opt/pii-gateway/
  (cd /opt/pii-gateway && npm install --omit=dev --no-audit --no-fund >/dev/null)
  chown -R pii-gateway:pii-gateway /opt/pii-gateway
  # База должна отвечать до применения схемы. Если Postgres остановился
  # (перезагрузка, нехватка памяти), поднимаем его; не вышло — причина
  # будет прямо в логе обновления.
  if ! pg_isready -q; then
    echo "Postgres не отвечает — запускаю"
    systemctl start postgresql || true
    pg_lsclusters -h 2>/dev/null | while read -r ver name _ status _; do
      [[ "$status" == online* ]] || pg_ctlcluster "$ver" "$name" start || true
    done || true
    for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
    if ! pg_isready -q; then
      pg_lsclusters 2>&1 || true
      systemctl --no-pager --full status 'postgresql*' 2>&1 | tail -n 40 || true
      df -h / /var/lib/postgresql 2>&1 || true
      free -m 2>&1 || true
      die "Postgres не запустился — причина выше. Вручную: systemctl start postgresql; journalctl -u 'postgresql*' -n 50"
    fi
    echo "Postgres запущен"
  fi
  (cd / && sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pii_gateway -f /opt/pii-gateway/schema.sql)
  systemctl restart pii-gateway
  sleep 2
  systemctl is-active --quiet pii-gateway || die "pii-gateway не запустился — посмотрите: journalctl -u pii-gateway -n 50"
  echo "ok"
fi

echo
echo "Готово. Проверка: curl -s https://pii.zalpos.ru/saas/health"
