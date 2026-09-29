#!/bin/bash
# Автообновление сервера: GitHub Actions (.github/workflows/server-deploy.yml)
# после каждого пуша заходит по SSH и запускает этот скрипт.
#
# Ставится как /usr/local/bin/zalpos-auto-deploy.sh и работает ТОЛЬКО как
# forced-command ключа (authorized_keys: command="…",restrict — см.
# setup-auto-deploy.sh): этим ключом нельзя получить shell или выполнить
# свою команду — только обновить код из GitHub и перезапустить сервисы.
# Единственное, что передаёт GitHub, — имя ветки, и оно проверяется.
set -euo pipefail

REPO=/root/pos-deploy
BRANCH="${SSH_ORIGINAL_COMMAND:-}"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "ожидается имя ветки" >&2; exit 2; }

# Два пуша подряд — обновления по очереди, а не одновременно.
exec 9>/var/lock/zalpos-auto-deploy.lock
flock -w 900 9

cd "$REPO"
git fetch --quiet origin "$BRANCH"
# Копия на сервере — точное состояние ветки из GitHub (правок руками в
# ней нет: настройки лежат в /etc, а не в репозитории). FETCH_HEAD, а не
# origin/<ветка>: копия могла быть склонирована с одной веткой, и тогда
# origin/<ветка> не обновляется.
git checkout --quiet -B "$BRANCH" FETCH_HEAD
echo "код: $(git rev-parse --short HEAD) ($BRANCH)"

bash "$REPO/saas-gateway/update-server.sh"

# Свежая версия этого же скрипта — на следующий раз.
install -m 755 "$REPO/saas-gateway/auto-deploy.sh" /usr/local/bin/zalpos-auto-deploy.sh.new
sed -i "s#^REPO=.*#REPO=$REPO#" /usr/local/bin/zalpos-auto-deploy.sh.new
mv /usr/local/bin/zalpos-auto-deploy.sh.new /usr/local/bin/zalpos-auto-deploy.sh
