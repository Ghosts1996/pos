import 'package:shared_preferences/shared_preferences.dart';

/// Кто вошёл на этом планшете в прошлый раз — чтобы не спрашивать PIN после
/// каждой выгрузки приложения системой.
///
/// Хранится только id сотрудника, PIN — нет: без прав рабочего устройства
/// id бесполезен. Запись у каждого устройства своя.
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
      // Хранилище недоступно — PIN спросим при входе.
    }
  }

  /// Кто входил в прошлый раз. Пусто — спрашиваем PIN.
  ///
  /// [fresh] — перечитать с диска: фоновая служба живёт в своём изоляте, и
  /// без этого не увидела бы, что на экране вошёл другой сотрудник.
  Future<String> savedEmployeeId({bool fresh = false}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (fresh) await prefs.reload();
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
