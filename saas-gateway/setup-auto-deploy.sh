#!/bin/bash
# Разовая настройка автообновления сервера (от root, на сервере):
#
#   bash /root/pos-deploy/saas-gateway/setup-auto-deploy.sh
#
# Создаёт отдельный SSH-ключ, которым можно ТОЛЬКО обновить сервер из
# GitHub (forced-command, без shell), и печатает его закрытую часть — её
# нужно один раз вставить в GitHub: Settings → Secrets and variables →
# Actions → New repository secret, имя SERVER_DEPLOY_KEY. Дальше после
# каждого изменения в коде сервер и сайт обновляются сами.
# Повторный запуск безопасен.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "запустите от root" >&2; exit 1; }

install -m 755 "$REPO/saas-gateway/auto-deploy.sh" /usr/local/bin/zalpos-auto-deploy.sh
sed -i "s#^REPO=.*#REPO=$REPO#" /usr/local/bin/zalpos-auto-deploy.sh

KEY=/root/.ssh/zalpos_autodeploy
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N '' -C zalpos-autodeploy -f "$KEY"
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
if ! grep -q "zalpos-autodeploy" /root/.ssh/authorized_keys; then
  echo "command=\"/usr/local/bin/zalpos-auto-deploy.sh\",restrict $(cat "$KEY.pub")" >> /root/.ssh/authorized_keys
fi

cat <<EOF

Готово. Остался один шаг — вставить ключ в GitHub:
  GitHub → репозиторий pos → Settings → Secrets and variables → Actions →
  New repository secret → Name: SERVER_DEPLOY_KEY → Secret: весь блок ниже,
  от строки BEGIN до строки END включительно.

Никому его не пересылайте (в том числе в чат) — только в GitHub.

EOF
cat "$KEY"
echo
echo "Проверить без GitHub: ssh -i $KEY root@localhost \"\$(git -C $REPO rev-parse --abbrev-ref HEAD)\""
