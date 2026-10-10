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
  if ! command -v firebase >/dev/null; then
    echo "firebase CLI на сервере нет — выложите сайт вручную: cd $SAAS && firebase deploy --only hosting"
    exit 1
  fi
  (cd "$SAAS" && firebase deploy --only hosting --non-interactive)
else
  echo "$(date '+%F %T') новых постов нет"
fi

# Поисковикам — обо всех вышедших, о которых ещё не сообщали (в том числе
# выложенных обычным обновлением сайта после пуша).
STATE=/var/lib/zalpos-blog
mkdir -p "$STATE"
told="$(cat "$STATE/announced" 2>/dev/null || true)"
fresh="$(added "$told" "$after")"
if [[ -n "$fresh" ]]; then
  node "$SAAS/scripts/build-blog.mjs" --indexnow="$fresh" && printf '%s\n' "$after" > "$STATE/announced"
fi
