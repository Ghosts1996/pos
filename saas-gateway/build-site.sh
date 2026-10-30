#!/bin/bash
# Сайт zalpos.ru на этом сервере (в РФ): собирает saas/console с блогом в
# /opt/zalpos-site, сжимает файлы заранее (nginx отдаёт готовый .gz) и
# подменяет папку целиком — посетитель не застанет сайт наполовину
# обновлённым. Запускают move-site-to-server.sh (первый раз),
# update-server.sh и blog-publish.sh (если сайт уже здесь).
#
#   bash build-site.sh [/opt/zalpos-site]
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/opt/zalpos-site}"
PARENT="$(dirname "$DEST")"
mkdir -p "$PARENT"

# Рядом с DEST — чтобы подмена была переименованием на том же диске.
STAGE="$(mktemp -d "$PARENT/.zalpos-site.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# Блог, инструкция и карта сайта — на сегодня, в папку сайта в репозитории
# (как перед firebase deploy): по её карте сайта сервер сообщает поисковикам
# о новых страницах (build-blog.mjs --announce).
node "$REPO/saas/scripts/build-blog.mjs"
cp -a "$REPO/saas/console/." "$STAGE/"
# Текст лендинга прямо в index.html: виден сразу, до загрузки кабинета, и
# поисковикам без выполнения скриптов. Не вышло — сайт работает как раньше.
node "$REPO/saas/scripts/prerender-landing.mjs" "$STAGE/index.html" || echo "!! текст лендинга не вписан — главная покажет его после загрузки"

# Настройки Firebase для кабинета — только на случай возврата к Firebase
# (сейчас вход и данные на этом сервере). Ключи в репозиторий не кладём:
# берём прежний файл или один раз у Firebase Hosting проекта.
mkdir -p "$STAGE/__/firebase"
if [[ -s "$DEST/__/firebase/init.json" ]]; then
  cp "$DEST/__/firebase/init.json" "$STAGE/__/firebase/init.json"
else
  PROJECT="$(node -e 'try{process.stdout.write(require(process.argv[1]).projects.default||"")}catch(_){}' "$REPO/saas/.firebaserc")"
  if [[ -n "$PROJECT" ]] && curl -fsS --max-time 15 "https://$PROJECT.web.app/__/firebase/init.json" -o "$STAGE/__/firebase/init.json.tmp"; then
    mv "$STAGE/__/firebase/init.json.tmp" "$STAGE/__/firebase/init.json"
  else
    rm -f "$STAGE/__/firebase/init.json.tmp"
    echo "!! настройки Firebase не получены — кабинет работает и без них (вход и данные на этом сервере)"
  fi
fi

# Служебные файлы сборки наружу не нужны.
find "$STAGE" -mindepth 1 -name '.*' -not -name '.well-known' -prune -exec rm -rf {} +

# Сжатие заранее: console.js ~800 КБ → ~210 КБ, и сервер не жмёт на каждый запрос.
find "$STAGE" -type f \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.svg' \
  -o -name '*.xml' -o -name '*.json' -o -name '*.txt' -o -name '*.webmanifest' \) -size +1k -exec gzip -9 -k -f {} +

chmod 755 "$STAGE"
chown -R www-data:www-data "$STAGE" 2>/dev/null || true

OLD=""
if [[ -d "$DEST" ]]; then
  OLD="$PARENT/.zalpos-site.old.$$"
  mv "$DEST" "$OLD"
fi
mv "$STAGE" "$DEST"
trap - EXIT
[[ -n "$OLD" ]] && rm -rf "$OLD"
echo "ok: сайт собран в $DEST ($(du -sh "$DEST" | cut -f1))"
