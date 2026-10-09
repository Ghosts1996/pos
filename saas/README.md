# ZalPOS — облачная платформа

Эта папка — многоарендная платформа ZalPOS (Firebase-проект `saas-3bdc8`,
сайт `zalpos.ru`). К приложению одного заведения в корне репозитория
(проект `hoocah-pos`) она отношения не имеет: там ничего не меняется.

## Из чего состоит

| Где | Что |
|---|---|
| `console/` | Сайт `zalpos.ru`: лендинг, кабинет владельца, панель платформы. Firebase Hosting. |
| `guest-web/` | Веб-версия гостя и страница QR стола на `{slug}.zalpos.ru`. Отдаёт nginx на сервере. |
| `promo-hookahpos/` | Рекламная страница `hookahpos.su`, все кнопки ведут на `zalpos.ru`. |
| `firestore.rules`, `firestore.indexes.json` | Правила доступа и индексы. |
| `test/` | Тесты правил на эмуляторе Firestore. |
| `scripts/seed-plans.js`, `plans.seed.json` | Начальные тарифы. |
| `migrations/` | Перенос одиночного заведения из `hoocah-pos`. |
| `../saas-gateway/` | Сервер платформы: заведения и сети, оплата, сборки APK, ночные задачи. |
| `../pii-gateway/` | Первичная запись персональных данных в РФ (PostgreSQL). |

Приложения собираются из корневого Flutter-проекта: касса —
`--dart-define=SAAS_MODE=true`, пакет `com.hookahpossaas`; приложение гостя —
пакет `com.kolibriloungesaas`.

Cloud Functions платформа не использует: у проекта бесплатный тариф Spark,
всё привилегированное делает `saas-gateway`.

## Данные и доступ

- `tenants/{id}` — заведение; `chains/{id}` — сеть заведений.
- `tenantMembers/{tenantId}_{uid}`, `chainMembers/{chainId}_{uid}` — доступ;
  роли `owner`, `admin`, `manager`, `employee`, статус `active`/`inactive`.
- `subscriptions/{tenantId}` или `subscriptions/{chainId}` — подписка. У точки
  сети своей подписки нет, брендинг и лояльность тоже общие у сети.
- `plans`, `buildJobs`, `billingEvents`, `bankInvoices`, `supportTickets`,
  `broadcasts`, `dataRequests`.
- `superAdmins/{uid}` — супер-админы. `auditLogs`, `securityLog` пишет только
  сервер.

Просрочка оплаты: подписка переходит в `past_due`, касса блокируется, через
10 дней (`GRACE_PERIOD_DAYS` в `saas-gateway/server.js`) данные заведения
стираются.

## Деплой

Пуш в ветку `claude/dazzling-babbage-n65p6l` с изменениями в `saas/console`,
`saas/guest-web`, `saas/firestore.rules`, `saas-gateway` или `pii-gateway`
запускает `.github/workflows/server-deploy.yml`. Он заходит на сервер и
выполняет `saas-gateway/update-server.sh`: обновляет сервисы, веб-версию
гостя и выполняет `firebase deploy --only hosting,firestore`.

Вручную:

```bash
cd saas
firebase deploy --only hosting,firestore --project saas-3bdc8
```

## Тесты правил

Любую правку `firestore.rules` сначала прогоняем здесь:

```bash
cd saas/test && npm i
cd .. && npx firebase-tools emulators:exec --project hookah-saas-rules-test \
  --only firestore "cd test && npm test"
```

## Новый проект с нуля

1. Создать Firebase-проект, включить Firestore, Authentication (Email/Password,
   Email link, Anonymous). Id проекта — в `saas/.firebaserc`.
2. `firebase deploy --only hosting,firestore`.
3. Завести себе аккаунт в консоли и документ `superAdmins/{ваш uid}` вручную
   в Firestore: первый супер-админ приложением не выдаётся. Остальных
   назначают из панели платформы.
4. Тарифы: `cd saas/scripts && npm i && node seed-plans.js --project <id> --key ./service-account.json`
   (ключ сервисного аккаунта в git не класть) — или в панели платформы:
   «Тарифы» → «Посмотреть изменения и применить». Сетка: «Старт» 990 ₽/мес
   (без приложения гостя и ИИ, до 5 сотрудников), «Бизнес» 1 990 ₽ (+ приложение
   гостя, меню по QR, ИИ; до 15), «Про» 2 990 ₽ (без лимитов), «Сеть» 2 990 ₽
   + 1 490 ₽ за каждую следующую точку; год — выгода 20 %, полгода — 10 %.
