import 'dart:io';

/// Время сервера на устройстве — для того, что нельзя доверять часам
/// планшета (смены сотрудников, время за столом в тайм-кафе) и что должно
/// быть верным и без интернета.
///
/// Каждый ответ своего сервера данных приносит заголовок Date: запоминаем
/// его и дальше считаем время по монотонному таймеру приложения
/// ([Stopwatch]), а не по часам устройства — перевод часов на планшете на
/// него не влияет. Таймер может отставать, если устройство засыпало, — для
/// смен это учитывается в [startTime]/[endTime] в пользу точности: начало —
/// не раньше часов устройства, конец — не позже.
class ServerClock {
  ServerClock._();

  static DateTime? _base;
  static DateTime? _localAtBase;
  static final Stopwatch _sw = Stopwatch();

  /// Сверка с сервером не старше этого — время ей доверяем.
  static const maxAge = Duration(hours: 36);

  /// Заголовок Date ответа сервера (RFC 1123, точность — секунда).
  static void syncFromHeader(String? date) {
    if (date == null || date.isEmpty) return;
    try {
      sync(HttpDate.parse(date));
    } catch (_) {}
  }

  static void sync(DateTime server) {
    _base = server.toUtc();
    _localAtBase = DateTime.now().toUtc();
    _sw
      ..reset()
      ..start();
  }

  /// Для тестов: забыть сверку.
  static void reset() {
    _base = null;
    _localAtBase = null;
    _sw
      ..stop()
      ..reset();
  }

  static bool get synced => _base != null && _sw.elapsed <= maxAge;

  /// Сейчас по серверу (по монотонному таймеру); null — сверки не было.
  static DateTime? now() => synced ? _base!.add(_sw.elapsed) : null;

  /// Сейчас по часам устройства с поправкой на сервер.
  static DateTime? _byDeviceClock() {
    final b = _base, l = _localAtBase;
    if (b == null || l == null) return null;
    return DateTime.now().toUtc().add(b.difference(l));
  }

  /// Начало смены: по таймеру; если часы устройства с поправкой показывают
  /// позже (таймер отстал, пока планшет спал) — по ним. Раньше таймера
  /// быть не может: перевод часов назад начало не сдвинет.
  static DateTime? startTime() {
    final a = now(), b = _byDeviceClock();
    if (a == null) return null;
    if (b == null) return a;
    return b.isAfter(a) ? b : a;
  }

  /// Конец смены: по таймеру; позже него быть не может — перевод часов
  /// вперёд смену не удлинит.
  static DateTime? endTime() => now();
}
