#!/bin/bash
# Сайт и кабинет zalpos.ru — с Firebase Hosting (серверы Google) на этот
# сервер в РФ. Запуск от root, можно несколько раз (сделанное пропускается):
#
#   bash /root/pos-deploy/saas-gateway/move-site-to-server.sh
#
# Первый запуск собирает сайт и готовит nginx; если домен ещё указывает на
# Firebase — подскажет, какую A-запись поменять у регистратора. Второй
# запуск (через 15–30 минут после смены записи) выпускает сертификат и
# включает https. Дальше сайт обновляется сам вместе с сервером
# (update-server.sh → build-site.sh).
#
# Зачем: посетители и владельцы не ходят на серверы Google (152-ФЗ — без
# трансграничной передачи адресов IP), сайт открывается быстрее — файлы
# отдаются из РФ уже сжатыми, с проверкой свежести вместо повторной загрузки.
set -euo pipefail

SITE="zalpos.ru"
ROOT="/opt/zalpos-site"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONF="/etc/nginx/conf.d/zalpos-site.conf"
WEBROOT="/var/www/certbot"
BACKUP="/root/nginx-backup-$(date +%Y%m%d-%H%M%S)"

say() { echo; echo "== $*"; }
die() { echo; echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запустите от root"
command -v nginx >/dev/null || die "nginx не установлен"
command -v certbot >/dev/null || die "certbot не установлен (apt-get install -y certbot python3-certbot-nginx)"

IP="$(curl -s4 --max-time 5 https://ifconfig.me || true)"
[[ "$IP" =~ ^[0-9.]+$ ]] || IP="$(hostname -I | awk '{print $1}')"

say "1/4 Собираю сайт в $ROOT"
bash "$REPO/saas-gateway/build-site.sh" "$ROOT"

mkdir -p "$BACKUP" "$WEBROOT"
cp -a /etc/nginx/conf.d "$BACKUP/"
echo "копия настроек nginx: $BACKUP"

# Общие настройки: кэш по типу файла (map — на уровне http, имя переменной
# своё, чтобы не пересечься с другими сайтами сервера).
write_conf() {
  local with_tls="$1"
  local ssl_opts=""
  [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] && ssl_opts="    include /etc/letsencrypt/options-ssl-nginx.conf;"
  [[ -f /etc/letsencrypt/ssl-dhparams.pem ]] && ssl_opts="$ssl_opts
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
  {
    cat <<CONFEOF
# Сайт и кабинет $SITE — с этого сервера (создано move-site-to-server.sh).
# Файлы: $ROOT, собирает build-site.sh при каждом обновлении сервера.

map \$uri \$zalpos_site_cache {
    default                                         "no-cache";
    ~*\\.(woff2?|ttf|otf)\$                          "public, max-age=31536000, immutable";
    ~*\\.(png|jpe?g|webp|avif|gif|ico|svg|mp4)\$      "public, max-age=604800";
}

server {
    listen 80;
    listen [::]:80;
    server_name $SITE;
CONFEOF
    if [[ "$with_tls" == "yes" ]]; then
      cat <<CONFEOF

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
    }
    location / {
        return 301 https://$SITE\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $SITE;

    ssl_certificate     /etc/letsencrypt/live/$SITE/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$SITE/privkey.pem;
$ssl_opts
CONFEOF
    fi
    cat <<CONFEOF

    root $ROOT;
    index index.html;
    charset utf-8;
    server_tokens off;
    client_max_body_size 64k;

    # Готовые .gz от build-site.sh; остальное — сжатие на лету.
    gzip_static on;
    gzip on;
    gzip_vary on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/css application/javascript text/javascript application/json image/svg+xml text/xml application/xml text/plain application/manifest+json;

    etag on;
    add_header Cache-Control \$zalpos_site_cache always;
    # Безопасность: только https, тип файла не угадывать, адрес страницы не
    # уходит на чужие сайты, камера и прочее сайту не нужны. Встраивать
    # кабинет можно только себе и в Telegram (мини-приложение менеджера).
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
    add_header Content-Security-Policy "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; object-src 'none'; base-uri 'self'" always;
    add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;

    # Служебные файлы (.git, .env и т. п.) не отдаём, даже если появятся.
    location ~ /\\.(?!well-known/) {
        return 404;
    }
    location ~* \\.(sh|sql|bak|orig|log|env|ini|conf|map)\$ {
        return 404;
    }

    # Старый адрес статьи — как в firebase.json.
    location ~ ^/blog/alternativa-iiko-dlya-nebolshogo-kafe(/.*)?\$ {
        return 301 /blog/alternativa-iiko/;
    }

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
    }

    # Обычная раздача файлов: папка без «/» — перенаправление на «/»
    # (как у Firebase Hosting), в папке — index.html, нет файла — 404.
    error_page 404 /404.html;
    location = /404.html {
        internal;
        try_files /404.html /index.html;
    }
}
CONFEOF
  } > "$CONF"
}