5. Сервер — по `saas-gateway/README.md`: установка, nginx, оплата
   (Робокасса, для ИП и организаций — счёт), секреты.

## Сборки приложений

«Собрать APK» в кабинете запускает `.github/workflows/saas-on-demand-build.yml`:
одна сборка — касса Android, касса Windows и приложение гостя (если оно есть
в тарифе заведения; без него `job_id_kolibri` не передаётся и собираются
только кассы). Брендинг
заведения (название, логотип, цвета) применяется только к приложению гостя,
касса у всех одинаковая.

**Приложения в Firebase.** В проекте зарегистрированы два Android-приложения:
`com.hookahpossaas` и `com.kolibriloungesaas`, у каждого свой
`google-services.json`.

**Секреты репозитория** (Settings → Secrets and variables → Actions):

| Секрет | Что |
|---|---|
| `GOOGLE_SERVICES_JSON_SAAS` | `google-services.json` кассы целиком |
| `GOOGLE_SERVICES_JSON_SAAS_KOLIBRI` | `google-services.json` приложения гостя (другой файл) |
| `SAAS_FIREBASE_API_KEY`, `SAAS_FIREBASE_MESSAGING_SENDER_ID`, `SAAS_FIREBASE_PROJECT_ID`, `SAAS_FIREBASE_STORAGE_BUCKET` | общие параметры проекта для `--dart-define` |
| `SAAS_FIREBASE_APP_ID`, `SAAS_FIREBASE_APP_ID_KOLIBRI` | `appId` кассы и приложения гостя — не перепутать |
| `BUILD_CALLBACK_SECRET` | то же значение, что в `/etc/saas-gateway.env` |
| `DEPLOY_SSH_KEY_TENANT` | ключ доставки личных сборок на сервер (ниже) |
| `DEPLOY_SSH_KEY` | ключ доставки публичного APK (ниже) |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | постоянная подпись APK — без неё обновление поверх невозможно |

Адреса сервера (`pii.zalpos.ru`) прописаны в самих workflow.

Сервер запускает сборку из ветки `GITHUB_REF` (`/etc/saas-gateway.env`, по
умолчанию `claude/dazzling-babbage-n65p6l`). После слияния в `main` достаточно
поменять переменную и перезапустить `saas-gateway`.

**Доставка личных сборок на сервер** (один раз). Ключ может только запустить
этот скрипт, shell по нему не открыть:

```bash
cat > /usr/local/bin/deploy-tenant-apk.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail
# "<tenantId> <jobId>" от workflow — только буквы и цифры, чтобы путь
# нельзя было подменить.
read -r TENANT_ID JOB_ID <<< "${SSH_ORIGINAL_COMMAND:-}"
[[ "$TENANT_ID" =~ ^[A-Za-z0-9]+$ ]] || { echo "bad tenant id" >&2; exit 1; }
[[ "$JOB_ID" =~ ^[A-Za-z0-9]+$ ]] || { echo "bad job id" >&2; exit 1; }

DIR="/opt/saas-gateway/tenant-builds/$TENANT_ID"
mkdir -p "$DIR"
TMP=$(mktemp "$DIR/.upload.XXXXXX")
cat > "$TMP"
mv "$TMP" "$DIR/$JOB_ID.apk"
chown -R saas-gateway:saas-gateway "$DIR"
# Файл отдаёт nginx от своего пользователя; снаружи он доступен только
# по одноразовой ссылке сервера.
chmod 644 "$DIR/$JOB_ID.apk"
chmod 755 "$DIR"
SCRIPT
chmod +x /usr/local/bin/deploy-tenant-apk.sh

ssh-keygen -t ed25519 -f /root/.ssh/github_deploy_tenant_key -N "" -C "github-actions-deploy-tenant"
echo -n 'command="/usr/local/bin/deploy-tenant-apk.sh",restrict ' \
  | cat - /root/.ssh/github_deploy_tenant_key.pub >> /root/.ssh/authorized_keys
cat /root/.ssh/github_deploy_tenant_key   # → секрет DEPLOY_SSH_KEY_TENANT
chmod 755 /opt/saas-gateway /opt/saas-gateway/tenant-builds
```

**Раздача — через nginx.** `saas-gateway` проверяет одноразовую ссылку
(60 секунд) и отвечает `X-Accel-Redirect`, файл отдаёт nginx: из Node
загрузка на телефоне зависала на 100 %. В `server { }` домена `pii.zalpos.ru`:

