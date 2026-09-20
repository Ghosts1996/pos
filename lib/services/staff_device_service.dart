import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../build_info.dart';

/// Регистрация POS-планшета как «рабочего устройства».
///
/// Зачем: после появления клиентского приложения «Colibri Lounge» в том же
/// проекте Firebase нельзя больше давать полный доступ всем анонимным
/// пользователям — гость тоже анонимный. Правила (firestore.rules) отличают
/// персонал по документу staffDevices/{uid} (одноарендная сборка) —
/// устройство создаёт его само, подтвердив секрет заведения (meta/
/// staffSecret, поле value, задаётся один раз из консоли Firebase;
/// администратор вводит его при установке приложения на новый планшет).
///
/// В SaaS-сборке (kSaasMode) этот секрет не существует вообще — присоединение
/// планшета идёт через SaasDeviceJoinService.joinAsDevice() по коду
/// приглашения заведения, и он пишет в ДРУГУЮ коллекцию — tenants/{id}/
/// devices/{uid} (см. saas/firestore.rules, match /tenants/{tenantId}/
/// devices/{deviceId}). Поэтому имя коллекции здесь выбирается по режиму —
/// раньше оно было жёстко "staffDevices" даже в SaaS, из-за чего успешно
/// присоединившееся устройство ВСЕГДА выглядело незарегистрированным
/// (LoginScreen проверял staffDevices, а не devices) и откатывалось на этот
/// одноарендный экран с секретом, которого в SaaS не бывает.
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
