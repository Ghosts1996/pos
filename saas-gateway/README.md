# SaaS-шлюз онбординга (без Cloud Functions/Blaze)

Небольшой сервис на том же сервере, что и `pii-gateway/` — берёт на себя
четыре операции, которые раньше были Cloud Functions в `saas/functions/
index.js`, а без тарифа Blaze у проекта `saas-3bdc8` просто не деплоятся
(Cloud Functions не работают без Blaze вообще, независимо от суммы реальных
трат): `createTenant`, `createBuildJob`, `resolveTenantBySlug`,
`completeBuildJob`. Плюс новые функции, которых в Cloud Functions не было:
`createDemoTenant` (одноразовое тестовое заведение для демонстрации
приложения, без email/пароля, само удаляется через несколько часов),
`cancelSubscription`/`resumeSubscription` (самостоятельная отмена/возврат
автопродления — Firestore-правила не пускают владельца писать в
`subscriptions` напрямую даже для своего заведения, см. `saas/firestore.rules`),
`createTenant` (после создания заведения асинхронно, не блокируя ответ,
автоматически выпускает Let's Encrypt сертификат и nginx-конфиг для
`{slug}.hookahpos.su` через `sudo provision-tenant-domain.sh` — см.
`saas/README.md`, раздел 8c, включая ОБЯЗАТЕЛЬНУЮ настройку sudoers и
`saas-gateway.service` без `NoNewPrivileges`, иначе создание заведения
продолжит работать, а автовыпуск сертификата будет тихо падать в лог),
`downloadBuild` (выдача готового личного APK владельцу), `publicGuestApk`
(скачивание гостевого APK по QR со стола — БЕЗ Firebase Auth: гость,
наведший камеру, не входил ни в один SaaS-аккаунт; отдаёт только
`type: "guest"`, кассу так получить нельзя ни при каком slug),
`firebaseConfig` (публичный веб-конфиг Firebase проекта — НЕ секрет, нужен
`saas/guest-web/` на поддоменах `{slug}.hookahpos.su`, потому что
`hookahpos.su/__/firebase/init.json` не отдаёт CORS для чужого origin —
подробнее в докстринге `handleFirebaseWebConfig` в `server.js`) и
модерация из панели супер-админа — `enableTenant`/`disableTenant`/
`changeTenantPlan`/`deleteDemoTenant` (эти четыре тоже раньше числились
Cloud Functions, просто ещё не задеплоенными — кнопки в консоли звали их
и молча проваливались, пока платформой реально не начали пользоваться).

