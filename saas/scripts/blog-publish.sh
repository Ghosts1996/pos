#!/bin/bash
# Автопубликация блога zalpos.ru (от root, раз в день — cron из
# saas-gateway/update-server.sh).
#
# Посты лежат в saas/blog/posts с датами выхода. Скрипт собирает блог на
# сегодня; если появились новые посты — выкладывает сайт (firebase deploy,
# как update-server.sh) и сообщает Яндексу и IndexNow-поисковикам новые
# адреса. Нет новых — ничего не делает.
#
# Вручную: bash /root/pos-deploy/saas/scripts/blog-publish.sh
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SAAS="$(cd "$(dirname "$0")/.." && pwd)"
LIST="$SAAS/console/blog/.published"

# Не одновременно с автообновлением сервера: оно меняет код и тоже
# выкладывает сайт.
exec 9>/var/lock/zalpos-auto-deploy.lock
flock -w 1800 9

before="$(cat "$LIST" 2>/dev/null || true)"
node "$SAAS/scripts/build-blog.mjs"
after="$(cat "$LIST" 2>/dev/null || true)"

added() { comm -13 <(printf '%s\n' "$1" | sed '/^$/d' | sort) <(printf '%s\n' "$2" | sed '/^$/d' | sort) | paste -sd, -; }

if [[ -n "$(added "$before" "$after")" ]]; then
  echo "$(date '+%F %T') новые посты: $(added "$before" "$after")"
  if [[ -d /opt/zalpos-site ]]; then
    # Сайт на этом сервере (saas-gateway/move-site-to-server.sh).
    bash "$SAAS/../saas-gateway/build-site.sh" /opt/zalpos-site
  elif ! command -v firebase >/dev/null; then
    echo "firebase CLI на сервере нет — выложите сайт вручную: cd $SAAS && firebase deploy --only hosting"
    exit 1
  else
    (cd "$SAAS" && firebase deploy --only hosting --non-interactive)
  fi
else
  echo "$(date '+%F %T') новых постов нет"
fi

# Поисковикам — обо всех новых и изменённых страницах карты сайта: посты,
# темы, страницы блога, инструкция и частые вопросы (в том числе
# выложенных обычным обновлением сайта после пуша). Карта sitemap.xml
# пересобирается при каждой сборке — новые посты попадают в неё сами.
STATE=/var/lib/zalpos-blog
mkdir -p "$STATE"
node "$SAAS/scripts/build-blog.mjs" --announce --state="$STATE/sitemap-announced" || true
