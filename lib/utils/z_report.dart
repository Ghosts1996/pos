import '../models/cash_op.dart';
import '../models/session_model.dart';
import '../models/shift_model.dart';
import 'money.dart';
import 'sale_kind.dart';

/// Z-отчёт — итог кассовой смены при её закрытии. В отличие от X-отчёта
/// он один на смену, получает порядковый номер и больше не меняется:
/// снимок пишется в документ смены (поле `z`) той же транзакцией, что и
/// закрытие. Поздний возврат чека этой смены попадёт в Z-отчёт той смены,
/// в которую его оформили, как на кассовом аппарате.
///
/// Продажи — все оплаченные чеки, закрытые за смену (в том числе
/// возвращённые потом в этой же смене). Возвраты — оформленные за смену,
/// по какому бы дню ни был чек. Выручка = продажи − возвраты.
/// Необнуляемый итог — сумма выручки всех Z-отчётов заведения.
class ZReport {
  final int number;
  final DateTime openedAt;
  final DateTime closedAt;
  final String openedBy;
  final String closedBy;

  final int salesCount;
  final double salesTotal;
  final double salesCash;
  final double salesCard;
  final double salesTerminal;
  final double salesAggregator;
  final double salesComp;

  /// Скидки: сколько не доплатили гости по скидочным картам.
  final double discounts;

  final int refundsCount;
  final double refundsTotal;
  final double refundsCash;
  final double refundsCashless;

  /// Из возвратов — переоткрытые и исправленные чеки.
  final int reopenedCount;

  final int unpaidCount;
  final double unpaidTotal;

  final double tipsCash;
  final double tipsCard;

  // Касса (наличные).
  final double openingCash;
  final double deposits;
  final double payouts;
  final double collections;
  final double cashRefunds;
  final double expectedCash;
  final double? countedCash;
  final double? leftCash;

  final int voidsCount;
  final double voidsTotal;

  /// Выручка по сотрудникам, открывшим стол: имя → [чеков, сумма].
  final Map<String, ZStaffLine> byStaff;

  /// Выручка по видам: Кухня, Бар и напитки, Кальяны.
  final Map<String, double> byKind;

  final List<ZItemLine> items;

  /// Необнуляемый итог после этой смены.
  final double grandTotal;

  const ZReport({
    required this.number,
    required this.openedAt,
    required this.closedAt,
    this.openedBy = '',
    this.closedBy = '',
    this.salesCount = 0,
    this.salesTotal = 0,
    this.salesCash = 0,
    this.salesCard = 0,
    this.salesTerminal = 0,
    this.salesAggregator = 0,
    this.salesComp = 0,
    this.discounts = 0,
    this.refundsCount = 0,
    this.refundsTotal = 0,
    this.refundsCash = 0,
    this.refundsCashless = 0,
    this.reopenedCount = 0,
    this.unpaidCount = 0,
    this.unpaidTotal = 0,
    this.tipsCash = 0,
    this.tipsCard = 0,
    this.openingCash = 0,
    this.deposits = 0,
    this.payouts = 0,
    this.collections = 0,
    this.cashRefunds = 0,
    this.expectedCash = 0,
    this.countedCash,
    this.leftCash,
    this.voidsCount = 0,
    this.voidsTotal = 0,
    this.byStaff = const {},
    this.byKind = const {},
    this.items = const [],
    this.grandTotal = 0,
  });

  double get revenue => _r(salesTotal - refundsTotal);

  /// Средний чек по оплаченным чекам смены.
  double get averageCheck => salesCount == 0 ? 0 : _r(salesTotal / salesCount);

  double? get cashDiff => countedCash == null ? null : _r(countedCash! - expectedCash);

  static double _r(double v) => (v * 100).roundToDouble() / 100;

