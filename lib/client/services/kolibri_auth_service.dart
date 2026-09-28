import 'dart:math';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';

/// Авторизация гостя в гостевом приложении — анонимный вход.
///
/// Телефон гость указывает в профиле, и первичная запись идёт через
/// шлюз в РФ (registerGuestProfile). Вход по SMS через Firebase Phone Auth
/// сознательно не используется: номер сначала попал бы на серверы Google
/// за рубежом, а это нарушает ч.5 ст.18 152-ФЗ (локализация ПДн).
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
  /// Каждый раз обновляет shortDeviceId — чтобы у старых профилей тоже
  /// появилось это поле после обновления приложения.
  Future<ClientProfile> ensureGuest() async {
    if (_auth.currentUser == null) {
      // Сохранённый вход поднимается с диска не мгновенно. Проверка
      // «пусто — значит входим заново» сразу после старта создавала гостю
      // НОВЫЙ анонимный аккаунт: бонусы, уровень и вся история визитов
      // оставались на прежнем, а гость видел пустой профиль. Сначала
      // дожидаемся восстановления.
      final restored = await _auth
          .authStateChanges()
          .first
          .timeout(const Duration(seconds: 8), onTimeout: () => null);
      if (restored == null) await _auth.signInAnonymously();
    }
    final shortId = await getShortDeviceId();
    final profile = await _link.ensureProfile(uid);
    // Всегда записываем shortDeviceId (идемпотентно — значение не меняется).
    await _link.updateProfile(uid, {'shortDeviceId': shortId});
    return profile;
  }

  Future<void> signOut() => _auth.signOut();
}
