import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../build_info.dart';

/// Регистрация планшета кассы как рабочего устройства.
///
/// Гость тоже входит анонимно, поэтому персонал правила узнают по
/// документу устройства: в сборке одного заведения — staffDevices/{uid}
/// (создаётся с секретом meta/staffSecret), в SaaS — tenants/{id}/
/// devices/{uid} (SaasDeviceJoinService, по коду приглашения). Коллекция
/// выбирается по режиму.
class StaffDeviceService {

  String get _uid => FirebaseAuth.instance.currentUser?.uid ?? '';

  String get _collection => kSaasMode ? 'devices' : 'staffDevices';

  /// Устройство уже зарегистрировано как рабочее?
  Future<bool> isRegistered() async {
    if (_uid.isEmpty) return false;
    try {
      final doc = await AppScope.col(_collection).doc(_uid).get();
      return doc.exists;
    } catch (_) {
      return false;
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

  /// Снять регистрацию (планшет выводится из зала).
  Future<void> unregister(String uid) => AppScope.col(_collection).doc(uid).delete();

  Stream<QuerySnapshot<Map<String, dynamic>>> devicesStream() =>
      AppScope.col(_collection).snapshots();
}