  /// Разделы отчёта — одинаково на экране, на бумаге и в копии.
  List<ZSection> sections() {
    ZRow row(String l, double v, {bool bold = false}) => ZRow(l, rub(v), bold: bold);
    final diff = cashDiff;
    return [
      ZSection('Итог смены', [
        row('Выручка', revenue, bold: true),
        ZRow('Чеков продажи', '$salesCount'),
        row('Средний чек', averageCheck),
        if (discounts > 0) row('Скидки', discounts),
        row('Необнуляемый итог', grandTotal),
      ]),
      ZSection('Продажи', [
        row('Всего', salesTotal, bold: true),
        row('Наличными', salesCash),
        row('Картой', salesCard),
        row('Терминалом', salesTerminal),
        if (salesAggregator > 0) row('Через агрегаторы', salesAggregator),
        if (salesComp > 0) row('За счёт заведения', salesComp),
      ]),
      ZSection('Возвраты', [
        ZRow('Чеков возврата', '$refundsCount'),
        row('Сумма', refundsTotal, bold: true),
        if (refundsCash > 0) row('Наличными', refundsCash),
        if (refundsCashless > 0) row('Безналичными', refundsCashless),
        if (reopenedCount > 0) ZRow('Из них переоткрыто и исправлено', '$reopenedCount'),
      ]),
      if (byKind.isNotEmpty) ZSection('По видам', [for (final e in byKind.entries) row(e.key, e.value)]),
      if (byStaff.isNotEmpty)
        ZSection('По сотрудникам', [
          for (final e in byStaff.entries) ZRow('${e.key} · чеков ${e.value.checks}', rub(e.value.total)),
        ]),
      ZSection('Наличные в кассе', [
        row('Размен на начало', openingCash),
        row('Продажи наличными', salesCash),
        if (tipsCash > 0) row('Чаевые наличными', tipsCash),
        if (deposits > 0) row('Внесения', deposits),
        if (payouts > 0) row('Выплаты', payouts),
        if (cashRefunds > 0) row('Возвраты наличными', cashRefunds),
        if (collections > 0) row('Инкассация', collections),
        row('Должно быть', expectedCash, bold: true),
        if (countedCash != null) row('Пересчитано', countedCash!),
        if (diff != null) row(diff == 0 ? 'Расхождение' : (diff < 0 ? 'Недостача' : 'Излишек'), diff.abs(), bold: diff != 0),
        if (leftCash != null) row('Оставлено на размен', leftCash!),
      ]),
      if (unpaidCount > 0 || voidsCount > 0 || tipsCard > 0)
        ZSection('Прочее', [
          if (unpaidCount > 0) ZRow('Закрыто без оплаты', '$unpaidCount · ${rub(unpaidTotal)}'),
          if (voidsCount > 0) ZRow('Отмен позиций', '$voidsCount · ${rub(voidsTotal)}'),
          if (tipsCard > 0) row('Чаевые картой', tipsCard),
        ]),
    ];
  }

  String get title => number > 0 ? 'Z-отчёт №$number' : 'Отчёт о закрытии смены';

  /// Текст для мессенджера: итоги без списка позиций.
  String copyText({String venue = ''}) {
    final b = StringBuffer(title);
    if (venue.isNotEmpty) b.write(' · $venue');
    b.writeln();
    b.writeln('Смена ${_dt(openedAt)} — ${_dt(closedAt)}');
    for (final sec in sections()) {
      if (sec.title == 'По сотрудникам') continue;
      b.writeln();
      b.writeln(sec.title);
      for (final r in sec.rows) {
        b.writeln('${r.label}: ${r.value}');
      }
    }
    return b.toString().trimRight();
  }