```nginx
location /internal-tenant-builds/ {
    internal;
    alias /opt/saas-gateway/tenant-builds/;
    # Без докачки по частям: ссылка живёт 60 секунд, а Android качал
    # кусками и ловил 403 на середине.
    max_ranges 0;
}
```

**Обновление изнутри.** Касса и приложение гостя сами находят новую сборку
(`POST /saas/appUpdate`, `lib/services/app_update_service.dart`) и показывают
плашку «Вышла новая версия». На Android открывается системная установка
поверх (в первый раз — разрешение «установка неизвестных приложений»), на
Windows касса перезапускается с новыми файлами. Точке сети сервер
предлагает самую свежую сборку любой точки этой сети: касса могла перейти
сюда из другой точки, а у новой точки своих сборок может ещё не быть
(приложение гостя у сети и так общее). После обновления кода
приложений сервер сам пересобирает их всем заведениям — см.
«Автообновление приложений» в `saas-gateway/README.md`.

## Публичный APK для лендинга

Кнопка «Скачать» ведёт на `https://pii.zalpos.ru/downloads/zalpos.apk` —
статика nginx. Firebase Storage требует Blaze, а с GitHub Releases у части
пользователей в России скачивание зависало.

Новая версия: Actions → «Публичный APK (демо-сборка для сайта)» → Run
workflow. `public-apk-release.yml` соберёт универсальную кассу (без
привязки к заведению), выложит в GitHub Release `public-apk` и сам доставит
файл на сервер.

Доставка (один раз):

```bash
cat > /usr/local/bin/deploy-public-apk.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail
TMP=$(mktemp /var/www/downloads/.upload.XXXXXX)
cat > "$TMP"
mv "$TMP" /var/www/downloads/hookah-pos-public.apk
chmod 644 /var/www/downloads/hookah-pos-public.apk
SCRIPT
chmod +x /usr/local/bin/deploy-public-apk.sh

ssh-keygen -t ed25519 -f /root/.ssh/github_deploy_key -N "" -C "github-actions-deploy"
echo -n 'command="/usr/local/bin/deploy-public-apk.sh",restrict ' \
  | cat - /root/.ssh/github_deploy_key.pub >> /root/.ssh/authorized_keys
cat /root/.ssh/github_deploy_key   # → секрет DEPLOY_SSH_KEY
```

Ссылку `zalpos.apk` на этот файл ставит `saas-gateway/migrate-domain.sh`.

**Демо приложения гостя.** Тот же workflow собирает и его (`SAAS_GUEST_DEMO=true`,
`com.kolibriloungesaas`): гость вводит код демо-сети с экрана входа кассы в
демо-режиме (`demo-…`) или открывает новое демо. Файл доставляется ключом
`DEPLOY_SSH_KEY_TENANT` тем же `deploy-tenant-apk.sh` в
`/opt/saas-gateway/tenant-builds/publicdemo/guestdemo.apk`, отдаёт его
`GET /saas/guestDemoApk` через уже настроенный `location /internal-tenant-builds/`
— на сервере ничего добавлять не нужно. Копия — в GitHub Release `public-apk`.

**Демо-касса для Windows.** Тот же workflow (job `build-windows`) собирает
установщик `zalpos-kassa-demo-setup.exe` без кодов заведения и тем же ключом
кладёт его в `/opt/saas-gateway/tenant-builds/publicdemo/kassawin.apk` (скрипт
доставки пишет только `*.apk`); отдаёт `GET /saas/windowsDemo` с именем
`zalpos-kassa-demo-setup.exe`. Установщик общий с кассой заведения (тот же
AppId), поэтому касса заведения ставится поверх демо.

**Демо — сеть из двух точек** («Демо · Центр» и «Демо · Набережная»): у каждой
свои сотрудники и PIN-коды (1111/2222/3333/111111 и 4444/5555/6666/222222),
гости и бонусы общие. Касса при входе спрашивает, в какую точку войти
(`/chainPoints`, `/chainPointJoin` — так же работает касса любой сети). Через 3
дня точки и сеть стираются целиком.

## Поддомены заведений

У каждого заведения веб-версия гостя на `{slug}.zalpos.ru`, QR стола в кассе
ведёт на `https://{slug}.zalpos.ru/table/{id}`.

