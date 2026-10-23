import 'sale_kind.dart';
import '../models/session_model.dart';

/// Тайм-кафе: гость платит за время за столом, а не только за заказ.
///
/// Включается в Админке → «Тайм-кафе» (settings/sessionDuration, поле
/// timeCafe — там же, где длительность сеанса). Время в счёт добавляет
/// сотрудник кнопкой «Время в счёт» на экране стола: строка «Время в
/// тайм-кафе» с ценой за одного гостя и числом гостей. Повторное нажатие
/// пересчитывает ту же строку, а не добавляет вторую.
class TimeCafe {
  TimeCafe._();

  /// Код строки счёта со временем — по нему строку находим и пересчитываем.
  static const lineId = 'timecafe';

  static bool enabled = false;

  /// Цена часа за одного гостя, ₽.
  static double pricePerHour = 0;

  /// Округление вверх до N минут: 1 — поминутно, 15 — за каждые 15 минут.
  static int roundMinutes = 1;

  /// Стоп-чек: больше этой суммы за гостя за визит не берём (0 — без него).
  static double stopCheck = 0;

  static const roundChoices = [1, 5, 15, 30, 60];

  static bool get ready => enabled && pricePerHour > 0;

  /// Настройки из документа settings/sessionDuration (поле timeCafe).
  static void apply(Object? raw) {
    final m = raw is Map ? raw : const {};
    enabled = m['enabled'] == true;
    pricePerHour = _num(m['pricePerHour']);
    final r = _num(m['roundMinutes']).round();
    roundMinutes = roundChoices.contains(r) ? r : 1;
    stopCheck = _num(m['stopCheck']);
  }

  static Map<String, dynamic> toMap({
    required bool enabled,
    required double pricePerHour,
    required int roundMinutes,
    required double stopCheck,
  }) =>
      {'enabled': enabled, 'pricePerHour': pricePerHour, 'roundMinutes': roundMinutes, 'stopCheck': stopCheck};

  static double _num(Object? v) {
    final n = v is num ? v.toDouble() : double.tryParse('$v'.replaceAll(',', '.')) ?? 0;
    return n.isFinite && n > 0 ? n : 0;
  }

  /// Минуты к оплате: округление вверх, но не меньше одного шага.
  static int billedMinutes(Duration sat, {int? round}) {
    final step = round ?? roundMinutes;
    final mins = (sat.inSeconds / 60).ceil();
    if (mins <= 0) return step;
    return ((mins + step - 1) ~/ step) * step;
  }

  /// Стоимость времени за одного гостя, целые рубли.
  static double costPerGuest(Duration sat, {double? price, int? round, double? stop}) {
    final p = price ?? pricePerHour;
    final s = stop ?? stopCheck;
    var c = (p * billedMinutes(sat, round: round) / 60).roundToDouble();
    if (s > 0 && c > s) c = s;
    return c;
  }

  /// «45 мин», «1 ч», «2 ч 05 мин».
  static String durationLabel(int minutes) {
    final h = minutes ~/ 60, m = minutes % 60;
    if (h == 0) return '$m мин';
    if (m == 0) return '$h ч';
    return '$h ч ${m.toString().padLeft(2, '0')} мин';
  }

  /// Строка счёта со временем: уже «подана» — на кухню и в бегунки не идёт,
  /// без сотрудника — процента с неё никто не получает.
  static OrderItem line(Duration sat, int guests) {
    final mins = billedMinutes(sat);
    final per = costPerGuest(sat);
    final capped = stopCheck > 0 && per >= stopCheck;
    return OrderItem(
      menuItemId: lineId,
      name: 'Время в тайм-кафе · ${durationLabel(mins)}${capped ? ' (стоп-чек)' : ''}',
      price: per,
      qty: guests < 1 ? 1 : guests,
      kind: SaleKind.kitchen,
      ready: guests,
      sent: guests,
      accepted: guests,
      served: guests,
      since: DateTime.now(),
    );
  }

  static bool hasLine(SessionModel s) => s.orderItems.any((i) => i.menuItemId == lineId);

  /// Сколько гостей уже посчитано в строке времени (для повторного пересчёта).
  static int guestsIn(SessionModel s) {
    for (final i in s.orderItems) {
      if (i.menuItemId == lineId) return i.qty;
    }
    return 1;
  }
}
