import 'package:shared_preferences/shared_preferences.dart';

import 'server_clock.dart';

/// «Аренда без связи» кассы (только SaaS): касса работает без интернета, но
/// не бесконечно. Иначе подписку можно было бы не продлевать, просто
/// переведя планшет в авиарежим до блокировки, — сервер о кассе не знает,
/// а сама она срок оплаты не проверяла бы.
///
/// Правила:
/// * связи с сервером не было дольше [maxOffline] — касса просит выйти в
///   интернет (по закону чеки всё равно нужно передать в ОФД за 30 дней);
/// * оплаченный срок (пробный или оплаченный период) закончился больше
///   [graceAfterPaid] назад, а связи с тех пор не было — касса закрыта и без
///   интернета; как только связь есть, сервер сам скажет, оплачено ли;
/// * перевод часов назад не помогает: «сейчас» — не раньше самого позднего
///   времени, которое касса уже видела ([_maxSeen], хранится в памяти
///   устройства).
class OfflineLease {
  OfflineLease._();

  static const maxOffline = Duration(days: 14);
  static const graceAfterPaid = Duration(days: 3);

  /// За сколько до остановки предупреждать.
  static const warnBefore = Duration(days: 3);

  static String _tenant = '';
  static DateTime? _lastContact;
  static DateTime? _paidUntil;
  static DateTime? _maxSeen;
  static DateTime? _savedAt;

  static String _key(String name) => 'lease:$_tenant:$name';

  /// Последняя связь с сервером — для тестов и экрана.
  static DateTime? get lastContact => _lastContact;
  static DateTime? get paidUntil => _paidUntil;

  /// Загрузить из памяти устройства (при входе в заведение). Первый запуск
  /// на устройстве — связь «только что была»: касса без связи в заведение
  /// не войдёт.
  static Future<void> load(String tenantId) async {
    _tenant = tenantId;
    _lastContact = _paidUntil = _maxSeen = null;
    try {
      final p = await SharedPreferences.getInstance();
      DateTime? read(String n) {
        final v = p.getInt(_key(n));
        return v == null ? null : DateTime.fromMillisecondsSinceEpoch(v, isUtc: true);
      }

      _lastContact = read('contact');
      _paidUntil = read('paid');
      _maxSeen = read('seen');
    } catch (_) {}
    _lastContact ??= now();
    _maxSeen ??= _lastContact;
    await _save(force: true);
  }

  /// Сейчас — не раньше самого позднего виденного времени (перевод часов
  /// назад «сейчас» не отматывает).
  static DateTime now() {
    // Сверка с сервером свежая — верим ей, а не часам устройства.
    final server = ServerClock.now();
    if (server != null) return server.toUtc();
    var t = DateTime.now().toUtc();
    final seen = _maxSeen;
    if (seen != null && seen.isAfter(t)) t = seen;
    return t;
  }

  /// Ответ своего сервера получен: связь есть. Время сервера — главное:
  /// если на устройстве когда-то стояла дата из будущего, она забывается.
  static void noteContact([DateTime? at]) {
    final t = (at ?? ServerClock.now() ?? DateTime.now()).toUtc();
    _lastContact = t;
    _maxSeen = t;
    _save();
  }

  /// До какого момента оплачено (из документа подписки с сервера).
  static void notePaidUntil(DateTime? until) {
    _paidUntil = until?.toUtc();
    _save(force: true);
  }

  /// Почему касса закрыта без связи; null — работает.
  static String? expiredReason([DateTime? at]) {
    final n = at ?? now();
    if (_maxSeen == null || n.isAfter(_maxSeen!)) _maxSeen = n;
    final contact = _lastContact;
    if (contact == null) return null;
    final paid = _paidUntil;
    if (paid != null && n.isAfter(paid.add(graceAfterPaid)) && !contact.isAfter(paid)) {
      return 'Оплаченный срок закончился ${_d(paid)}, а касса с тех пор не была на связи. '
          'Подключите её к интернету — касса сама проверит оплату и откроется.';
    }
    if (n.difference(contact) > maxOffline) {
      return 'Касса не была на связи с сервером с ${_d(contact)} — больше ${maxOffline.inDays} дней. '
          'Подключите её к интернету: чеки передадутся, касса откроется сама.';
    }
    return null;
  }

  /// Предупреждение заранее (за [warnBefore] до остановки); null — рано.
  static String? warning([DateTime? at]) {
    final n = at ?? now();
    final contact = _lastContact;
    if (contact == null || expiredReason(n) != null) return null;
    DateTime stop = contact.add(maxOffline);
    final paid = _paidUntil;
    if (paid != null && !contact.isAfter(paid)) {
      final p = paid.add(graceAfterPaid);
      if (p.isBefore(stop)) stop = p;
    }
    final left = stop.difference(n);
    if (left > warnBefore) return null;
    final days = left.inHours <= 24 ? 'меньше суток' : '${(left.inHours / 24).ceil()} дн.';
    return 'Касса давно без связи с сервером — подключите интернет. Без связи она остановится через $days.';
  }

  static String _d(DateTime t) {
    final l = t.toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(l.day)}.${two(l.month)}.${l.year}';
  }

  static Future<void> _save({bool force = false}) async {
    if (_tenant.isEmpty) return;
    final n = DateTime.now();
    if (!force && _savedAt != null && n.difference(_savedAt!) < const Duration(minutes: 5)) return;
    _savedAt = n;
    try {
      final p = await SharedPreferences.getInstance();
      if (_lastContact != null) await p.setInt(_key('contact'), _lastContact!.millisecondsSinceEpoch);
      if (_maxSeen != null) await p.setInt(_key('seen'), _maxSeen!.millisecondsSinceEpoch);
      if (_paidUntil != null) {
        await p.setInt(_key('paid'), _paidUntil!.millisecondsSinceEpoch);
      } else {
        await p.remove(_key('paid'));
      }
    } catch (_) {}
  }

  /// Для тестов.
  static void debugSet({String tenant = 't', DateTime? lastContact, DateTime? paidUntil, DateTime? maxSeen}) {
    _tenant = tenant;
    _lastContact = lastContact?.toUtc();
    _paidUntil = paidUntil?.toUtc();
    _maxSeen = maxSeen?.toUtc();
  }
}
