/// Номер сборки APK — `--dart-define=BUILD_NUMBER=<номер запуска>` в CI,
/// локально `dev`. Показывается в профиле: приложения ставят файлом, и без
/// номера не понять, свежая ли версия на телефоне.
const String kBuildNumber = String.fromEnvironment(
  'BUILD_NUMBER',
  defaultValue: 'dev',
);

/// true — сборка платформы (`--dart-define=SAAS_MODE=true`): свой
/// Firebase-проект, вход по коду приглашения устройства, данные через
/// AppScope с tenantId. false — сборка одного заведения: анонимный вход,
/// общий секрет, плоские коллекции (build-apk.yml флаг не ставит).
const bool kSaasMode = bool.fromEnvironment('SAAS_MODE');

/// true — сборка из конвейера «Собрать APK» (saas-on-demand-build.yml,
/// `--dart-define=IN_APP_UPDATES=true`): приложение само узнаёт о новой
/// версии своего заведения и ставит её поверх (см. AppUpdateService).
/// У публичной универсальной сборки и одно-арендных APK номера сборок идут
/// из других workflow и между собой не сравнимы — там выключено.
const bool kInAppUpdates = bool.fromEnvironment('IN_APP_UPDATES');

/// URL шлюза первичной записи персональных данных гостей (имя/телефон) —
/// см. `pii-gateway/README.md`. Задаётся в CI:
/// `--dart-define=PII_GATEWAY_URL=https://...`.
///
/// Пусто по умолчанию — [PiiGatewayService] в этом случае явно бросает
/// исключение при попытке вызова, а не тихо шлёт данные мимо шлюза: молча
/// продолжать работу без него означало бы, что имя и телефон гостя опять
/// пишутся напрямую в Firestore в обход требования о локализации, ради
/// которого шлюз и существует (см. ст. 18 ч.5 152-ФЗ и раздел 7 политики
/// конфиденциальности на сайте платформы).
const String kPiiGatewayUrl = String.fromEnvironment('PII_GATEWAY_URL');

/// Адрес сервиса, который берёт на себя createTenant/createBuildJob/
/// resolveTenantBySlug/createDemoTenant — см. `saas-gateway/README.md`.
/// Нужен только в SaaS-режиме ([kSaasMode]): без Blaze у проекта
/// `saas-3bdc8` эти операции не могут идти через Cloud Functions.
/// Задаётся в CI: `--dart-define=SAAS_GATEWAY_URL=https://...`.
const String kSaasGatewayUrl = String.fromEnvironment('SAAS_GATEWAY_URL');

/// Код заведения и код приглашения устройства, запечённые в конкретную
/// сборку APK владельца (см. saas-on-demand-build.yml, шаги createBuildJob →
/// GitHub workflow_dispatch → `--dart-define=SAAS_PRESET_SLUG=...`/
/// `SAAS_PRESET_INVITE_CODE=...`).
///
/// Пусто у УНИВЕРСАЛЬНОЙ сборки (собранной без конкретного заведения,
/// например для публичной кнопки «Скачать» на сайте) — там
/// [SaasDevicePairingScreen] по-прежнему показывает форму ручного ввода.
/// Непусто у сборки, заказанной конкретным владельцем через «Собрать APK» в
/// личном кабинете, — экран присоединения тогда сразу и без участия
/// пользователя подключает устройство к ЕГО заведению.
const String kSaasPresetSlug = String.fromEnvironment('SAAS_PRESET_SLUG');
const String kSaasPresetInviteCode = String.fromEnvironment('SAAS_PRESET_INVITE_CODE');

/// Код сети, зашитый в приложение гостя сети: одно приложение на все точки,
/// гость выбирает точку при запуске. Касса к этому отношения не имеет — у
/// каждой точки свой APK кассы. В сборке гостя непуст ровно один из двух:
/// [kSaasPresetSlug] или этот код.
const String kSaasPresetChainSlug = String.fromEnvironment('SAAS_PRESET_CHAIN_SLUG');

/// Публичное демо приложения гостя (кнопка на сайте): без заведения в
/// сборке — гость вводит код демо-сети из кассы в демо-режиме или
/// открывает новую демо-сеть (kolibri_main.dart, KolibriDemoEntryScreen).
const bool kSaasGuestDemo = bool.fromEnvironment('SAAS_GUEST_DEMO');

/// Код сети, к которой привязан сохранённый выбор заведения: приложение
/// другой сети (или демо), поставленное поверх, чужой выбор не берёт.
const String kChainSlugCacheKey = 'saas_kolibri_chain_slug_v1';

/// Ключи SharedPreferences, под которыми гостевая сборка для сети хранит
/// выбранную гостем точку (см. kolibri_main.dart, _KolibriChainBootstrap) —
/// вынесены сюда (а не private-константы в kolibri_main.dart), потому что
/// экран профиля (KolibriProfileScreen, «Сменить заведение сети») должен
/// уметь их же очистить, не создавая циклический импорт между экраном и
/// точкой входа приложения.
const String kChainLocationCacheKey = 'saas_kolibri_chain_location_tenant_id_v1';
const String kChainIdCacheKey = 'saas_kolibri_chain_id_v1';