Плюс биллинг ЮKassa — `createCheckoutSession` (создание платежа),
`billingWebhook` (подтверждение оплаты — публичный адрес, его нужно
прописать в личном кабинете ЮKassa, см. раздел «Биллинг» ниже),
автопродление подписок и перевод в `past_due`/удаление данных по
истечении льготного периода (два фоновых таймера раз в сутки, без
`onSchedule` — та же идея, что и у `createDemoTenant`'а очистки). Тоже
раньше было Cloud Functions (`createCheckoutSession`/`handleBillingWebhook`/
`chargeRecurringSubscriptions`/`enforceGracePeriod` в `saas/functions/
index.js`) — перенесено сюда по той же причине (Blaze недоступен), тот файл
не менялся и остаётся эталонной копией на случай, если Blaze всё же
появится.

**Что НЕ переехало** (сознательно, см. обсуждение с владельцем платформы):
приглашение сотрудников по email (`inviteTenantMember`) — остаётся на
Cloud Functions/Blaze, само по себе не блокирует приём платежей.

**Изоляция данных**: этот сервис использует сервисный ключ ИМЕННО проекта
`saas-3bdc8` — отдельного от `hoocah-pos` (личное заведение владельца
платформы и все одно-арендные сборки). Никак не связан и не может быть
связан с базой данных вашего собственного заведения.

## Установка

```bash
cd saas-gateway
./setup.sh
```

Скрипт поставит Node.js 20 (если его ещё нет — на этом сервере он уже
должен быть, ставили для `pii-gateway`), скопирует сервис в
`/opt/saas-gateway`, спросит сервисный ключ Firebase, GitHub-токен и секрет
обратного вызова — и запустит всё как systemd-сервис (`saas-gateway`,
слушает `127.0.0.1:8081`).

По ходу скрипт попросит:
1. **Сервисный аккаунт Firebase проекта `saas-3bdc8`** (не `hoocah-pos`!) в
   base64. Получить: Firebase Console → проект `saas-3bdc8` → Project
   settings → Service accounts → Generate new private key → скачается
   JSON. Дальше как и с pii-gateway: вставить содержимое файла в
   `cat > /tmp/key.json`, затем `base64 -w0 /tmp/key.json`, вставить вывод
   в скрипт, потом `rm -f /tmp/key.json`.
2. **GitHub personal access token** (fine-grained,
   github.com/settings/tokens?type=beta) с правами ТОЛЬКО "Actions: read
   and write" на репозиторий `Ghosts1996/pos` — нужен, чтобы сервис мог
   сам запускать сборку APK.
3. **Секрет обратного вызова** (`BUILD_CALLBACK_SECRET`) — придумайте
   случайную строку (`openssl rand -hex 24`) и запомните: то же самое
   значение нужно прописать в GitHub как секрет репозитория с тем же
   именем (см. ниже).
4. **Публичный веб-конфиг Firebase** (`FIREBASE_WEB_CONFIG_JSON`) — НЕ
   секрет (те же ключи видны в исходнике любой веб-страницы с Firebase).
   Получить: Firebase Console → `saas-3bdc8` → Project settings → General
   → Your apps → веб-приложение (значок `</>`) → «SDK setup and
   configuration» → переключатель «Config» → скопировать объект целиком
   в одну строку. Нужен, чтобы `saas/guest-web/` на поддоменах
   `{slug}.hookahpos.su` мог инициализировать Firebase — см. `firebaseConfig`
   выше и докстринг `handleFirebaseWebConfig` в `server.js`.
5. **Реквизиты магазина ЮKassa** (`YOOKASSA_SHOP_ID`/`YOOKASSA_SECRET_KEY`)
   — тот же кабинет ЮKassa, что уже используется (или будет использоваться)
   для приёма платежей. Личный кабинет ЮKassa → Настройки → API-ключи и
   HTTP-уведомления → shopId и секретный ключ (или тестовые значения на
   время проверки). См. раздел «Биллинг» ниже про webhook.

**Если сервис уже установлен раньше** (обновляете существующий, а не
ставите с нуля) — `setup.sh` повторно не запускать, просто добавить
строки в уже существующий `/etc/saas-gateway.env`:

```bash
echo 'FIREBASE_WEB_CONFIG_JSON={"apiKey":"...","authDomain":"...",...}' >> /etc/saas-gateway.env
echo 'YOOKASSA_SHOP_ID=...' >> /etc/saas-gateway.env
echo 'YOOKASSA_SECRET_KEY=...' >> /etc/saas-gateway.env
systemctl restart saas-gateway
```

## Биллинг (ЮKassa) — что сделать один раз после переноса

1. Добавить `YOOKASSA_SHOP_ID`/`YOOKASSA_SECRET_KEY` в `/etc/saas-gateway.env`
   (см. выше) и перезапустить сервис.
2. В личном кабинете ЮKassa → Настройки → API-ключи и HTTP-уведомления →
   указать адрес webhook'а: `https://pii.hookahpos.su/saas/billingWebhook`
   (замените домен, если у вас другой — тот же, что и у остальных ручек
   этого сервиса, см. `SAAS_GATEWAY_URL` в `console.js`). Раньше это был
   адрес Cloud Function `handleBillingWebhook` — если он там уже стоял,
   просто замените на новый.
3. Проверить: `curl -X POST https://pii.hookahpos.su/saas/billingWebhook`
   без тела должен вернуть `{"error":"bad request"}` (400) — значит,
   маршрут поднят и роутится правильно, а не 404.
4. В `saas/console/console.js` ничего дополнительно менять не нужно —
   `startCheckout()` уже обращается на `callSaasGateway('createCheckoutSession', ...)`,
   то есть на этот сервис, а не на Cloud Function.

## nginx — добавить маршрут `/saas/` к уже настроенному домену

Сервис использует тот же домен и сертификат, что и `pii-gateway`
(`pii.hookahpos.su`) — экономим ещё один цикл DNS+certbot. Добавьте в
`/etc/nginx/conf.d/pii-gateway.conf` внутри существующего блока `server {
listen 80/443 ...; server_name pii.hookahpos.su; ... }` ещё один `location`
ПЕРЕД блоком `location / { ... }` (порядок важен — nginx матчит более
специфичный префикс первым независимо от порядка в файле, но для
читаемости кладём его выше):

```nginx
location /saas/ {
    proxy_pass http://127.0.0.1:8081/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Обратите внимание на слэш в конце `proxy_pass http://127.0.0.1:8081/` — он
обрезает префикс `/saas/`, то есть запрос на `/saas/createTenant` уходит в
сервис как `/createTenant`. После правки: `nginx -t && systemctl reload
nginx`. Как только certbot выпустит сертификат для `pii.hookahpos.su`
(см. `pii-gateway/README.md`), он автоматически применится и к этому
`location` — отдельно ничего настраивать не нужно.

## Секреты репозитория GitHub, которые нужно завести/поменять

- **`SAAS_GATEWAY_URL`** (новый) — `https://pii.hookahpos.su/saas` — его
  подхватывает `saas/console/console.js` и Flutter-сборки.
- **`BUILD_CALLBACK_SECRET`** — то же значение, что вы ввели в `setup.sh`.
- **`SAAS_COMPLETE_BUILD_JOB_URL`** — поменять на
  `https://pii.hookahpos.su/saas/completeBuildJob` (раньше указывал на URL
  Cloud Function).

## Консоль (`saas/console/console.js`)

Отредактируйте константу `SAAS_GATEWAY_URL` в начале файла на реальный
адрес (`https://pii.hookahpos.su/saas`) — до этого момента она пустая, и
кнопки «Создать заведение» / «Собрать APK» будут показывать понятную
ошибку вместо тихого падения.

## Проверка перед боевым использованием

- `npm test` (в папке `saas-gateway`) — smoke-тест валидации входа, не
  требует живой БД/Firebase.
- `systemctl status saas-gateway` и `journalctl -u saas-gateway -f` —
  статус и логи сервиса на сервере.
- Полный путь (создание заведения в консоли → присоединение устройства →
  касса работает) стоит проверить вручную хотя бы раз, тем же способом,
  каким это делали для pii-gateway.

## Демо-режим

Кнопка «Демо» в приложении (см. `SaasDevicePairingScreen`) вызывает
`POST /saas/createDemoTenant` — сервис сам создаёт одноразовое заведение с
заготовленными столами/меню/PIN-кодами и возвращает код приглашения,
приложение сразу присоединяется тем же путём, что и обычное устройство.
Демо-заведения стираются сами через 3 часа (см. `scheduleDemoCleanup` в
`server.js`) — раз в 30 минут сервис ищет заведения с `demo: true` старше
этого возраста и полностью их удаляет. Ограничение — не больше 5
демо-заведений в час с одного IP (защита от накрутки).
