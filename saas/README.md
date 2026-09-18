# Colibri POS SaaS — Phase 1 (multi-tenancy foundation)

Эта папка — НЕ часть одно-арендного приложения в корне репозитория (то,
что обслуживает ваше живое заведение, продолжает работать без изменений
в проекте `hoocah-pos`). Здесь строится ОТДЕЛЬНАЯ SaaS-платформа для
множества независимых заведений, разворачиваемая в НОВОМ Firebase-проекте.

## Что уже сделано (Phase 1)

- **Модель данных**: `tenants/{tenantId}`, `tenantMembers/{tenantId_uid}`,
  `users/{uid}`, `superAdmins/{uid}`, плюс все рабочие коллекции заведения
  вложены под `tenants/{tenantId}/...` (столы, чеки, меню, гости, склад,
  брони и т.д. — полный список см. в `firestore.rules`).
- **Firestore Security Rules** (`firestore.rules`) — полная изоляция
  арендаторов: сотрудник/гость одного заведения не может прочитать или
  изменить данные другого, даже зная его `tenantId` и будучи авторизованным
  в том же проекте платформы. Роли `owner/admin/manager/employee` реально
  проверяются на уровне правил (не только в интерфейсе).
- **Автоматические security-тесты** (`test/firestore.rules.test.js`) —
  проверяют именно это: Tenant A → A разрешено, Tenant A → B запрещено, для
  сотрудников всех ролей и для гостей, плюс что tenant/членство нельзя
  создать в обход бэкенда. **26 тестов, все проходят** — запускались через
  реальный Firestore-эмулятор при подготовке этой фазы, а не только
  написаны на бумаге.
- **Cloud Functions** (`functions/index.js`): `createTenant` (единственный
  способ завести заведение — клиент не может создать `tenants/{id}`
  напрямую), `resolveTenantBySlug` (публичный branding по коду заведения),
  `enableTenant`/`disableTenant` (супер-админ), `calculateUsage`
  (ежедневный подсчёт usage для будущего Super Admin дашборда).
  `handleBillingWebhook` и `createBuildJob` — честные заготовки: провайдер
  биллинга не выбран, а API GitHub Actions для сборки APK не подключён, они
  явно и осмысленно отказывают вместо того, чтобы притворяться рабочими.
- **Storage Rules** (`storage.rules`) — брендинг/меню публичны на чтение,
  экспорты/сборки APK — только владельцу/админу заведения.
- **Dart-модели и сервис** (`lib/models/tenant_models.dart`,
  `lib/services/tenant_config_service.dart`) — `Tenant`, `TenantMember`,
  роли с иерархией, настройки длительности кальяна на заведение (замена
  хардкода 90 минут), брендинг, feature-флаги с приоритетом
  platform→plan→tenant, статус подписки, локальный кэш конфигурации с
  офлайн-грейс-периодом. **Пока не подключены к работающему приложению** —
  это отдельный шаг следующей фазы (см. "Что дальше").
- **Юнит-тесты** на всю эту логику — `test/logic_test.dart`, группы
  `SaaS: *` (20 тестов: статусы, роли, лимиты тарифов, приоритет
  feature-флагов, round-trip кэша).
- **Миграция** (`migrations/migrate-single-tenant-to-tenant.js`) — скрипт
  переноса данных вашего текущего живого заведения в SaaS-проект как
  первого арендатора, когда вы будете готовы (см. ниже — намеренно НЕ
  запускается автоматически).

## Чего в Phase 1 сознательно нет

- **Никакого UI** — ни Super Admin панели, ни онбординг-визарда, ни
  экрана APK-сборки. Это Phase 3/4/6 по ТЗ.
- **Биллинг не подключён** — провайдер (Stripe/YooKassa/CloudPayments)
  не выбран; `handleBillingWebhook` — заготовка.
- **APK-сборка по кнопке не работает** — нужно решить, как Cloud Function
  безопасно дёргает GitHub Actions конкретного репозитория (Personal
  Access Token в Secret Manager, права токена и т.д.); `createBuildJob` —
  заготовка.
- **Кастомные домены/поддомены** — не реализованы (Phase 3, TOR §27).
- **Существующее Flutter-приложение НЕ переведено на эту модель** — оно
  по-прежнему работает с плоскими коллекциями одного проекта. Подключение
  `TenantConfigService` к реальным экранам, замена PIN-логина на связку
  Firebase Auth (email/password для владельца) + членство + PIN поверх неё
  — отдельная, большая следующая фаза.

## Настройка нового SaaS-проекта

### 1. Создать Firebase-проект

