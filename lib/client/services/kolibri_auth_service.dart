import 'dart:math';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';

/// Авторизация гостя в «Колибри Лаундж».
///
/// Два режима:
///  • по номеру телефона (Firebase Phone Auth) — основной, даёт бонусы и
///    историю визитов на всех устройствах гостя;
///  • анонимный вход — чтобы посмотреть меню и забронировать стол «без
///    регистрации»; профиль потом можно повысить до телефонного.
class KolibriAuthService {
  final _auth = FirebaseAuth.instance;
  final _link = GuestLinkService();

  static const _shortIdKey = 'kolibri_short_device_id';

  User? get user => _auth.currentUser;
  String get uid => _auth.currentUser?.uid ?? '';
  bool get isAnonymous => _auth.currentUser?.isAnonymous ?? true;
  bool get signedIn => _auth.currentUser != null;

  Stream<User?> authStateChanges() => _auth.authStateChanges();

  /// Короткий ID устройства — 6 символов (буквы+цифры), хранится локально.
  /// Генерируется один раз и не меняется. Показывается гостю в профиле.
  Future<String> getShortDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(_shortIdKey) ?? '';
    if (id.isEmpty) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      final rng = Random.secure();
      id = List.generate(6, (_) => chars[rng.nextInt(chars.length)]).join();
      await prefs.setString(_shortIdKey, id);
    }
    return id;
  }

  /// Гарантирует, что есть хоть какой-то аккаунт (анонимный) и профиль
  /// в коллекции clients — иначе гость не сможет читать меню по правилам.
  Future<ClientProfile> ensureGuest() async {
    if (_auth.currentUser == null) {
      await _auth.signInAnonymously();
    }
    // Сохраняем shortDeviceId в профиль, чтобы кассир мог найти гостя по нему.
    final shortId = await getShortDeviceId();
    final profile = await _link.ensureProfile(uid);
    await _link.updateProfile(uid, {'shortDeviceId': shortId});
    return profile;
  }

  /// Шаг 1 телефонного входа: отправка SMS.
  /// [onCodeSent] получает verificationId для шага 2.
  Future<void> startPhoneSignIn({
    required String phone,
    required void Function(String verificationId) onCodeSent,
    required void Function(String error) onError,
    void Function()? onAutoVerified,
  }) async {
    await _auth.verifyPhoneNumber(
      phoneNumber: phone,
      timeout: const Duration(seconds: 60),
      verificationCompleted: (credential) async {
        // Android умеет автоматически подставлять код из SMS.
        await _linkOrSignIn(credential, phone);
        onAutoVerified?.call();
      },
      verificationFailed: (e) => onError(e.message ?? 'Не удалось отправить SMS'),
      codeSent: (verificationId, _) => onCodeSent(verificationId),
      codeAutoRetrievalTimeout: (_) {},
    );
  }

  /// Шаг 2: подтверждение кода из SMS.
  Future<ClientProfile> confirmPhoneCode({
    required String verificationId,
    required String smsCode,
    required String phone,
    String name = '',
  }) async {
    final credential = PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: smsCode,
    );
    await _linkOrSignIn(credential, phone);

    final profile = await _link.ensureProfile(uid, name: name, phone: phone);
    await _link.updateProfile(uid, {
      'phone': phone,
      if (name.isNotEmpty) 'name': name,
    });
    return profile;
  }

  /// Если гость уже ходил анонимно (есть брони, избранное) — привязываем
  /// телефон к тому же uid, чтобы история не потерялась. Если привязка
  /// невозможна (телефон уже занят другим аккаунтом) — обычный вход.
  Future<void> _linkOrSignIn(PhoneAuthCredential credential, String phone) async {
    final current = _auth.currentUser;
    if (current != null && current.isAnonymous) {
      try {
        await current.linkWithCredential(credential);
        return;
      } on FirebaseAuthException catch (e) {
        if (e.code != 'credential-already-in-use' && e.code != 'provider-already-linked') {
          rethrow;
        }
      }
    }
    await _auth.signInWithCredential(credential);
  }

  Future<void> signOut() => _auth.signOut();
}
