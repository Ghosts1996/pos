import 'dart:async';

import 'sale_kind.dart';
import '../models/session_model.dart';
import '../services/app_scope.dart';

/// Тайм-кафе: гость платит за время за столом, а не только за заказ.
///
/// Отдельная функция кассы (Админ → «Тайм-кафе», документ
/// settings/timeCafe); «Длительность сеанса» — таймер стола — остаётся
/// сама по себе. Время в счёт добавляет сотрудник кнопкой «Время в счёт» на
/// экране стола: строка «Время в тайм-кафе» с ценой за одного гостя и числом
/// гостей. Повторное нажатие пересчитывает ту же строку, а не добавляет
/// вторую; при «Закрыть стол» время пересчитывается на момент оплаты.
///
/// Тариф: цена часа за гостя; по желанию — своя цена первого часа (часто
/// он дороже), минимальное время к оплате, округление вверх и стоп-чек —
/// больше него за визит с гостя не берём.
class TimeCafe {
  TimeCafe._();

  /// Код строки счёта со временем — по нему строку находим и пересчитываем.
  static const lineId = 'timecafe';

  static bool enabled = false;

  /// Цена часа за одного гостя, ₽.
  static double pricePerHour = 0;

  /// Цена первого часа, ₽ (0 — как остальные часы).
  static double firstHourPrice = 0;

  /// Минимум к оплате, минут (0 — без минимума).
  static int minMinutes = 0;

  /// Округление вверх до N минут: 1 — поминутно, 15 — за каждые 15 минут.
  static int roundMinutes = 1;

  /// Стоп-чек: больше этой суммы за гостя за визит не берём (0 — без него).
  static double stopCheck = 0;

  static const roundChoices = [1, 5, 15, 30, 60];
  static const minChoices = [0, 30, 60];

  static bool get ready => enabled && pricePerHour > 0;

  static StreamSubscription<dynamic>? _sub;

  /// Настройки заведения — живьём (документ settings/timeCafe).
  static void watch() {
    _sub?.cancel();
    try {
      _sub = AppScope.col('settings').doc('timeCafe').snapshots().listen(
            (d) => apply(d.data()),
            onError: (Object _) {},
          );
    } catch (_) {
      // Нет заведения или базы — функция просто выключена.
    }
  }

  /// Настройки из документа settings/timeCafe.
  static void apply(Object? raw) {
    final m = raw is Map ? raw : const {};
    enabled = m['enabled'] == true;
    pricePerHour = _num(m['pricePerHour']);
    firstHourPrice = _num(m['firstHourPrice']);
    final min = _num(m['minMinutes']).round();
    minMinutes = min.clamp(0, 600);
    final r = _num(m['roundMinutes']).round();
    roundMinutes = roundChoices.contains(r) ? r : 1;
    stopCheck = _num(m['stopCheck']);
  }

  static Map<String, dynamic> toMap({
    required bool enabled,
    required double pricePerHour,
    double firstHourPrice = 0,
    int minMinutes = 0,
    required int roundMinutes,
    required double stopCheck,
  }) =>
      {
        'enabled': enabled,
        'pricePerHour': pricePerHour,
        'firstHourPrice': firstHourPrice,
        'minMinutes': minMinutes,
        'roundMinutes': roundMinutes,
        'stopCheck': stopCheck,
      };

  static double _num(Object? v) {
    final n = v is num ? v.toDouble() : double.tryParse('$v'.replaceAll(',', '.')) ?? 0;
    return n.isFinite && n > 0 ? n : 0;
  }

  /// Минуты к оплате: округление вверх до шага, не меньше минимума и
  /// не меньше одного шага.
  static int billedMinutes(Duration sat, {int? round, int? min}) {
    final step = round ?? roundMinutes;
    final floor = min ?? minMinutes;
    final mins = (sat.inSeconds / 60).ceil();
    var billed = mins <= 0 ? step : ((mins + step - 1) ~/ step) * step;
    if (billed < floor) billed = floor;
    return billed;
  }

  /// Стоимость времени за одного гостя, целые рубли: первый час — по своей
  /// цене (если задана), дальше — по цене часа; не больше стоп-чека.
  static double costPerGuest(Duration sat, {double? price, double? first, int? round, int? min, double? stop}) {
    final p = price ?? pricePerHour;
    final f = (first ?? firstHourPrice) > 0 ? (first ?? firstHourPrice) : p;
    final s = stop ?? stopCheck;
    final m = billedMinutes(sat, round: round, min: min);
    final firstPart = m < 60 ? m : 60;
    var c = (f * firstPart / 60 + p * (m - firstPart) / 60).roundToDouble();
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
  /// без сотрудника — процента с неё никто не получает. [perGuest] — сумма
  /// за гостя, если сотрудник её поправил (иначе — по тарифу).
  static OrderItem line(Duration sat, int guests, {double? perGuest}) {
    final n = guests < 1 ? 1 : guests;
    final mins = billedMinutes(sat);
    final calc = costPerGuest(sat);
    final per = perGuest != null && perGuest >= 0 ? perGuest.roundToDouble() : calc;
    final capped = perGuest == null && stopCheck > 0 && calc >= stopCheck;
    return OrderItem(
      menuItemId: lineId,
      // «· вручную» — сумму поправил сотрудник: при оплате её не пересчитываем.
      name: 'Время в тайм-кафе · ${durationLabel(mins)}${capped ? ' (стоп-чек)' : ''}${perGuest != null ? ' · вручную' : ''}',
      price: per,
      qty: n,
      kind: SaleKind.kitchen,
      ready: n,
      sent: n,
      accepted: n,
      served: n,
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
