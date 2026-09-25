/// Номер сборки, из которой собран этот APK.
///
/// Проставляется в CI: `--dart-define=BUILD_NUMBER=<номер запуска>`. Без
/// него (локальный запуск) остаётся `dev`.
///
/// Зачем это нужно. Приложения ставятся вручную, файлом с Яндекс Диска, и
/// по экрану невозможно понять, какая версия стоит на конкретном телефоне.
/// Из-за этого уже разбирались с «багом», которого в коде не было: на
/// телефоне просто стояла старая сборка. Теперь номер видно в профиле, и
/// вопрос «а свежая ли у тебя версия?» решается за секунду.
const String kBuildNumber = String.fromEnvironment(
  'BUILD_NUMBER',
  defaultValue: 'dev',
);

/// true — сборка SaaS-платформы (`--dart-define=SAAS_MODE=true` в CI),
/// работает против отдельного multi-tenant Firebase-проекта (см. `saas/`):
/// вход по email/пароль + код приглашения устройства вместо общего
/// staffSecret, данные читаются через AppScope с учётом tenantId.
///
/// false (по умолчанию) — обычная сборка одного заведения, как раньше:
/// анонимный вход, общий секрет заведения, плоские коллекции. Существующий
/// build-apk.yml этот флаг не выставляет, поэтому уже собранные и
/// собираемые сейчас APK ведут себя ровно как до появления SaaS-режима.
const bool kSaasMode = bool.fromEnvironment('SAAS_MODE');

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

/// Код СЕТИ заведений (chains/{chainId}, см. её docstring в
/// saas/firestore.rules), запечённый в гостевую сборку Kolibri для сети —
/// заказывается владельцем сети как ОДНО приложение сразу на все точки, а
/// не отдельная сборка на каждую (см. kolibri_main.dart, экран выбора
/// заведения). Не имеет отношения к POS-сборке — у кассы каждая точка
/// сети остаётся отдельным устройством/APK со своим kSaasPresetSlug, как
/// и у одиночного заведения: сеть влияет только на то, КАК гость выбирает
/// точку и куда смотрит его лояльность, а не на кассу.
///
/// Ровно один из двух непуст в конкретной гостевой сборке: одиночное
/// заведение печёт [kSaasPresetSlug] своей единственной точки, сеть —
/// этот код вместо него.
const String kSaasPresetChainSlug = String.fromEnvironment('SAAS_PRESET_CHAIN_SLUG');

/// Ключи SharedPreferences, под которыми гостевая сборка для сети хранит
/// выбранную гостем точку (см. kolibri_main.dart, _KolibriChainBootstrap) —
/// вынесены сюда (а не private-константы в kolibri_main.dart), потому что
/// экран профиля (KolibriProfileScreen, «Сменить заведение сети») должен
/// уметь их же очистить, не создавая циклический импорт между экраном и
/// точкой входа приложения.
const String kChainLocationCacheKey = 'saas_kolibri_chain_location_tenant_id_v1';
const String kChainIdCacheKey = 'saas_kolibri_chain_id_v1';
