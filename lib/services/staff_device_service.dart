import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../build_info.dart';
import 'app_auth.dart';
import 'saas_device_join_service.dart';

/// Регистрация планшета кассы как рабочего устройства.
///
/// Гость тоже входит анонимно, поэтому персонал правила узнают по
/// документу устройства: в сборке одного заведения — staffDevices/{uid}
/// (создаётся с секретом meta/staffSecret), в SaaS — tenants/{id}/
/// devices/{uid} (SaasDeviceJoinService, по коду приглашения). Коллекция
/// выбирается по режиму.
class StaffDeviceService {

  String get _uid => AppAuth.instance.currentUser?.uid ?? '';

  String get _collection => kSaasMode ? 'devices' : 'staffDevices';

  /// Устройство уже зарегистрировано как рабочее? «Нет» — только ответ
  /// сервера (документа нет или правила его не отдают). Обрыв сети — не
  /// повод отправлять рабочий планшет на регистрацию: вход по PIN сам
  /// скажет, что нет связи.
  Future<bool> isRegistered() async {
    if (_uid.isEmpty) return false;
    try {
      final doc = await AppScope.col(_collection).doc(_uid).get();
      return doc.exists;
    } on FirebaseException catch (e) {
      return e.code != 'permission-denied';
    } catch (_) {
      return true;
    }
  }

  Stream<bool> registrationStream() {
    if (_uid.isEmpty) return Stream.value(false);
    return AppScope.col(_collection).doc(_uid).snapshots().map((d) => d.exists);
  }

  /// Зарегистрировать текущее устройство. Бросает исключение, если секрет
  /// не совпал (правило безопасности отклонит запись). Только одноарендная
  /// сборка — в SaaS регистрацию делает SaasDeviceJoinService.joinAsDevice().
  Future<void> register({
    required String secret,
    String deviceLabel = '',
  }) async {
    if (_uid.isEmpty) {
      throw StateError('Нет входа в Firebase — перезапустите приложение.');
    }
    await AppScope.col(_collection).doc(_uid).set({
      'secret': secret.trim(),
      'label': deviceLabel,
      'registeredAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  /// Уровень поддержки справочника людей в РФ (People): с ним касса
  /// работает в режиме rf — без имён и телефонов в Firestore.
  static const piiLevel = 1;

  /// Сообщить заведению, какая сборка стоит на этой кассе. Перевести
  /// заведение на хранение данных только в РФ можно, когда все его кассы
  /// это умеют (saas-gateway, pii-migrate.js). Не вышло — не страшно,
  /// сообщим при следующем запуске.
  Future<void> reportVersion() async {
    if (!kSaasMode || _uid.isEmpty || AppScope.tenantId == null || AppScope.isDemo) return;
    try {
      await AppScope.col('devices').doc(_uid).update({
        'appBuild': kBuildNumber,
        'piiReady': piiLevel,
        'seenAt': FieldValue.serverTimestamp(),
      });
    } catch (_) {}
    // Номер устройства — и у касс, подключённых до этой версии: следующая
    // переустановка на этом устройстве не добавит новое.
    unawaited(SaasDeviceJoinService().identifyDevice(AppScope.tenantId!));
  }

  /// Для чего используют это устройство: «Экран кухни», «Официант»,
  /// «Администратор». Владелец видит это в кабинете («Устройства») и на
  /// экране лимита — понятно, какой планшет можно удалить.
  static String _lastUsage = '';
  Future<void> reportUsage(String usage) async {
    final u = usage.trim();
    if (!kSaasMode || _uid.isEmpty || AppScope.tenantId == null || AppScope.isDemo || u.isEmpty || u == _lastUsage) return;
    _lastUsage = u;
    try {
      await AppScope.col('devices').doc(_uid).update({
        'usage': u.length > 40 ? u.substring(0, 40) : u,
        'seenAt': FieldValue.serverTimestamp(),
      });
    } catch (_) {}
  }

  /// Название этого устройства («Планшет у бара»); null — не удалось
  /// узнать (нет связи, не SaaS, демо) — тогда и не спрашиваем.
  Future<String?> deviceName() async {
    if (!kSaasMode || _uid.isEmpty || AppScope.tenantId == null || AppScope.isDemo) return null;
    try {
      final d = await AppScope.col('devices').doc(_uid).get().timeout(const Duration(seconds: 10));
      if (!d.exists) return null;
      return '${d.data()?['deviceName'] ?? ''}'.trim();
    } catch (_) {
      return null;
    }
  }

  /// Касса, подключённая без названия, называет себя один раз (правила
  /// разрешают только пока названия нет); дальше переименовывает кабинет.
  Future<void> setDeviceName(String name) async {
    final n = name.trim();
    await AppScope.col('devices').doc(_uid).update({
      'deviceName': n.length > 40 ? n.substring(0, 40) : n,
      'seenAt': FieldValue.serverTimestamp(),
    });
  }

  /// Снять регистрацию (планшет выводится из зала).
  Future<void> unregister(String uid) => AppScope.col(_collection).doc(uid).delete();

  Stream<QuerySnapshot<Map<String, dynamic>>> devicesStream() =>
      AppScope.col(_collection).snapshots();
}
