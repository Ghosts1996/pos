import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'package:firebase_auth/firebase_auth.dart';

/// Регистрация POS-планшета как «рабочего устройства».
///
/// Зачем: после появления клиентского приложения «Colibri Lounge» в том же
/// проекте Firebase нельзя больше давать полный доступ всем анонимным
/// пользователям — гость тоже анонимный. Правила (firestore.rules) отличают
/// персонал по документу staffDevices/{uid}, который создаёт это устройство,
/// подтвердив секрет заведения.
///
/// Секрет хранится в meta/staffSecret (поле value) и задаётся один раз из
/// консоли Firebase. Администратор вводит его при установке приложения на
/// новый планшет — как «ключ от рабочего места».
class StaffDeviceService {

  String get _uid => FirebaseAuth.instance.currentUser?.uid ?? '';

  /// Устройство уже зарегистрировано как рабочее?
  Future<bool> isRegistered() async {
    if (_uid.isEmpty) return false;
    try {
      final doc = await AppScope.col('staffDevices').doc(_uid).get();
      return doc.exists;
    } catch (_) {
      return false;
    }
  }

  Stream<bool> registrationStream() {
    if (_uid.isEmpty) return Stream.value(false);
    return AppScope.col('staffDevices').doc(_uid).snapshots().map((d) => d.exists);
  }

  /// Зарегистрировать текущее устройство. Бросает исключение, если секрет
  /// не совпал (правило безопасности отклонит запись).
  Future<void> register({
    required String secret,
    String deviceLabel = '',
  }) async {
    if (_uid.isEmpty) {
      throw StateError('Нет входа в Firebase — перезапустите приложение.');
    }
    await AppScope.col('staffDevices').doc(_uid).set({
      'secret': secret.trim(),
      'label': deviceLabel,
      'registeredAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  /// Снять регистрацию (планшет выводится из зала).
  Future<void> unregister(String uid) => AppScope.col('staffDevices').doc(uid).delete();

  Stream<QuerySnapshot<Map<String, dynamic>>> devicesStream() =>
      AppScope.col('staffDevices').snapshots();
}
