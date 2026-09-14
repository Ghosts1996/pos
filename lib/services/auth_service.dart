import 'package:firebase_auth/firebase_auth.dart';

/// Анонимная авторизация в Firebase — нужна только для доступа к Firestore
/// по правилам безопасности. Реальный вход в приложение — по PIN-коду
/// сотрудника (см. FirestoreService.findByPin).
class AuthService {
  final _auth = FirebaseAuth.instance;

  /// Вход устройства. Анонимный, но ПОСТОЯННЫЙ: именно по этому uid
  /// правила базы узнают рабочий планшет (staffDevices/{uid}).
  ///
  /// Сохранённый вход Firebase поднимает с диска не мгновенно, и сразу
  /// после старта currentUser ещё пуст. Проверка «пусто — значит входим
  /// заново» в этот момент создавала НОВЫЙ анонимный аккаунт: планшет
  /// терял регистрацию рабочего устройства, база переставала отдавать ему
  /// данные, и вход по PIN падал с «нет связи». Поэтому сначала дожидаемся
  /// восстановления и только потом решаем.
  Future<void> ensureSignedIn() async {
    if (_auth.currentUser != null) return;
    final restored = await _auth
        .authStateChanges()
        .first
        .timeout(const Duration(seconds: 8), onTimeout: () => null);
    if (restored != null) return;
    await _auth.signInAnonymously();
  }
}