  static String _dt(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)}.${d.year} ${two(d.hour)}:${two(d.minute)}';
  }

  static String formatDate(DateTime d) => _dt(d);

  /// Собрать отчёт смены. [sold] — чеки, закрытые за смену; [refunds] —
  /// чеки, возвращённые за смену; [ops] — операции с наличными смены.
  /// [number] и [grandTotalBefore] — из счётчика заведения.
  factory ZReport.build({
    required int number,
    required ShiftModel shift,
    required DateTime closedAt,
    required String closedBy,
    required List<SessionModel> sold,
    required List<SessionModel> refunds,
    required List<CashOp> ops,
    double grandTotalBefore = 0,
    double? countedCash,
    double? leftCash,
    int voidsCount = 0,
    double voidsTotal = 0,
  }) {
    var count = 0;
    double total = 0, cash = 0, card = 0, terminal = 0, aggregator = 0, comp = 0, discounts = 0;
    var unpaid = 0;
    double unpaidTotal = 0, tipsCash = 0, tipsCard = 0;
    final staff = <String, ZStaffLine>{};
    final kinds = <String, double>{};
    final items = <String, ZItemLine>{};
    for (final s in sold) {
      if (s.status == 'cancelled') continue;
      // Чаевые — деньги сотрудников, не выручка; остаются и при возврате.
      tipsCash += s.tipsCash;
      tipsCard += s.tipsCard;
      if (s.closedWithoutPayment) {
        unpaid++;
        unpaidTotal += s.totalWithDiscount;
        continue;
      }
      count++;
      final sum = s.totalWithDiscount;
      total += sum;
      cash += s.paymentCash;
      card += s.paymentCard;
      terminal += s.paymentTerminal;
      aggregator += s.paymentAggregator;
      comp += s.paymentComp;
      discounts += s.orderTotal - sum;
      final who = s.employeeName.isEmpty ? 'без имени' : s.employeeName;
      final line = staff[who] ?? const ZStaffLine();
      staff[who] = ZStaffLine(checks: line.checks + 1, total: line.total + sum);
      // Скидка делится на строки пропорционально, чтобы виды сходились с итогом.
      final k = s.orderTotal <= 0 ? 0.0 : sum / s.orderTotal;
      for (final i in s.orderItems) {
        final kind = SaleKind.label(i.effectiveKind);
        kinds[kind] = (kinds[kind] ?? 0) + i.total * k;
        final key = '${i.menuItemId.isNotEmpty ? i.menuItemId : i.name}_${i.price}';
        final it = items[key] ?? ZItemLine(name: i.name, price: i.price);
        items[key] = ZItemLine(name: it.name, price: it.price, qty: it.qty + i.qty, total: it.total + i.total);
      }
    }

    var refundsCount = 0, reopened = 0;
    double refundsTotal = 0, refundsCash = 0, refundsCashless = 0;
    for (final s in refunds) {
      if (!s.refunded || s.closedWithoutPayment) continue;
      refundsCount++;
      if (s.reopenedTo.isNotEmpty) reopened++;
      refundsTotal += s.totalWithDiscount;
      refundsCash += s.paymentCash;
      refundsCashless += s.paymentCard + s.paymentTerminal + s.paymentAggregator;
    }

    final drawer = CashDrawerSummary.from(
        opening: shift.openingCash, sessions: [for (final s in sold) if (s.status != 'cancelled') s], ops: ops);
    final revenue = total - refundsTotal;
    return ZReport(
      number: number,
      openedAt: shift.openedAt,
      closedAt: closedAt,
      openedBy: shift.openedBy,
      closedBy: closedBy,
      salesCount: count,
      salesTotal: _r(total),
      salesCash: _r(cash),
      salesCard: _r(card),
      salesTerminal: _r(terminal),
      salesAggregator: _r(aggregator),
      salesComp: _r(comp),
      discounts: _r(discounts),
      refundsCount: refundsCount,
      refundsTotal: _r(refundsTotal),
      refundsCash: _r(refundsCash),
      refundsCashless: _r(refundsCashless),
      reopenedCount: reopened,
      unpaidCount: unpaid,
      unpaidTotal: _r(unpaidTotal),
      tipsCash: _r(tipsCash),
      tipsCard: _r(tipsCard),
      openingCash: _r(drawer.opening),
      deposits: _r(drawer.deposits),
      payouts: _r(drawer.payouts),
      collections: _r(drawer.collections),
      cashRefunds: _r(drawer.refunds),
      expectedCash: _r(drawer.expected),
      countedCash: countedCash,
      leftCash: leftCash,
      voidsCount: voidsCount,
      voidsTotal: _r(voidsTotal),
      byStaff: staff,
      byKind: {for (final e in kinds.entries) e.key: _r(e.value)},
      items: items.values.toList()..sort((a, b) => b.total.compareTo(a.total)),
      grandTotal: _r(grandTotalBefore + revenue),
    );
  }

  Map<String, dynamic> toMap() => {
        'number': number,
        'openedAt': openedAt.millisecondsSinceEpoch,
        'closedAt': closedAt.millisecondsSinceEpoch,
        'openedBy': openedBy,
        'closedBy': closedBy,
        'salesCount': salesCount,
        'salesTotal': salesTotal,
        'salesCash': salesCash,
        'salesCard': salesCard,
        'salesTerminal': salesTerminal,
        'salesAggregator': salesAggregator,
        'salesComp': salesComp,
        'discounts': discounts,
        'refundsCount': refundsCount,
        'refundsTotal': refundsTotal,
        'refundsCash': refundsCash,
        'refundsCashless': refundsCashless,
        'reopenedCount': reopenedCount,
        'unpaidCount': unpaidCount,
        'unpaidTotal': unpaidTotal,
        'tipsCash': tipsCash,
        'tipsCard': tipsCard,
        'openingCash': openingCash,
        'deposits': deposits,
        'payouts': payouts,
        'collections': collections,
        'cashRefunds': cashRefunds,
        'expectedCash': expectedCash,
        if (countedCash != null) 'countedCash': countedCash,
        if (leftCash != null) 'leftCash': leftCash,
        'voidsCount': voidsCount,
        'voidsTotal': voidsTotal,
        'byStaff': {for (final e in byStaff.entries) e.key: e.value.toMap()},
        'byKind': byKind,
        'items': [for (final i in items) i.toMap()],
        'grandTotal': grandTotal,
      };

  static double _d(Object? v) => v is num ? v.toDouble() : 0;
  static int _i(Object? v) => v is num ? v.toInt() : 0;
  static DateTime _t(Object? v) => DateTime.fromMillisecondsSinceEpoch(_i(v));

  factory ZReport.fromMap(Map<String, dynamic> m) {
    final staff = m['byStaff'] is Map ? Map<String, dynamic>.from(m['byStaff'] as Map) : const <String, dynamic>{};
    final kinds = m['byKind'] is Map ? Map<String, dynamic>.from(m['byKind'] as Map) : const <String, dynamic>{};
    return ZReport(
      number: _i(m['number']),
      openedAt: _t(m['openedAt']),
      closedAt: _t(m['closedAt']),
      openedBy: '${m['openedBy'] ?? ''}',
      closedBy: '${m['closedBy'] ?? ''}',
      salesCount: _i(m['salesCount']),
      salesTotal: _d(m['salesTotal']),
      salesCash: _d(m['salesCash']),
      salesCard: _d(m['salesCard']),
      salesTerminal: _d(m['salesTerminal']),
      salesAggregator: _d(m['salesAggregator']),
      salesComp: _d(m['salesComp']),
      discounts: _d(m['discounts']),
      refundsCount: _i(m['refundsCount']),
      refundsTotal: _d(m['refundsTotal']),
      refundsCash: _d(m['refundsCash']),
      refundsCashless: _d(m['refundsCashless']),
      reopenedCount: _i(m['reopenedCount']),
      unpaidCount: _i(m['unpaidCount']),
      unpaidTotal: _d(m['unpaidTotal']),
      tipsCash: _d(m['tipsCash']),
      tipsCard: _d(m['tipsCard']),
      openingCash: _d(m['openingCash']),
      deposits: _d(m['deposits']),
      payouts: _d(m['payouts']),
      collections: _d(m['collections']),
      cashRefunds: _d(m['cashRefunds']),
      expectedCash: _d(m['expectedCash']),
      countedCash: m['countedCash'] is num ? _d(m['countedCash']) : null,
      leftCash: m['leftCash'] is num ? _d(m['leftCash']) : null,
      voidsCount: _i(m['voidsCount']),
      voidsTotal: _d(m['voidsTotal']),
      byStaff: {
        for (final e in staff.entries)
          if (e.value is Map) e.key: ZStaffLine.fromMap(Map<String, dynamic>.from(e.value as Map)),
      },
      byKind: {for (final e in kinds.entries) e.key: _d(e.value)},
      items: [
        for (final i in (m['items'] is List ? m['items'] as List : const []))
          if (i is Map) ZItemLine.fromMap(Map<String, dynamic>.from(i)),
      ],
      grandTotal: _d(m['grandTotal']),
    );
  }
}