Сертификат выпускается на каждый поддомен отдельно (HTTP-01): wildcard
требует DNS API, которого у регистратора нет. Выпуск и блок nginx делает
`saas-gateway/provision-tenant-domain.sh`, сервер вызывает его при создании
заведения.

Один раз на сервере:

1. DNS: `*.zalpos.ru. A <IP сервера>` и `pii.zalpos.ru`.
2. Общий HTTP-блок для ACME-проверки и редиректа на https:

   ```bash
   mkdir -p /opt/saas-guest-web /var/www/certbot
   cat > /etc/nginx/conf.d/saas-guest-wildcard-http.conf << 'NGINXEOF'
   server {
       listen 80;
       listen [::]:80;
       server_name ~^(?<tenant_slug>.+)\.zalpos\.ru$;
       location /.well-known/acme-challenge/ { root /var/www/certbot; }
       location / { return 301 https://$host$request_uri; }
   }
   NGINXEOF
   nginx -t && systemctl reload nginx
   ```

3. Разрешить сервису запускать только этот скрипт от root:

   ```bash
   install -m 755 saas-gateway/provision-tenant-domain.sh /usr/local/bin/provision-tenant-domain.sh
   echo 'saas-gateway ALL=(root) NOPASSWD: /usr/local/bin/provision-tenant-domain.sh' \
     > /etc/sudoers.d/saas-gateway-certbot
   chmod 440 /etc/sudoers.d/saas-gateway-certbot && visudo -c
   ```

   В `saas-gateway.service` нет `NoNewPrivileges` — иначе sudo не сработает.

Проверка: `https://<slug>.zalpos.ru/table/x` открывает страницу стола,
`https://<slug>.zalpos.ru/app/` — веб-версию гостя.

Ограничение: все приложения гостя собраны под одним `applicationId`. Если у
гостя уже стоит приложение другого заведения платформы, ссылка со страницы
стола откроет его.

## Домены

Платформа живёт на `zalpos.ru`. Переезд сервера с `hookahpos.su` —
`saas-gateway/migrate-domain.sh` (повторный запуск безопасен): расширяет
сертификат `pii.zalpos.ru`, выпускает поддомены заведений, со старых
`{slug}.hookahpos.su` ставит перенаправление.

`hookahpos.su` продлеваем: `pii.hookahpos.su` нужен ещё не обновлённым
приложениям, `{slug}.hookahpos.su` — наклеенным QR-кодам, на корне —
рекламная страница.

Для консоли в Firebase: Hosting → домен `zalpos.ru`, Authentication →
Authorized domains → `zalpos.ru`.

## Перенос существующего заведения

```bash
cd saas/migrations && npm i
node migrate-single-tenant-to-tenant.js \
  --source-project hoocah-pos --source-key ./hoocah-key.json \
  --target-project saas-3bdc8 --target-key ./saas-key.json \
  --tenant-id <id заведения, созданного в консоли>
```

Скрипт только читает `hoocah-pos` и пишет в платформу — живое заведение
работает всё это время.

## Telegram через Cloudflare

С сервера в РФ `api.telegram.org` недоступен, а Telegram не всегда
достучится до сервера. Боты заведений ходят через ретранслятор на
Cloudflare Workers (бесплатного тарифа хватает): сервер → Telegram и
нажатия кнопок Telegram → сервер.

1. dash.cloudflare.com → Workers & Pages → Create → Worker → «Hello World»,
   имя, например, `zalpos-tg` → Deploy → Edit code: заменить код
   содержимым `saas-gateway/telegram-relay-worker.js` → Deploy.
2. Worker → Settings → Variables and Secrets → Add: тип Secret, имя
   `RELAY_SECRET`, значение — 32+ случайные латинские буквы и цифры.
3. GitHub → Settings → Secrets and variables → Actions → New repository
   secret `TELEGRAM_RELAY_URL` =
   `https://zalpos-tg.<аккаунт>.workers.dev/<RELAY_SECRET>`.
4. Задача обслуживания сервера (`.github/server-ops/task.sh`) проверяет
   путь в обе стороны и только тогда пишет в `/etc/saas-gateway.env`
   `TELEGRAM_API_BASE` и `TELEGRAM_HOOK_BASE` и перезапускает шлюз.
   Вебхуки уже подключённых ботов шлюз переставляет сам.

Отключить: убрать обе строки из `/etc/saas-gateway.env` и перезапустить
шлюз — вебхуки вернутся на `https://pii.zalpos.ru/saas/tgHook/…`.
