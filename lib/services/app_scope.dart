import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/tenant_models.dart';

/// Единая точка входа в Firestore для всех сервисов.
///
/// Без заведения ([enterTenant] не вызывали) — плоские коллекции, как в
/// сборке одного заведения (hoocah-pos). В SaaS [col]/[doc] подставляют
/// префикс `tenants/{tenantId}/`, так что сервисам не нужно знать режим.
/// Запросы, транзакции и батчи работают на уже полученных ссылках и обёртки
/// не требуют.
class AppScope {
  AppScope._();

  static String? _tenantId;
  static BrandingConfig? _branding;
  static String? _slug;
  static String? _chainId;

  /// null — одно-арендный режим (как было исторически). Непустая строка —
  /// SaaS-режим, все обращения к данным вложены под этого арендатора.
  static String? get tenantId => _tenantId;

  static bool get isSaasMode => _tenantId != null;

  /// Сеть заведений (chains/{chainId}, см. её docstring в
  /// saas/firestore.rules) — null у одиночного заведения (подавляющее
  /// большинство): тогда [loyaltyCol] ничем не отличается от [col].
  /// Непустая строка — общий биллинг/лояльность нескольких точек сети.
  static String? get chainId => _chainId;

  /// Открыто демо-заведение — экран входа подсказывает PIN-коды.
  static bool _demo = false;
  static bool get isDemo => _demo;

  /// Брендинг текущего заведения (имя, логотип, цвета) — задаётся вместе с
  /// [enterTenant]. Касса оформлена в едином стиле ZalPOS и берёт отсюда
  /// только название заведения: подпись на экране входа, чек, QR-коды
  /// столов. null в одно-арендном режиме.
  static BrandingConfig? get branding => _branding;

  /// Код заведения (tenants/{id}.slug, тот же, что владелец видит в личном
  /// кабинете) — задаётся вместе с [enterTenant]. Нужен там, где адрес
  /// должен быть человекочитаемым, а не голым tenantId: например, QR-код
  /// стола в SaaS-режиме ведёт на поддомен `{slug}.zalpos.ru`, а не на
  /// `{tenantId}.zalpos.ru` (см. TableQrScreen). null в одно-арендном
  /// режиме.
  static String? get slug => _slug;

  /// Включает SaaS-режим для текущего процесса приложения — вызывается
  /// один раз, когда TenantConfigService успешно определил заведение
  /// пользователя (или устройство подтвердило код приглашения). Что именно
  /// вызывает это на старте — решает main.dart/kolibri_main.dart, сам
  /// AppScope ничего не знает про Auth/логины.
  static void enterTenant(String tenantId,
      {BrandingConfig? branding, String? slug, String? chainId, bool demo = false}) {
    if (tenantId.trim().isEmpty) {
      throw ArgumentError('tenantId не может быть пустым');
    }
    _tenantId = tenantId;
    _branding = branding;
    _slug = slug;
    _chainId = (chainId != null && chainId.isNotEmpty) ? chainId : null;
    _demo = demo;
  }

  /// Возврат в одно-арендный режим (например, выход из SaaS-аккаунта или
  /// смена заведения на планшете).
  static void reset() {
    _tenantId = null;
    _branding = null;
    _slug = null;
    _chainId = null;
    _demo = false;
  }

  /// Коллекция [name] — при выключенном SaaS-режиме идентична прямому
  /// `FirebaseFirestore.instance.collection(name)`.
  static CollectionReference<Map<String, dynamic>> col(String name) {
    return FirebaseFirestore.instance.collection(scopedPath(_tenantId, name));
  }

  /// Документ по пути «коллекция/документ» одной строкой, например
  /// `"meta/aiSettings"`. Для обычного случая — `AppScope.col(name).doc(id)`.
  static DocumentReference<Map<String, dynamic>> doc(String path) {
    return FirebaseFirestore.instance.doc(scopedPath(_tenantId, path));
  }

  /// Коллекции лояльности (clients, phoneIndex, referralCodes,
  /// bonusOperations…). У точки сети они в `chains/{chainId}/...` — баланс и
  /// история гостя общие на все точки; у одиночного заведения — как [col].
  /// Лояльность всегда читаем и пишем через этот метод.
  static CollectionReference<Map<String, dynamic>> loyaltyCol(String name) {
    if (_chainId == null) return col(name);
    return FirebaseFirestore.instance.collection('chains/$_chainId/$name');
  }
}

/// Чистая функция построения пути — вынесена отдельно от [AppScope.col]/
/// [AppScope.doc], чтобы её можно было проверить юнит-тестом без реального
/// Firebase-приложения (`FirebaseFirestore.instance` требует
/// `Firebase.initializeApp()`, которого в обычных `flutter test` нет).
String scopedPath(String? tenantId, String path) {
  return tenantId == null ? path : 'tenants/$tenantId/$path';
}
