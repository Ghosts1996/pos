import 'package:firebase_auth/firebase_auth.dart';

/// Анонимная авторизация в Firebase — нужна только для доступа к Firestore
/// по правилам безопасности. Реальный вход в приложение — по PIN-коду
/// сотрудника (см. FirestoreService.findByPin).
class AuthService {
  final _auth = FirebaseAuth.instance;

  /// Вход устройства — анонимный, но постоянный: по этому uid правила
  /// узнают рабочий планшет. Сохранённый вход Firebase поднимает с диска не
  /// сразу, поэтому сначала ждём восстановления — иначе создался бы новый
  /// аккаунт и планшет потерял бы регистрацию.
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
