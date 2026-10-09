#!/bin/bash
# Задача 9 (только чтение): аудит сервера — безопасность, сервисы, ошибки.
set -u
echo "== ОС и обновления"; lsb_release -ds 2>/dev/null; uname -r
apt list --upgradable 2>/dev/null | grep -c security | sed 's/^/обновлений безопасности: /'
[ -f /var/run/reboot-required ] && echo "нужна перезагрузка (новое ядро)"
echo "== SSH"; sshd -T 2>/dev/null | grep -E "^(permitrootlogin|passwordauthentication|pubkeyauthentication|maxauthtries|x11forwarding) "
echo "== fail2ban"; fail2ban-client status sshd 2>/dev/null | grep -E "Currently banned|Total banned"
echo "== упавшие сервисы"; systemctl --failed --no-legend --no-pager
echo "== ошибки за сутки"
for s in saas-gateway pii-gateway nginx postgresql@14-main; do
  n=$(journalctl -u $s --since -24h --no-pager -p err 2>/dev/null | grep -vc "^-- ")
  echo "$s: $n"; journalctl -u $s --since -24h --no-pager -p err 2>/dev/null | tail -3 | cut -c1-220
done
echo "== nginx: последние ошибки"; tail -8 /var/log/nginx/error.log 2>/dev/null | cut -c1-220
echo "== nginx: 5xx за сутки"; awk '$9 ~ /^5/' /var/log/nginx/access.log 2>/dev/null | awk '{print $9, $7}' | sort | uniq -c | sort -rn | head -10
echo "== nginx: заголовки безопасности"; nginx -T 2>/dev/null | grep -iE "add_header|server_tokens|ssl_protocols" | sort -u | head -20
echo "== сертификаты"; for d in zalpos.ru pii.zalpos.ru; do printf '%s: ' $d; echo | openssl s_client -servername $d -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null; done
echo "== сайты"; for u in https://zalpos.ru/ https://pii.zalpos.ru/ https://pii.zalpos.ru/saas/health https://pii.zalpos.ru/health; do printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 10 $u)" $u; done
echo "== права на секреты"; ls -l /etc/*.env 2>/dev/null | awk '{print $1, $3, $NF}'
echo "== Postgres слушает"; sudo -u postgres psql -Atc "show listen_addresses" 2>/dev/null
echo "== MySQL слушает"; ss -tlnp | grep -E ":3306|:5432|:6379" | awk '{print $4}'
echo "== память/диск/нагрузка"; free -h | head -2; df -h / | tail -1; uptime
echo "== cron"; ls /etc/cron.d
echo "== резервные копии"; ls -lh /root/backups /opt/saas-gateway/backups 2>/dev/null | tail -6
