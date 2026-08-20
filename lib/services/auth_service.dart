import 'package:firebase_auth/firebase_auth.dart';

/// Анонимная авторизация в Firebase — нужна только для доступа к Firestore
/// по правилам безопасности. Реальный вход в приложение — по PIN-коду
/// сотрудника (см. FirestoreService.findByPin).
class AuthService {
  final _auth = FirebaseAuth.instance;

  Future<void> ensureSignedIn() async {
    if (_auth.currentUser == null) {
      await _auth.signInAnonymously();
    }
  }
}
