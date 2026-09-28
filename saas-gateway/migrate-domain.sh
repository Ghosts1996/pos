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

say "1/7 Проверяю DNS"
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

say "2/7 pii.$NEW — тот же сервис, что pii.$OLD"
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

say "3/7 Проверка сертификатов для поддоменов обоих доменов (порт 80)"
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

say "4/7 Поддомены заведений: {код}.$NEW, со старого адреса — перенаправление"
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

say "5/7 Ссылка на демо-кассу: https://pii.$NEW/downloads/zalpos.apk"
if [[ -d /var/www/downloads ]]; then
  ln -sfn hookah-pos-public.apk /var/www/downloads/zalpos.apk
  echo "ok"
else
  echo "папки /var/www/downloads нет — пропускаю"
fi

say "6/7 Веб-версия гостя"
mkdir -p /opt/saas-guest-web
cp -r "$REPO/saas/guest-web/"* /opt/saas-guest-web/
chown -R www-data:www-data /opt/saas-guest-web
echo "ok"

say "7/7 saas-gateway"
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

echo
echo "Готово. Сервер отвечает и на $NEW, и на $OLD."
