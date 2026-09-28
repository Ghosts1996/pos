#!/bin/bash
# Сертификат Let's Encrypt и 443-блок nginx для поддомена заведения
# {slug}.zalpos.ru (веб-версия гостя и страница QR стола, см. saas/guest-web/).
#
# Вызывает saas-gateway при создании заведения (provisionTenantDomain в
# server.js, через точечное sudo-правило) и migrate-domain.sh при переезде.
# Ставится так: install -m 755 provision-tenant-domain.sh /usr/local/bin/
set -euo pipefail

BASE_DOMAIN="zalpos.ru"

SLUG="${1:-}"
[[ "$SLUG" =~ ^[a-z0-9-]{1,63}$ ]] || { echo "bad slug: $SLUG" >&2; exit 1; }

DOMAIN="$SLUG.$BASE_DOMAIN"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
CONF="/etc/nginx/conf.d/tenant-$SLUG.conf"

if [[ -d "$CERT_DIR" ]] && grep -q "server_name $DOMAIN;" "$CONF" 2>/dev/null; then
  echo "already provisioned: $DOMAIN"
  exit 0
fi

mkdir -p /var/www/certbot

if [[ ! -d "$CERT_DIR" ]]; then
  certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" \
    --non-interactive --agree-tos \
    -m "admin@$BASE_DOMAIN" \
    --keep-until-expiring
fi

cat > "$CONF" << CONFEOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    root /opt/saas-guest-web;

    # Без этого мобильные браузеры подолгу кэшируют html/js, и правки на
    # сервере не видны гостю, пока он не почистит кэш.
    location ~* \.(html|js)$ {
        add_header Cache-Control "no-cache";
    }

    location /table/ {
        try_files /table.html =404;
    }

    location /app/ {
        try_files \$uri \$uri/ /app/index.html;
    }

    location = / {
        return 404;
    }
}
CONFEOF

nginx -t
systemctl reload nginx
echo "provisioned: $DOMAIN"
