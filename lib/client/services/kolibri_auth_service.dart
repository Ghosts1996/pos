import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../build_info.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';

enum _Restore { restored, unavailable, failed }

/// Авторизация гостя в гостевом приложении — анонимный вход.
///
/// Телефон гость указывает в профиле, и первичная запись идёт через
/// шлюз в РФ (registerGuestProfile). Вход по SMS через Firebase Phone Auth
/// сознательно не используется: номер сначала попал бы на серверы Google
/// за рубежом, а это нарушает ч.5 ст.18 152-ФЗ (локализация ПДн).
///
/// Номер и бонусы гостя держатся на анонимной сессии Firebase. Чтобы они не
/// терялись, если сессия пропала (слетела после обновления, аккаунт пропал
/// на сервере), приложение хранит ключ восстановления: случайный секрет,
/// отпечаток которого лежит на saas-gateway (/registerGuestRecovery). По нему
/// возвращается вход в тот же аккаунт (/restoreGuestSession).
class KolibriAuthService {
  final _auth = FirebaseAuth.instance;
  final _link = GuestLinkService();

  static const _shortIdKey = 'kolibri_short_device_id';
  static const _recoveryUidKey = 'kolibri_recovery_uid';
  static const _recoverySecretKey = 'kolibri_recovery_secret';
  static const _recoveryRegisteredKey = 'kolibri_recovery_registered_uid';

  /// Коды, при которых сессия на диске указывает на аккаунт, которого на
  /// сервере уже нет, — её нужно сбросить и восстановить.
  static const _deadSessionCodes = {'user-not-found', 'user-token-expired', 'user-disabled', 'invalid-user-token'};

  /// Один вход на всё приложение: оболочка, deep link и экран QR могут
  /// позвать ensureGuest одновременно — второй анонимный аккаунт не нужен.
  static Future<ClientProfile>? _pending;

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
  /// Каждый раз обновляет shortDeviceId — чтобы у старых профилей тоже
  /// появилось это поле после обновления приложения.
  Future<ClientProfile> ensureGuest() {
    final running = _pending;
    if (running != null) return running;
    final next = _ensureGuest();
    _pending = next;
    return next.whenComplete(() => _pending = null);
  }

  Future<ClientProfile> _ensureGuest() async {
    // Сохранённый вход поднимается с диска не мгновенно. Проверка
    // «пусто — значит входим заново» сразу после старта создавала гостю
    // НОВЫЙ анонимный аккаунт: бонусы, уровень и вся история визитов
    // оставались на прежнем, а гость видел пустой профиль. Сначала
    // дожидаемся восстановления.
    var current = _auth.currentUser ??
        await _auth.authStateChanges().first.timeout(const Duration(seconds: 8), onTimeout: () => null);
    if (current != null) {
      try {
        await current.getIdToken();
      } on FirebaseAuthException catch (e) {
        if (!_deadSessionCodes.contains(e.code)) rethrow;
        await _auth.signOut();
        current = null;
      }
    }
    if (current == null) {
      switch (await _restoreSession()) {
        case _Restore.restored:
          break;
        case _Restore.unavailable:
          await _auth.signInAnonymously();
        case _Restore.failed:
          // Новый аккаунт здесь навсегда отрезал бы гостя от прежнего
          // профиля — лучше попросить повторить, когда будет связь.
          throw StateError('Не удалось восстановить вход — проверьте интернет и перезапустите приложение.');
      }
    }
    final shortId = await getShortDeviceId();
    final profile = await _link.ensureProfile(uid);
    // Всегда записываем shortDeviceId (идемпотентно — значение не меняется).
    await _link.updateProfile(uid, {'shortDeviceId': shortId});
    unawaited(_registerRecovery());
    return profile;
  }

  /// Вход в прежний аккаунт по ключу восстановления.
  Future<_Restore> _restoreSession() async {
    if (!kSaasMode || kSaasGatewayUrl.isEmpty) return _Restore.unavailable;
    final prefs = await SharedPreferences.getInstance();
    final uid = prefs.getString(_recoveryUidKey);
    final secret = prefs.getString(_recoverySecretKey);
    if (uid == null || secret == null || prefs.getString(_recoveryRegisteredKey) != uid) {
      return _Restore.unavailable;
    }
    try {
      final resp = await http
          .post(
            Uri.parse('$kSaasGatewayUrl/restoreGuestSession'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'uid': uid, 'secret': secret}),
          )
          .timeout(const Duration(seconds: 15));
      if (resp.statusCode == 400 || resp.statusCode == 403) {
        // Ключ не принят (гость удалил данные, аккаунт не гостевой) —
        // восстанавливать нечего.
        await forgetDevice();
        return _Restore.unavailable;
      }
      if (resp.statusCode != 200) return _Restore.failed;
      final token = (jsonDecode(resp.body) as Map<String, dynamic>)['token'] as String?;
      if (token == null || token.isEmpty) return _Restore.failed;
      await _auth.signInWithCustomToken(token);
      return _auth.currentUser?.uid == uid ? _Restore.restored : _Restore.failed;
    } catch (_) {
      return _Restore.failed;
    }
  }

  /// Ключ восстановления для текущего аккаунта: создаётся один раз на
  /// аккаунт, на сервер уходит только для запоминания отпечатка. Ошибки не
  /// пробрасывает — попробуем при следующем запуске.
  Future<void> _registerRecovery() async {
    final current = _auth.currentUser;
    if (!kSaasMode || kSaasGatewayUrl.isEmpty || current == null) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getString(_recoveryUidKey) != current.uid || prefs.getString(_recoverySecretKey) == null) {
        final rng = Random.secure();
        final bytes = List<int>.generate(32, (_) => rng.nextInt(256));
        await prefs.setString(_recoverySecretKey, base64Url.encode(bytes).replaceAll('=', ''));
        await prefs.setString(_recoveryUidKey, current.uid);
        await prefs.remove(_recoveryRegisteredKey);
      }
      if (prefs.getString(_recoveryRegisteredKey) == current.uid) return;
      final token = await current.getIdToken();
      final resp = await http
          .post(
            Uri.parse('$kSaasGatewayUrl/registerGuestRecovery'),
            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
            body: jsonEncode({'secret': prefs.getString(_recoverySecretKey)}),
          )
          .timeout(const Duration(seconds: 15));
      if (resp.statusCode == 200) await prefs.setString(_recoveryRegisteredKey, current.uid);
    } catch (_) {}
  }

  /// Забыть ключ восстановления — гость удалил свои данные.
  Future<void> forgetDevice() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_recoveryUidKey);
    await prefs.remove(_recoverySecretKey);
    await prefs.remove(_recoveryRegisteredKey);
  }

  Future<void> signOut() => _auth.signOut();
}
