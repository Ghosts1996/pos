#!/bin/bash
# Переезд платформы с hookahpos.su на zalpos.ru. Запуск один раз, от root:
#
#   bash /root/pos-deploy/saas-gateway/migrate-domain.sh
#
# Повторный запуск безопасен: сделанные шаги пропускаются.
# Старый домен продолжает работать:
#  - pii.hookahpos.su отвечает как раньше — через него работают уже
#    установленные кассы и гостевые приложения;
#  - {slug}.hookahpos.su перенаправляет на {slug}.zalpos.ru — QR-коды,
#    уже наклеенные на столы, открывают новый адрес.
set -euo pipefail

NEW="zalpos.ru"
OLD="hookahpos.su"
OLD_RE='hookahpos\.su'
NEW_RE='zalpos\.ru'
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="/root/nginx-backup-$(date +%Y%m%d-%H%M%S)"

say() { echo; echo "== $*"; }
die() { echo; echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запустите от root"

say "1/9 Проверяю DNS"
IP="$(curl -s4 --max-time 5 https://ifconfig.me || true)"
[[ "$IP" =~ ^[0-9.]+$ ]] || IP="$(hostname -I | awk '{print $1}')"
for h in "pii.$NEW" "dns-check.$NEW"; do
  got="$(getent ahostsv4 "$h" | awk 'NR==1{print $1}' || true)"
  [[ "$got" == "$IP" ]] || die "$h указывает на '${got:-ничего}', а этот сервер — $IP.
У регистратора домена $NEW добавьте две A-записи:
    pii  →  $IP
    *    →  $IP
и запустите скрипт снова через 15–30 минут."
done
echo "ok: pii.$NEW и *.$NEW указывают на этот сервер ($IP)"

mkdir -p "$BACKUP"
cp -a /etc/nginx/conf.d "$BACKUP/"
echo "копия настроек nginx: $BACKUP"

say "2/9 pii.$NEW — тот же сервис, что pii.$OLD"
PII_CONF="$(grep -lE "server_name[^;]*pii\.$OLD_RE" /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | head -1 || true)"
[[ -n "$PII_CONF" ]] || die "не нашёл настройку nginx с server_name pii.$OLD"
if ! grep -qE "server_name[^;]*pii\.$NEW_RE" "$PII_CONF"; then
  sed -i -E "s/(server_name[^;]*pii\.$OLD_RE)/\1 pii.$NEW/" "$PII_CONF"
fi
nginx -t
systemctl reload nginx
certbot --nginx --cert-name "pii.$OLD" -d "pii.$OLD" -d "pii.$NEW" \
  --expand --redirect --non-interactive --agree-tos
curl -sS --max-time 15 -o /dev/null "https://pii.$NEW/" || die "https://pii.$NEW не открывается"
echo "ok: https://pii.$NEW работает"

say "3/9 Проверка сертификатов для поддоменов обоих доменов (порт 80)"
cat > /etc/nginx/conf.d/saas-guest-wildcard-http.conf << 'NGINXEOF'
server {
    listen 80;
    listen [::]:80;
    server_name ~^(?<tenant_slug>.+)\.(hookahpos\.su|zalpos\.ru)$;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
NGINXEOF
nginx -t
systemctl reload nginx

say "4/9 www.$NEW → $NEW"
got="$(getent ahostsv4 "www.$NEW" | awk 'NR==1{print $1}' || true)"
if [[ "$got" == "$IP" ]]; then
  # Порт 80 для www уже обслуживает общий блок выше (проверка certbot).
  if ! certbot certonly --webroot -w /var/www/certbot --cert-name "www.$NEW" -d "www.$NEW" \
    --keep-until-expiring --non-interactive --agree-tos -m "admin@$NEW"; then
    echo "!! сертификат для www.$NEW не выпущен — остальное продолжаю, повторите скрипт позже"
  else
  cat > /etc/nginx/conf.d/www-redirect.conf << CONFEOF
# www.$NEW — перенаправление на $NEW (сам сайт на Firebase Hosting).
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.$NEW;

    ssl_certificate     /etc/letsencrypt/live/www.$NEW/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/www.$NEW/privkey.pem;

    return 301 https://$NEW\$request_uri;
}
CONFEOF
  nginx -t
  systemctl reload nginx
  echo "ok: https://www.$NEW → https://$NEW"
  fi
else
  echo "пропускаю: www.$NEW указывает не на этот сервер"
fi

say "5/9 Поддомены заведений: {код}.$NEW, со старого адреса — перенаправление"
install -m 755 "$REPO/saas-gateway/provision-tenant-domain.sh" /usr/local/bin/provision-tenant-domain.sh
shopt -s nullglob
# Старые настройки заведений переименовываем: они продолжают работать как
# раньше, пока для нового адреса не выпущен сертификат.
for conf in /etc/nginx/conf.d/tenant-*.conf; do
  grep -qE "server_name [^;]*\.$OLD_RE;" "$conf" || continue
  slug="$(basename "$conf" .conf)"
  slug="${slug#tenant-}"
  mv "$conf" "/etc/nginx/conf.d/old-tenant-$slug.conf"
done
ok=0
failed=()
for old_conf in /etc/nginx/conf.d/old-tenant-*.conf; do
  grep -q "return 301" "$old_conf" && continue
  slug="$(basename "$old_conf" .conf)"
  slug="${slug#old-tenant-}"
  if /usr/local/bin/provision-tenant-domain.sh "$slug"; then
    certs="$(grep -E '^\s*ssl_certificate(_key)?\s' "$old_conf" || true)"
    if [[ -z "$certs" ]]; then
      certs="    ssl_certificate     /etc/letsencrypt/live/$slug.$OLD/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$slug.$OLD/privkey.pem;"
    fi
    cat > "$old_conf" << CONFEOF
# Прежний адрес заведения — перенаправление на $slug.$NEW (QR-коды на столах).
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $slug.$OLD;
$certs
    return 301 https://$slug.$NEW\$request_uri;
}
CONFEOF
    ok=$((ok + 1))
  else
    failed+=("$slug")
  fi
