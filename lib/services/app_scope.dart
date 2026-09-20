import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/tenant_models.dart';

/// Единая точка входа в Firestore для ВСЕХ сервисов приложения.
///
/// По умолчанию (`tenantId == null`) ведёт себя ТОЧНО как прямой вызов
/// `FirebaseFirestore.instance.collection(...)` — плоские коллекции
/// верхнего уровня, как в одно-арендной версии. Это гарантирует, что
/// существующее развёртывание (hoocah-pos) не меняет поведение ни на йоту,
/// пока SaaS-режим не включён явно вызовом [enterTenant].
///
/// Когда SaaS-режим включён, каждый вызов [col]/[doc] автоматически
/// подставляет префикс `tenants/{tenantId}/` — благодаря этому ни одному
/// из ~35 файлов сервисов и экранов не пришлось переписывать бизнес-логику:
/// изменилось только ТО, ЧЕРЕЗ ЧТО они обращаются к базе (было
/// `FirebaseFirestore.instance.collection('sessions')`, стало
/// `AppScope.col('sessions')`), а не КАК они читают/пишут данные.
///
/// Не требует интерцепции `.doc()`/`.where()`/`.snapshots()` и т.п. —
/// они вызываются УЖЕ на результате [col]/[doc], то есть на настоящем
/// `CollectionReference`/`DocumentReference` с уже правильным (вложенным
/// или плоским) путём, и работают через обычный Firestore SDK без изменений.
/// Транзакции и батчи (`FirebaseFirestore.instance.runTransaction/batch`)
/// тоже не нуждаются в обёртке: они лишь читают/пишут по уже переданным им
/// ссылкам на документы, которые сервис получил через [col]/[doc] заранее.
class AppScope {
  AppScope._();

  static String? _tenantId;
  static BrandingConfig? _branding;
  static String? _slug;

  /// null — одно-арендный режим (как было исторически). Непустая строка —
  /// SaaS-режим, все обращения к данным вложены под этого арендатора.
  static String? get tenantId => _tenantId;

  static bool get isSaasMode => _tenantId != null;

  /// Брендинг текущего заведения (имя, логотип, цвета) — задаётся вместе с
  /// [enterTenant], читается экранами, которым сама тема (AppTheme.branded)
  /// не подходит напрямую (например LoginScreen рисует свои цвета
  /// литералами, а не через Theme.of(context)). null в одно-арендном
  /// режиме — экраны в этом случае показывают свои прежние значения.
  static BrandingConfig? get branding => _branding;

  /// Код заведения (tenants/{id}.slug, тот же, что владелец видит в личном
  /// кабинете) — задаётся вместе с [enterTenant]. Нужен там, где адрес
  /// должен быть человекочитаемым, а не голым tenantId: например, QR-код
  /// стола в SaaS-режиме ведёт на поддомен `{slug}.hookahpos.su`, а не на
  /// `{tenantId}.hookahpos.su` (см. TableQrScreen). null в одно-арендном
  /// режиме.
  static String? get slug => _slug;

  /// Включает SaaS-режим для текущего процесса приложения — вызывается
  /// один раз, когда TenantConfigService успешно определил заведение
  /// пользователя (или устройство подтвердило код приглашения). Что именно
  /// вызывает это на старте — решает main.dart/kolibri_main.dart, сам
  /// AppScope ничего не знает про Auth/логины.
  static void enterTenant(String tenantId, {BrandingConfig? branding, String? slug}) {
    if (tenantId.trim().isEmpty) {
      throw ArgumentError('tenantId не может быть пустым');
    }
    _tenantId = tenantId;
    _branding = branding;
    _slug = slug;
  }

  /// Возврат в одно-арендный режим (например, выход из SaaS-аккаунта или
  /// смена заведения на планшете).
  static void reset() {
    _tenantId = null;
    _branding = null;
    _slug = null;
  }

  /// Коллекция [name] — при выключенном SaaS-режиме идентична прямому
  /// `FirebaseFirestore.instance.collection(name)`.
  static CollectionReference<Map<String, dynamic>> col(String name) {
    return FirebaseFirestore.instance.collection(scopedPath(_tenantId, name));
  }

  /// Документ по составному пути вида `"meta/aiSettings"` — для обычного
  /// случая `коллекция.doc(id)` используйте `AppScope.col(name).doc(id)`,
  /// этот метод — только для мест, где путь и так уже "коллекция/документ"
  /// одной строкой (раньше — `FirebaseFirestore.instance.doc('meta/x')`).
  static DocumentReference<Map<String, dynamic>> doc(String path) {
    return FirebaseFirestore.instance.doc(scopedPath(_tenantId, path));
  }
}

/// Чистая функция построения пути — вынесена отдельно от [AppScope.col]/
/// [AppScope.doc], чтобы её можно было проверить юнит-тестом без реального
/// Firebase-приложения (`FirebaseFirestore.instance` требует
/// `Firebase.initializeApp()`, которого в обычных `flutter test` нет).
String scopedPath(String? tenantId, String path) {
  return tenantId == null ? path : 'tenants/$tenantId/$path';
}
