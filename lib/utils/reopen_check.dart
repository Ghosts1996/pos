import '../models/session_model.dart';
import '../models/shift_model.dart';
import 'time_cafe.dart';

/// Переоткрытие закрытого чека (Админ → «Чеки»): официант закрыл стол не
/// так — не всё пробил, не тот способ оплаты, закрыл без оплаты по ошибке.
///
/// Закрытый чек по 54-ФЗ не правят: по нему оформляется возврат (а если
/// пробивался фискальный чек — чек «возврат прихода»), а все позиции
/// переносятся в новый открытый чек того же стола. Там их дополняют и
/// закрывают заново обычной оплатой. Так сходятся касса, бонусы гостя,
/// склад и проценты сотрудников, а в истории видно, что и кем исправлено.
class ReopenCheck {
  ReopenCheck._();

  /// Почему чек нельзя переоткрыть; null — можно.
  static String? problem(SessionModel s, {required ShiftModel? openShift}) {
    if (s.status != 'closed') return 'Чек ещё не закрыт';
    if (s.refunded) return 'По этому чеку уже оформлен возврат';
    if (s.isTakeaway) {
      return 'Это заказ с собой или доставка. Переоткрыть можно только чек стола, здесь оформите возврат';
    }
    if (s.guestPaidTotal > 0.004) {
      return 'Гость оплатил онлайн со стола. Такие деньги возвращает банк, поэтому оформите возврат';
    }
    if (s.paymentAggregator > 0.004) {
      return 'Чек оплачен через агрегатор. Исправьте заказ в кабинете агрегатора и оформите возврат';
    }
    if (openShift == null) return 'Смена заведения закрыта. Откройте смену, чтобы переоткрыть чек';
    final closed = s.closedAt;
    if (closed == null || closed.isBefore(openShift.openedAt)) {
      return 'Чек из прошлой смены. Её итоги уже в Z-отчёте, поэтому здесь возможен только возврат';
    }
    return null;
  }

  /// Позиции для нового чека: всё уже приготовлено и подано, на кухню и в
  /// бегунки второй раз не уходит. Кто что добавил ([OrderItem.by])
  /// сохраняется — проценты сотрудников начислятся тем же людям.
  ///
  /// Время тайм-кафе фиксируется на момент первого закрытия (помечается
  /// «вручную»): гость не платит за минуты, пока чек исправляли.
  static List<OrderItem> items(List<OrderItem> source) => [
        for (final i in source)
          OrderItem(
            menuItemId: i.menuItemId,
            name: i.menuItemId == TimeCafe.lineId && !i.name.endsWith(' · вручную') ? '${i.name} · вручную' : i.name,
            price: i.price,
            qty: i.qty,
            noPromo: i.noPromo,
            kind: i.kind,
            by: i.by,
            note: i.note,
            ready: i.qty,
            since: i.since,
            sent: i.qty,
            mods: i.mods,
            accepted: i.qty,
            served: i.qty,
          ),
      ];
}
