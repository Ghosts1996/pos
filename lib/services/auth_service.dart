import 'package:firebase_auth/firebase_auth.dart';
import 'app_auth.dart';

/// Анонимная авторизация в Firebase — нужна только для доступа к Firestore
/// по правилам безопасности. Реальный вход в приложение — по PIN-коду
/// сотрудника (см. FirestoreService.findByPin).
class AuthService {
  final _auth = AppAuth.instance;

  /// Вход устройства — анонимный, но постоянный: по этому uid правила
  /// узнают рабочий планшет. Сохранённый вход Firebase поднимает с диска не
  /// сразу, поэтому сначала ждём восстановления — иначе создался бы новый
  /// аккаунт и планшет потерял бы регистрацию.
  Future<void> ensureSignedIn() async {
    if (_auth.currentUser == null) {
      final restored = await _auth
          .authStateChanges()
          .first
          .timeout(const Duration(seconds: 8), onTimeout: () => null);
      if (restored == null) {
        await _auth.signInAnonymously();
        return;
      }
    }
    await recoverDeadSession();
  }

  /// Вход на диске указывает на аккаунт, которого на сервере больше нет
  /// (выключен или удалён): с ним касса получала «нет доступа» везде, даже
  /// при новом присоединении к заведению. Такой вход сбрасываем и входим
  /// заново — устройство просто присоединяется ещё раз. Нет связи — ничего
  /// не трогаем: касса работает без интернета на старом входе.
  static const deadSessionCodes = {'user-not-found', 'user-token-expired', 'user-disabled', 'invalid-user-token'};

  Future<bool> recoverDeadSession() async {
    final user = _auth.currentUser;
    if (user == null) return false;
    try {
      await user.getIdToken(true).timeout(const Duration(seconds: 10));
      return false;
    } on FirebaseAuthException catch (e) {
      if (!deadSessionCodes.contains(e.code)) return false;
      await _auth.signOut();
      await _auth.signInAnonymously();
      return true;
    } catch (_) {
      return false;
    }
  }
}
