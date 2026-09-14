import 'package:shared_preferences/shared_preferences.dart';

/// Кто вошёл на этом планшете в прошлый раз.
///
/// Зачем. Приложение просило PIN при каждом запуске — а перезапускается оно
/// чаще, чем кажется: Android выгружает свёрнутое приложение сам, чтобы
/// освободить память. Кальянщик возвращался к планшету и снова набирал код,
/// хотя смена не менялась.
///
/// Хранится только id сотрудника — сам PIN на устройство не пишется. Этого
/// достаточно, чтобы восстановить вход, и нечего украсть, если планшет
/// попадёт не в те руки: id бесполезен без прав рабочего устройства, а их
/// даёт отдельная регистрация (staffDevices, см. firestore.rules).
///
/// Запись своя у каждого устройства: на планшете у бара может быть один
/// сотрудник, на планшете в зале — другой.
class StaffSessionStore {
  StaffSessionStore._();
  static final StaffSessionStore instance = StaffSessionStore._();

  static const _key = 'staff_last_employee_id';

  /// На кого с этого устройства открыли смену.
  ///
  /// Не то же самое, что вошедший. В маленькой кальянной планшет один: в
  /// него вошёл админ, а смену он открыл на кальянщика, который сегодня в
  /// зале. Уведомления адресованы кальянщику — но показать их надо именно
  /// на этом планшете, он же и стоит в зале. Планшет, с которого смену не
  /// открывали (например, телефон админа дома), так и останется тихим.
  static const _shiftOwnerKey = 'staff_shift_owner_id';

  /// Запомнить вошедшего — вызывается после успешного ввода PIN.
  Future<void> remember(String employeeId) async {
    if (employeeId.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, employeeId);
    } catch (_) {
      // Память недоступна — вход просто будет спрашиваться как раньше.
    }
  }

  /// Кто входил в прошлый раз. Пусто — спрашиваем PIN.
  Future<String> savedEmployeeId() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_key) ?? '';
    } catch (_) {
      return '';
    }
  }

  /// Запомнить, на кого с этого устройства открыли смену.
  Future<void> rememberShiftOwner(String employeeId) async {
    if (employeeId.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_shiftOwnerKey, employeeId);
    } catch (_) {}
  }

  /// На кого с этого устройства открывали смену в последний раз.
  Future<String> savedShiftOwnerId() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_shiftOwnerKey) ?? '';
    } catch (_) {
      return '';
    }
  }

  /// Забыть — «Сменить сотрудника» на экране и при выходе.
  Future<void> forget() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_key);
    } catch (_) {}
  }
}
