#!/bin/bash
# Задача 4 (только чтение): что относится к VPN — перед удалением.
set -u
echo "== docker:"; docker ps -a --format '{{.Names}} | {{.Image}} | {{.Ports}} | {{.Mounts}}'
for u in xray-ru-relay casc-23001; do echo "== unit $u:"; systemctl cat $u 2>/dev/null | grep -vE '^\s*$|^#' ; done
echo "== все casc-*:"; ls /etc/systemd/system | grep -iE 'casc|xray|x-ui|vpn|relay'
echo "== файлы:"; ls -la /opt/3x-ui 2>/dev/null; ls -l /root/x-ui.db 2>/dev/null; ls -d /usr/local/etc/xray /usr/local/bin/xray* /etc/x-ui* /usr/local/x-ui 2>/dev/null
echo "== nginx упоминания:"; grep -rnE '2053|x-ui|xray|8088|2300[0-9]|24001' /etc/nginx/ 2>/dev/null | head -20
echo "== cron упоминания:"; grep -rlE 'x-ui|xray|casc' /etc/cron* /var/spool/cron 2>/dev/null
echo "== ufw:"; ufw status 2>/dev/null | head -20
