#!/bin/bash
# Запустить fail2ban для SSH через системный журнал (на этой Ubuntu нет auth.log)
# и показать, что настроено.
set -u
echo "== $(hostname), $(date)"
DEBIAN_FRONTEND=noninteractive apt-get install -y python3-systemd >/dev/null 2>&1 && echo "python3-systemd: ok"
printf '[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' > /etc/fail2ban/jail.d/sshd-zalpos.local
systemctl restart fail2ban; sleep 4
echo "fail2ban: $(systemctl is-active fail2ban)"
fail2ban-client status sshd || journalctl -u fail2ban -n 20 --no-pager
echo "== cron:"; ls /etc/cron.d/
echo "== копии базы:"; ls -lh /root/backups
df -h / | tail -1
