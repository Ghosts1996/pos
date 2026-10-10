import '../models/employee.dart';
import '../models/session_model.dart';
import '../models/staff_shift_model.dart';
import '../utils/promo_policy.dart';
import '../utils/sale_kind.dart';

/// Продажа, с которой сотруднику положен процент.
class SaleCredit {
  /// Когда закрыт чек — по ставке этого момента и считается процент.
  final DateTime at;

  /// 'check' — чек, который сотрудник вёл (открыл стол); 'hookah' или
  /// 'bar' — позиции этого вида.
  final String base;

  /// Сумма, реально полученная деньгами (наличные, карта, терминал,
  /// агрегатор доставки), —
  /// без скидок, бонусов и «за счёт заведения».
  final double amount;

  /// Для 'check': сколько из [amount] — кальяны (процент «с чеков» может
  /// их не брать).
  final double hookahAmount;

  /// Для 'hookah'/'bar': добавил сам (true) или доля общего котла смены.
  final bool personal;

  const SaleCredit({
    required this.at,
    required this.base,
    required this.amount,
    this.hookahAmount = 0,
    this.personal = true,
  });
}

/// Итог распределения продаж периода.
class PayrollSalesResult {
  final Map<String, List<SaleCredit>> credits;

  /// Кальяны и бар, процент с которых некому было начислить: на смене не
  /// было никого с таким процентом. Сумма по видам.
  final Map<String, double> unassigned;

  const PayrollSalesResult(this.credits, this.unassigned);

  List<SaleCredit> of(String employeeId) => credits[employeeId] ?? const [];
}

/// Раскладывает выручку закрытых чеков по сотрудникам:
///  • официанту — процент с чеков, которые он вёл (открыл стол);
///  • кальяны — тому, кто их добавил в чек, если у него есть процент с
///    кальянов; иначе поровну на всех, у кого такой процент и кто был на
///    смене, когда закрыли чек;
///  • напитки бара — так же, по проценту с бара.
///
/// Чтобы процент нельзя было «нарисовать»: считаем только деньги,
/// реально полученные за чек (наличные + карта + терминал + агрегатор
/// доставки), — чек «за счёт
/// заведения», оплата бонусами, закрытие без оплаты и возвраты процента не
/// дают; кто добавил позицию, касса пишет сама по PIN, переписать чужую
/// позицию на себя нельзя.
class PayrollSales {
  PayrollSales._();

  static PayrollSalesResult attribute({
    required List<SessionModel> sessions,
    required List<Employee> employees,
    required List<StaffShiftModel> shifts,
  }) {
    final byId = {for (final e in employees) e.id: e};
    final byName = <String, Employee>{};
    for (final e in employees) {
      byName.putIfAbsent(e.name, () => e);
    }
    final liveShifts = shifts.where((s) => !s.cancelled).toList();
    final credits = <String, List<SaleCredit>>{};
    final unassigned = <String, double>{SaleKind.hookah: 0, SaleKind.bar: 0};

    void credit(String id, SaleCredit c) => (credits[id] ??= []).add(c);

    for (final s in sessions) {
      final at = s.closedAt;
      if (at == null || s.status != 'closed' || s.refunded || s.closedWithoutPayment) continue;
      final money = s.paymentCash + s.paymentCard + s.paymentTerminal + s.paymentAggregator;
      final total = s.totalWithDiscount;
      if (money <= 0 || total <= 0) continue;
      final factor = money >= total ? 1.0 : money / total;

      var all = 0.0;
      var hookah = 0.0;
      // Позиции бара и кальяна: [вид] → список (сумма, кто сколько добавил, штук).
      final pools = <String, double>{SaleKind.hookah: 0, SaleKind.bar: 0};
      for (final item in s.orderItems) {
        if (item.qty <= 0) continue;
        final discount = PromoPolicy.restricted(item) ? 0.0 : s.discountPercent / 100;
        final amount = item.total * (1 - discount) * factor;
        if (amount <= 0) continue;
        all += amount;
        final kind = item.effectiveKind;
        if (kind == SaleKind.hookah) hookah += amount;
        if (kind != SaleKind.hookah && kind != SaleKind.bar) continue;

        var attributedQty = 0;
        item.by.forEach((empId, q) {
          final e = byId[empId];
          if (q <= 0 || e == null) return;
          if (e.termsAt(at).percentFor(kind) <= 0) return; // нет процента — его штуки в общий котёл
          final share = amount * q / item.qty;
          credit(empId, SaleCredit(at: at, base: kind, amount: share));
          attributedQty += q;
        });
        final rest = amount * (item.qty - attributedQty).clamp(0, item.qty) / item.qty;
        pools[kind] = pools[kind]! + rest;
      }

      // Официанту — процент с чека, который он вёл.
      final waiter = s.employeeId.isNotEmpty ? byId[s.employeeId] : byName[s.employeeName];
      if (waiter != null && all > 0) {
        credit(waiter.id, SaleCredit(at: at, base: 'check', amount: all, hookahAmount: hookah));
      }

      // Общий котёл: поровну на всех с этим процентом, кто был на смене.
      pools.forEach((kind, amount) {
        if (amount <= 0) return;
        final onShift = <String>{
          for (final sh in liveShifts)
            if (!sh.effectiveStart.isAfter(at) && (sh.endedAt == null || at.isBefore(sh.endedAt!)))
              sh.employeeId,
        };
        final eligible = onShift.where((id) => (byId[id]?.termsAt(at).percentFor(kind) ?? 0) > 0).toList();
        if (eligible.isEmpty) {
          unassigned[kind] = unassigned[kind]! + amount;
          return;
        }
        final share = amount / eligible.length;
        for (final id in eligible) {
          credit(id, SaleCredit(at: at, base: kind, amount: share, personal: false));
        }
      });
    }
    return PayrollSalesResult(credits, unassigned);
  }
}
