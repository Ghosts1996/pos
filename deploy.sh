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

say "Выкладываю правила Firestore, индексы и хостинг"
# Это то, без чего приложение не работает: без правил гостю запрещены
# запросы, без индексов падают списки, без хостинга QR ведёт в пустоту.
firebase deploy \
  --only firestore:rules,firestore:indexes,hosting \
  --project "$PROJECT" \
  || die "деплой не прошёл — посмотрите сообщение выше"
ok "правила, индексы и сайт выложены"

say "Правила Storage (необязательно)"
# Storage в этом проекте может быть не подключён — тогда деплой правил для
# него падает с «Firebase Storage has not been set up». Раньше эта ошибка
# обрушивала весь деплой целиком, вместе с правилами Firestore и сайтом,
# хотя Storage нужен только для картинок в меню. Поэтому он вынесен
# отдельным шагом и его провал не считается провалом деплоя.
if firebase deploy --only storage --project "$PROJECT" >/dev/null 2>&1; then
  ok "правила Storage обновлены"
else
  warn "Storage в проекте не подключён — пропускаю."
  warn "На работу зала, счетов, бонусов и QR это не влияет."
  warn "Нужен только для загрузки фотографий в меню. Подключается здесь:"
  warn "https://console.firebase.google.com/project/$PROJECT/storage"
fi

say "Проверяю, что сайт отвечает"
# assetlinks.json — файл, по которому Android решает, можно ли открывать
# ссылки этого сайта прямо в приложении. Если он не выложился (а раньше
# его прятало правило ignore "**/.*"), App Links молча не включатся:
# ссылка будет открываться в браузере, и никакой ошибки нигде не появится.
AL="https://$SITE.web.app/.well-known/assetlinks.json"
if curl -fsS --max-time 20 "$AL" 2>/dev/null | grep -q "com.kolibrilounge"; then
  ok "assetlinks.json на месте — приложение сможет открывать ссылки само"
else
  warn "assetlinks.json не отдаётся ($AL)."
  warn "QR продолжат работать через страницу установки, но приложение"
  warn "будет открываться через браузер, а не напрямую."
fi

if curl -fsS --max-time 20 "https://$SITE.web.app/table/1" 2>/dev/null | grep -q "Colibri Lounge"; then
  ok "страница стола открывается"
else
  warn "страница стола не открылась — проверьте https://$SITE.web.app/table/1"
fi

say "Готово"
ok "страница столов: https://$SITE.web.app/table/1"
printf '\nОсталось только: залить свежие APK на Яндекс Диск и Google Диск.\n\n'
