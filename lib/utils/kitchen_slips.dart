import '../models/session_model.dart';
import 'sale_kind.dart';

/// Строка бегунка: сколько штук приготовить и пожелание к ним.
class KitchenSlipLine {
  final String menuItemId;
  final String name;

  /// Сколько штук печатаем — только то, что ещё не уходило.
  final int qty;

  /// Сколько штук в строке счёта на момент печати: после печати столько и
  /// считается отправленным (см. [kitchenSlipsSentQty]).
  final int lineQty;

  final String note;

  /// Часть строки уже уходила раньше — это дозаказ («ещё»).
  final bool more;

  const KitchenSlipLine({
    required this.menuItemId,
    required this.name,
    required this.qty,
    required this.lineQty,
    this.note = '',
    this.more = false,
  });
}

/// Бегунок одного цеха — отдельный листок: кухне свой, бару свой.
class KitchenSlip {
  final String station;
  final String tableName;
  final String guestTag;
  final String waiter;
  final DateTime at;
  final List<KitchenSlipLine> lines;

  const KitchenSlip({
    required this.station,
    required this.tableName,
    this.guestTag = '',
    this.waiter = '',
    required this.at,
    required this.lines,
  });

  String get title => switch (station) {
        SaleKind.bar => 'БАР',
        SaleKind.hookah => 'КАЛЬЯНЫ',
        _ => 'КУХНЯ',
      };

  int get pieces => lines.fold(0, (a, l) => a + l.qty);
}

/// Сколько штук счёта ещё не ушло бегунком.
int kitchenUnsentCount(SessionModel s) => s.orderItems.fold(0, (a, i) => a + (i.menuItemId.isEmpty ? 0 : i.unsent));

/// Бегунки по счёту [s]: новые штуки, по листку на цех — кухня, бар,
/// кальяны. Пусто — отправлять нечего.
List<KitchenSlip> kitchenSlipsFor(SessionModel s, {DateTime? at}) {
  final when = at ?? DateTime.now();
  final out = <KitchenSlip>[];
  for (final station in SaleKind.all) {
    final lines = [
      for (final i in s.orderItems)
        if (i.menuItemId.isNotEmpty && i.unsent > 0 && i.effectiveKind == station)
          KitchenSlipLine(
            menuItemId: i.menuItemId,
            name: i.name,
            qty: i.unsent,
            lineQty: i.qty,
            note: i.note,
            more: i.sent > 0 || i.ready > 0,
          ),
    ];
    if (lines.isEmpty) continue;
    out.add(KitchenSlip(
      station: station,
      tableName: s.tableName,
      guestTag: s.guestTag,
      waiter: s.employeeName,
      at: when,
      lines: lines,
    ));
  }
  return out;
}

/// Что отметить отправленным после печати: id позиции → штук в строке.
Map<String, int> kitchenSlipsSentQty(List<KitchenSlip> slips) => {
      for (final slip in slips)
        for (final l in slip.lines) l.menuItemId: l.lineQty,
    };
