/// Начало личной смены для зарплаты: пришёл раньше открытия — часы идут
/// от открытия, а не от нажатия кнопки.
///
/// [hours] — часы работы по дням недели (1 — понедельник), '14:00-02:00'.
///
/// Две ловушки, из-за которых смену нельзя просто «подтянуть к открытию
/// сегодня»:
///  • заведение работает за полночь (12:00–02:00), и сотрудник отмечается
///    в 01:30 — это ещё вчерашняя рабочая ночь, а не утро перед открытием.
///    Раньше такая смена получала начало «12:00 сегодня» — в будущем, и
///    её часы целиком выпадали из зарплаты;
///  • до открытия больше трёх часов — это не «пришёл пораньше», а что-то
///    другое (ночная уборка, приёмка товара), время не трогаем.
DateTime clampShiftStartToOpening(DateTime now, Map<int, String> hours) {
  final today = _parse(hours[now.weekday]);
  if (today == null) return now;

  final yesterdayWeekday = now.weekday == 1 ? 7 : now.weekday - 1;
  final yesterday = _parse(hours[yesterdayWeekday]);
  final minutesNow = now.hour * 60 + now.minute;
  if (yesterday != null && yesterday.close <= yesterday.open && minutesNow < yesterday.close) {
    return now; // вчерашняя смена ещё идёт
  }

  final opening = DateTime(now.year, now.month, now.day, today.open ~/ 60, today.open % 60);
  if (!now.isBefore(opening)) return now;
  if (opening.difference(now) > const Duration(hours: 3)) return now;
  return opening;
}

({int open, int close})? _parse(String? raw) {
  if (raw == null || raw.trim().isEmpty) return null;
  final parts = raw.split('-');
  if (parts.length != 2) return null;
  int? m(String t) {
    final hm = t.trim().split(':');
    if (hm.length != 2) return null;
    final h = int.tryParse(hm[0]);
    final mm = int.tryParse(hm[1]);
    if (h == null || mm == null) return null;
    return h * 60 + mm;
  }

  final open = m(parts[0]);
  final close = m(parts[1]);
  if (open == null || close == null) return null;
  return (open: open, close: close);
}