class ZStaffLine {
  final int checks;
  final double total;
  const ZStaffLine({this.checks = 0, this.total = 0});
  Map<String, dynamic> toMap() => {'checks': checks, 'total': (total * 100).roundToDouble() / 100};
  factory ZStaffLine.fromMap(Map<String, dynamic> m) =>
      ZStaffLine(checks: (m['checks'] as num?)?.toInt() ?? 0, total: (m['total'] as num?)?.toDouble() ?? 0);
}

class ZItemLine {
  final String name;
  final double price;
  final int qty;
  final double total;
  const ZItemLine({required this.name, required this.price, this.qty = 0, this.total = 0});
  Map<String, dynamic> toMap() => {'name': name, 'price': price, 'qty': qty, 'total': (total * 100).roundToDouble() / 100};
  factory ZItemLine.fromMap(Map<String, dynamic> m) => ZItemLine(
        name: '${m['name'] ?? ''}',
        price: (m['price'] as num?)?.toDouble() ?? 0,
        qty: (m['qty'] as num?)?.toInt() ?? 0,
        total: (m['total'] as num?)?.toDouble() ?? 0,
      );
}

/// Закрытие смены на регистраторе АТОЛ в заведении (поле смены `zFiscal`).
class ZFiscal {
  final bool ok;
  final String error;
  final int shiftNumber;
  final String documentNumber;
  final String fiscalSign;
  final String fnNumber;
  const ZFiscal({
    required this.ok,
    this.error = '',
    this.shiftNumber = 0,
    this.documentNumber = '',
    this.fiscalSign = '',
    this.fnNumber = '',
  });

  Map<String, dynamic> toMap() => {
        'ok': ok,
        if (error.isNotEmpty) 'error': error,
        if (shiftNumber > 0) 'shiftNumber': shiftNumber,
        if (documentNumber.isNotEmpty) 'documentNumber': documentNumber,
        if (fiscalSign.isNotEmpty) 'fiscalSign': fiscalSign,
        if (fnNumber.isNotEmpty) 'fnNumber': fnNumber,
      };

  factory ZFiscal.fromMap(Map<String, dynamic> m) => ZFiscal(
        ok: m['ok'] == true,
        error: '${m['error'] ?? ''}',
        shiftNumber: (m['shiftNumber'] as num?)?.toInt() ?? 0,
        documentNumber: '${m['documentNumber'] ?? ''}',
        fiscalSign: '${m['fiscalSign'] ?? ''}',
        fnNumber: '${m['fnNumber'] ?? ''}',
      );
}

class ZSection {
  final String title;
  final List<ZRow> rows;
  const ZSection(this.title, this.rows);
}

class ZRow {
  final String label;
  final String value;
  final bool bold;
  const ZRow(this.label, this.value, {this.bold = false});
}
