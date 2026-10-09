#!/bin/bash
# Задача 2: обзор сервера (что где лежит, что пишется) + удаление явного мусора:
# кэши пакетов, сжатые/ротированные журналы, временные файлы старше 7 дней.
# Данные, базы, сборки заведений, Docker и VPN не трогаются.
set -u
echo "== ДО: $(df -h / | tail -1)"

echo "== КРУПНЫЕ ПАПКИ"
du -xh / --max-depth=3 2>/dev/null | sort -rh | head -30

echo "== ЧИСТКА"
apt-get clean; apt-get -y autoremove >/dev/null 2>&1 && echo "apt: кэш и лишние пакеты убраны"
journalctl --vacuum-size=100M 2>&1 | tail -1
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete && echo "старые журналы /var/log убраны"
find /tmp /var/tmp -mindepth 1 -mtime +7 -delete 2>/dev/null; echo "tmp старше 7 дней убраны"
npm cache clean --force >/dev/null 2>&1; rm -rf /root/.cache/* 2>/dev/null; echo "кэши npm/root убраны"
snap list --all 2>/dev/null | awk '/disabled/{print $1, $3}' | while read n r; do snap remove "$n" --revision="$r"; done
echo "== ПОСЛЕ: $(df -h / | tail -1)"

echo "== ЧТО ОСТАЛОСЬ ДЛЯ РЕШЕНИЯ ВЛАДЕЛЬЦА"
echo "-- /root:"; du -sh /root/* /root/.[!.]* 2>/dev/null | sort -rh | head -15
echo "-- /opt:"; du -sh /opt/* 2>/dev/null
echo "-- сборки заведений:"; du -sh /opt/saas-gateway/tenant-builds/* 2>/dev/null | sort -rh | head -15
echo "-- резервные копии gateway:"; ls -lh /opt/saas-gateway/backups 2>/dev/null | tail -8
echo "-- /var/www:"; du -sh /var/www/* 2>/dev/null
echo "-- старые ядра:"; dpkg -l 'linux-image-*' 2>/dev/null | awk '/^ii/{print $2}'; echo "текущее: $(uname -r)"
echo "-- MySQL (есть ли данные):"; systemctl is-active mysql 2>/dev/null; ls /var/lib/mysql 2>/dev/null | head

echo "== ЧТО ЗАПИСЫВАЕТСЯ"
echo "-- сервисы:"; systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}'
echo "-- порты наружу:"; ss -tlnp | awk 'NR>1 && $4 !~ /^127\.|^\[::1\]/{print $4, $6}' | sed 's/users:((//;s/,pid.*//'
echo "-- база гостей (только число строк):"
sudo -u postgres psql -d pii_gateway -Atc "select relname, n_live_tup from pg_stat_user_tables order by 1" 2>/dev/null
echo "-- журналы nginx (хранят IP посетителей):"; ls -lh /var/log/nginx 2>/dev/null; grep -h "rotate\|daily\|weekly" /etc/logrotate.d/nginx 2>/dev/null
echo "-- журнал systemd: $(journalctl --disk-usage 2>/dev/null)"; grep -E "^(SystemMaxUse|MaxRetentionSec)" /etc/systemd/journald.conf 2>/dev/null
echo "-- права на файлы с ключами:"; ls -l /etc/saas-gateway.env /etc/pii-gateway.env 2>/dev/null
echo "-- хостинг/страна сервера:"; curl -s -m 8 ipinfo.io/org; echo; curl -s -m 8 ipinfo.io/country; echo
echo "-- TLS сертификаты:"; certbot certificates 2>/dev/null | grep -E "Domains|Expiry"

echo "== РЕКВИЗИТЫ ОФЕРТЫ"
cd /opt/saas-gateway && set -a && . /etc/saas-gateway.env && set +a && node -e '
const admin=require("firebase-admin");
const sa=JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64,"base64").toString());
admin.initializeApp({credential:admin.credential.cert(sa)});
admin.firestore().doc("platformConfig/legal").get().then(d=>{console.log(JSON.stringify(d.data()||{},null,1));process.exit(0)}).catch(e=>{console.log("ошибка:",e.message);process.exit(0)});' 2>&1 | head -40
echo "== готово"