done
nginx -t
systemctl reload nginx
echo "ok: переведено заведений: $ok"
if (( ${#failed[@]} )); then
  echo "не удалось выпустить сертификат: ${failed[*]}"
  echo "их старые адреса работают как раньше; повторите позже этот же скрипт"
fi

say "6/9 Ссылка на демо-кассу: https://pii.$NEW/downloads/zalpos.apk"
if [[ -d /var/www/downloads ]]; then
  ln -sfn hookah-pos-public.apk /var/www/downloads/zalpos.apk
  echo "ok"
else
  echo "папки /var/www/downloads нет — пропускаю"
fi

say "7/9 Веб-версия гостя"
mkdir -p /opt/saas-guest-web
cp -r "$REPO/saas/guest-web/"* /opt/saas-guest-web/
chown -R www-data:www-data /opt/saas-guest-web
echo "ok"

say "8/9 saas-gateway"
ENVF=/etc/saas-gateway.env
if [[ -f "$ENVF" ]] && grep -q "$OLD_RE" "$ENVF"; then
  cp "$ENVF" "$BACKUP/"
  sed -i "s/$OLD_RE/$NEW/g" "$ENVF"
  echo "в $ENVF старый домен заменён на $NEW"
fi
command -v rsync >/dev/null || apt-get install -y rsync >/dev/null
rsync -a --exclude node_modules "$REPO/saas-gateway/" /opt/saas-gateway/
(cd /opt/saas-gateway && npm install --omit=dev --no-audit --no-fund >/dev/null)
chown -R saas-gateway:saas-gateway /opt/saas-gateway
systemctl restart saas-gateway
sleep 3
systemctl is-active --quiet saas-gateway || die "saas-gateway не запустился — посмотрите: journalctl -u saas-gateway -n 50"
echo "ok"

# pii-gateway (данные в РФ): код, схема базы (новые таблицы — IF NOT EXISTS)
if [[ -d /opt/pii-gateway ]]; then
  echo "pii-gateway: обновляю код и схему базы"
  rsync -a --exclude node_modules "$REPO/pii-gateway/" /opt/pii-gateway/
  (cd /opt/pii-gateway && npm install --omit=dev --no-audit --no-fund >/dev/null)
  chown -R pii-gateway:pii-gateway /opt/pii-gateway
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pii_gateway -f /opt/pii-gateway/schema.sql
  systemctl restart pii-gateway
  sleep 2
  systemctl is-active --quiet pii-gateway || die "pii-gateway не запустился — посмотрите: journalctl -u pii-gateway -n 50"
  echo "ok"
fi

say "9/9 Рекламная страница https://$OLD"
PROMO_HOSTS=()
for h in "$OLD" "www.$OLD"; do
  got="$(getent ahostsv4 "$h" | awk 'NR==1{print $1}' || true)"
  [[ "$got" == "$IP" ]] && PROMO_HOSTS+=("$h")
done
if [[ " ${PROMO_HOSTS[*]} " != *" $OLD "* ]]; then
  echo "пропускаю: $OLD пока указывает не на этот сервер."
  echo "Чтобы на $OLD открывалась рекламная страница: у регистратора $OLD"
  echo "поменяйте A-записи @ и www на $IP (записи pii и * не трогайте),"
  echo "удалите $OLD из Firebase Hosting и запустите этот скрипт ещё раз."
else
  mkdir -p /opt/hookahpos-promo /var/www/certbot
  cp -r "$REPO/saas/promo-hookahpos/"* /opt/hookahpos-promo/
  chown -R www-data:www-data /opt/hookahpos-promo
  PROMO_CONF=/etc/nginx/conf.d/promo-hookahpos.conf
  NAMES="${PROMO_HOSTS[*]}"
  HTTP_BLOCK="server {
    listen 80;
    listen [::]:80;
    server_name $NAMES;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$OLD\$request_uri;
    }
}"
  # Пока сертификата нет — только порт 80, иначе nginx не примет 443-блок.
  if [[ ! -f "/etc/letsencrypt/live/$OLD/fullchain.pem" ]]; then
    echo "$HTTP_BLOCK" > "$PROMO_CONF"
    nginx -t
    systemctl reload nginx
  fi
  DARGS=()
  for h in "${PROMO_HOSTS[@]}"; do DARGS+=(-d "$h"); done
  certbot certonly --webroot -w /var/www/certbot --cert-name "$OLD" "${DARGS[@]}" \
    --expand --keep-until-expiring --non-interactive --agree-tos -m "admin@$NEW"
  cat > "$PROMO_CONF" << CONFEOF
# Рекламная страница HookahPOS (saas/promo-hookahpos/) — ведёт на $NEW.
$HTTP_BLOCK

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $NAMES;

    ssl_certificate     /etc/letsencrypt/live/$OLD/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$OLD/privkey.pem;

    if (\$host != $OLD) {
        return 301 https://$OLD\$request_uri;
    }

    root /opt/hookahpos-promo;
    error_page 404 /index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location ~* \.html\$ {
        add_header Cache-Control "no-cache";
    }
}
CONFEOF
  nginx -t
  systemctl reload nginx
  echo "ok: https://$OLD"
fi

echo
echo "Готово. Платформа работает на $NEW."
echo "Прежние адреса: pii.$OLD — для ещё не обновлённых приложений, {код}.$OLD — перенаправление для QR-кодов на столах."