Через [Firebase Console](https://console.firebase.google.com/) или CLI:

```bash
firebase projects:create <ваш-saas-project-id>
```

**Включите тариф Blaze** — Cloud Functions (scheduler, secrets, вызов
внешних API для биллинга/GitHub) недоступны на бесплатном Spark. Это
осознанное решение, принятое отдельно от бесплатного тарифа
одно-арендного проекта — see корневой README, раздел «Работа на
бесплатном тарифе Firebase (Spark)», который по-прежнему актуален для
вашего текущего заведения и никак не меняется этим переходом.

Впишите id проекта в `saas/.firebaserc` вместо
`REPLACE_WITH_YOUR_NEW_SAAS_PROJECT_ID`.

Включите в консоли: **Firestore Database**, **Authentication → Email/
Password** (владельцы заведений входят по-настоящему, не анонимно — в
отличие от гостей и планшетов, которые остаются анонимными), **Storage**.

### 2. Развернуть правила, индексы и функции

```bash
cd saas
firebase deploy --project <ваш-saas-project-id>
```

(из `saas/firebase.json` — деплоит firestore rules+indexes, storage rules
и functions за один раз).

### 3. Завести первого супер-администратора

Вручную в консоли Firestore нового проекта — коллекция `superAdmins`,
документ с id, равным вашему будущему Firebase Auth uid (создайте себе
аккаунт email/password в Authentication, скопируйте uid оттуда):

```json
{ "since": "2026-01-01T00:00:00Z" }
```

Это не автоматизируется намеренно — как и `staffSecret` в одно-арендной
версии, первый вход с правами платформы не может выдаваться самим
приложением.

### 4. Загрузить тарифы

```bash
cd saas/scripts && npm i
node seed-plans.js --project <ваш-saas-project-id> --key ./service-account.json
```

(файл `service-account.json` — из Firebase Console → Project settings →
Service accounts → Generate new private key; не коммитить в git).

### 5. Создать первое (тестовое) заведение

Из любого клиента с Firebase SDK, авторизованного email/password
(например, временный скрипт или `curl` к callable-функции), вызвать
`createTenant({ name: "Тестовая лаунж", slug: "test-lounge", planId: "start" })`.
Ответ содержит `tenantId` — дальше можно создать `tenants/{tenantId}/
settings/deviceInvite` уже существует (создаётся самой функцией) и её
код можно найти в Firestore-консоли, чтобы «присоединить» тестовое
устройство (создать `tenants/{tenantId}/devices/{uid}` с этим кодом, затем
`tenantMembers/{tenantId}_{uid}` с ролью `employee` — см.
`saas/firestore.rules` за точными условиями).

### 6. Запустить тесты изоляции арендаторов самостоятельно

```bash
cd saas/test && npm i
cd .. && npx firebase-tools emulators:exec --project colibri-saas-rules-test \
  --only firestore "cd test && npm test"
```

Ожидаемый результат: все тесты проходят (на момент написания — 26/26).
Любое изменение `firestore.rules` в будущем должно повторно проходить
этот набор ДО деплоя в реальный проект — именно так был пойман и исправлен
реальный баг при подготовке Phase 1 (общий catch-all правил тихо
перекрывал более узкие ограничения по ролям — см. комментарий в конце
`firestore.rules`).

### 7. Перенос вашего текущего заведения (когда будете готовы)

**Не раньше, чем Phase 1–3 обкатаны на тестовых заведениях.** Тогда:

```bash
cd saas/migrations && npm i
node migrate-single-tenant-to-tenant.js \
  --source-project hoocah-pos --source-key ./hoocah-key.json \
  --target-project <ваш-saas-project-id> --target-key ./saas-key.json \
  --tenant-id <tenantId, уже созданный через createTenant>
```

Ничего не удаляет и не меняет в `hoocah-pos` — только читает оттуда и
пишет в новый проект. Ваше текущее заведение продолжает работать всё это
время без остановки.

## Что дальше (следующие чек-ины)

1. **Подключение работающего приложения к tenant-модели**: решить, как
   POS-планшет и владелец заведения проходят путь Firebase Auth → User →
   Tenant Membership → Tenant Configuration (ТЗ §29) в реальном UI — новый
   экран входа для владельца (email/password), обновлённый экран
   регистрации устройства (код приглашения вместо общего `staffSecret`),
   и подключение `TenantConfigService` в `main.dart`.
2. **Runtime-брендинг**: применение `BrandingConfig` к `ThemeData`
   приложений и веб-версии.
3. **Экран Super Admin** (отдельный клиент или веб-панель — решить стек).
4. **APK-конвейер**: выбрать способ безопасного вызова GitHub Actions из
   Cloud Function, довести `createBuildJob` до рабочего состояния.
5. **Биллинг**: выбрать провайдера, реализовать `handleBillingWebhook`.
