#!/usr/bin/env bash
# Разворачивает серверную часть Colibri Lounge в Firebase одной командой.
#
# Запускать в Termux из папки репозитория:
#
#     bash deploy.sh
#
# Что делает:
#   1) проверяет, что установлен firebase-tools и выполнен вход;
#   2) создаёт сайт хостинга colibri-lounge, если его ещё нет;
#   3) выкладывает правила Firestore, индексы, Storage и хостинг.
#
# Cloud Functions намеренно НЕ разворачиваются: они требуют платного
# тарифа Blaze, а приложение спроектировано так, чтобы полностью работать
# на бесплатном Spark (уведомления гостю — локальные, см.
# lib/client/services/kolibri_notifications.dart).

set -u

PROJECT="hoocah-pos"
SITE="colibri-lounge"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31m✘ %s\033[0m\n\n' "$1"; exit 1; }

say "Проверяю firebase-tools"
if ! command -v firebase >/dev/null 2>&1; then
  die "firebase не установлен. Выполните: npm install -g firebase-tools"
fi
ok "$(firebase --version)"

say "Проверяю вход в Firebase"
if ! firebase projects:list >/dev/null 2>&1; then
  die "Вход не выполнен. Выполните: firebase login --no-localhost"
fi
ok "вход выполнен"

say "Проверяю сайт хостинга $SITE"
if firebase hosting:sites:list --project "$PROJECT" 2>/dev/null | grep -q "$SITE"; then
  ok "сайт $SITE уже существует"
else
  warn "сайта нет — создаю"
  firebase hosting:sites:create "$SITE" --project "$PROJECT" \
    || die "не удалось создать сайт $SITE (возможно, имя занято другим проектом)"
  ok "сайт создан"
fi

say "Выкладываю правила Firestore, индексы, Storage и хостинг"
firebase deploy \
  --only firestore:rules,firestore:indexes,storage,hosting \
  --project "$PROJECT" \
  || die "деплой не прошёл — посмотрите сообщение выше"

say "Готово"
ok "правила и индексы Firestore обновлены"
ok "страница столов: https://$SITE.web.app/table/1"
printf '\nОсталось только: залить свежие APK на Яндекс Диск и Google Диск.\n\n'
