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
`downloadBuild` (выдача готового личного APK владельцу), `publicGuestApk`
(скачивание гостевого APK по QR со стола — БЕЗ Firebase Auth: гость,
наведший камеру, не входил ни в один SaaS-аккаунт; отдаёт только
`type: "guest"`, кассу так получить нельзя ни при каком slug) и модерация
из панели супер-админа — `enableTenant`/`disableTenant`/`changeTenantPlan`/
`deleteDemoTenant` (эти четыре тоже раньше числились Cloud Functions,
просто ещё не задеплоенными — кнопки в консоли звали их и молча
проваливались, пока платформой реально не начали пользоваться).

**Что НЕ переехало** (сознательно, см. обсуждение с владельцем платформы):
приём оплаты через ЮKassa, приглашение сотрудников по email — остаются на
Cloud Functions/Blaze. На момент внедрения платформа ещё не принимает
реальные платежи, так что это не блокирует текущий этап.

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