say "2/4 nginx: $SITE"
others="$(grep -lE "server_name([^;]*[[:space:]])$SITE([[:space:]]|;)" /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | grep -vxF "$CONF" || true)"
[[ -z "$others" ]] || die "$SITE уже есть в других настройках nginx: $others
Уберите оттуда $SITE (www.$SITE и поддомены не трогайте) и запустите скрипт снова."
if [[ -f "/etc/letsencrypt/live/$SITE/fullchain.pem" ]]; then
  write_conf yes
else
  write_conf no
fi
nginx -t || { cp -a "$BACKUP/conf.d/." /etc/nginx/conf.d/; rm -f "$CONF"; die "nginx не принял настройку — вернул прежнюю"; }
systemctl reload nginx
echo "ok"

say "3/4 DNS"
got4="$(getent ahostsv4 "$SITE" | awk 'NR==1{print $1}' || true)"
got6="$(getent ahostsv6 "$SITE" | awk '$1 ~ /:/ {print $1; exit}' || true)"
if [[ "$got4" != "$IP" ]]; then
  cat <<TXT

Сайт собран и nginx готов. Осталось направить домен на этот сервер.
Сейчас $SITE указывает на '${got4:-ничего}' (Firebase Hosting), а этот сервер — $IP.

У регистратора домена $SITE (раздел DNS):
  1. У записи «@» (сам $SITE) типа A поставьте значение $IP.
     Прочие A-записи для «@» (адреса Firebase) удалите.
  2. Если у «@» есть записи AAAA — удалите их (это адреса Google).
  3. Записи «pii», «*» и «www» не трогайте — они уже на этом сервере.

Через 15–30 минут запустите этот скрипт ещё раз — он выпустит сертификат
и включит https. Пока DNS обновляется, часть посетителей ещё попадает на
Firebase — там та же версия сайта, ничего не сломается.
TXT
  exit 0
fi
[[ -n "$got6" ]] && echo "!! у $SITE есть адрес IPv6 ($got6) — если это адрес Google, удалите запись AAAA у регистратора"
echo "ok: $SITE указывает на этот сервер ($IP)"

say "4/4 Сертификат и https"
if [[ ! -f "/etc/letsencrypt/live/$SITE/fullchain.pem" ]]; then
  certbot certonly --webroot -w "$WEBROOT" --cert-name "$SITE" -d "$SITE" \
    --keep-until-expiring --non-interactive --agree-tos -m "admin@$SITE" \
    || die "сертификат не выпущен — проверьте, что $SITE открывается по http с этого сервера, и повторите"
fi
write_conf yes
nginx -t || { cp -a "$BACKUP/conf.d/." /etc/nginx/conf.d/; die "nginx не принял настройку с https — вернул прежнюю"; }
systemctl reload nginx

# Продление сертификата: certbot сам, nginx перечитывает новый.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$SITE:443:127.0.0.1" "https://$SITE/" || true)"
[[ "$code" == "200" ]] || die "https://$SITE ответил $code — посмотрите: nginx -t; tail /var/log/nginx/error.log"
enc="$(curl -s -o /dev/null -D - --max-time 15 -H 'Accept-Encoding: gzip' --resolve "$SITE:443:127.0.0.1" "https://$SITE/console.js" | grep -i '^content-encoding' || true)"
echo "ok: https://$SITE работает с этого сервера${enc:+ (сжатие: ${enc#*: })}"
cat <<TXT

Готово. Сайт и кабинет $SITE отдаются с этого сервера в РФ.
Обновления сайта — автоматически вместе с сервером.
В консоли Firebase (Hosting) домен $SITE можно удалить: он больше не нужен.
TXT
