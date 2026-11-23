import 'dart:async';

import 'sale_kind.dart';
import 'promo_policy.dart';
import '../build_info.dart';
import '../models/delivery_status.dart';
import '../models/session_model.dart';
import '../services/app_scope.dart';

/// Процент за обслуживание (только SaaS): заведение само включает его и
/// задаёт процент в Касса · Админ → «Обслуживание» (документ
/// settings/serviceCharge).
///
/// В открытый чек зала касса сама ставит строку «Обслуживание N %» — она
/// пересчитывается при каждом изменении счёта (FirestoreService
/// ._editCheckItems), перед предчеком и перед оплатой. Строка — услуга:
/// без скидок и бонусов, не идёт на кухню, в чеке 54-ФЗ — «услуга».
///
/// Закон (ст. 16 ЗоЗПП): гость должен знать о проценте заранее и может
/// отказаться — кассир нажимает на строку → «Гость отказался», в чеке
/// ставится serviceOff, и строка больше не появляется.
class ServiceCharge {
  ServiceCharge._();

  /// Код строки счёта — по нему строку находим и пересчитываем.
  static const lineId = 'zalpos_service';

  static bool enabled = false;

  /// Процент, 0,5…30.
  static double percent = 0;

  /// С какого числа гостей за столом (0 — с любого).
  static int minGuests = 0;

  /// Как называется строка в счёте.
  static String title = 'Обслуживание';

  static const maxPercent = 30.0;

  static bool get ready => kSaasMode && enabled && percent > 0;

  static StreamSubscription<dynamic>? _sub;

  /// Настройки заведения — живьём.
  static void watch() {
    _sub?.cancel();
    if (!kSaasMode) return;
    try {
      _sub = AppScope.col('settings').doc('serviceCharge').snapshots().listen(
            (d) => apply(d.data()),
            onError: (Object _) {},
          );
    } catch (_) {
      // Нет заведения или базы — функция просто выключена.
    }
  }

  static void apply(Object? raw) {
    final m = raw is Map ? raw : const {};
    enabled = m['enabled'] == true;
    percent = cleanPercent(m['percent']);
    final g = m['minGuests'];
    minGuests = (g is num ? g.round() : int.tryParse('$g') ?? 0).clamp(0, 99);
    final t = (m['title'] ?? '').toString().replaceAll(RegExp(r'\s+'), ' ').trim();
    title = t.isEmpty ? 'Обслуживание' : (t.length > 30 ? t.substring(0, 30) : t);
  }

  /// Процент из настройки или поля ввода: «10», «7,5»; вне 0…30 — 0.
  static double cleanPercent(Object? v) {
    final n = v is num ? v.toDouble() : double.tryParse('$v'.replaceAll(',', '.').replaceAll('%', '').trim()) ?? 0;
    if (!n.isFinite || n <= 0 || n > maxPercent) return 0;
    return (n * 10).roundToDouble() / 10;
  }

  static Map<String, dynamic> toMap({
    required bool enabled,
    required double percent,
    int minGuests = 0,
    String title = 'Обслуживание',
  }) =>
      {'enabled': enabled, 'percent': percent, 'minGuests': minGuests, 'title': title};

  /// «10 %», «7,5 %».
  static String percentLabel(double p) {
    final s = p == p.roundToDouble() ? p.toStringAsFixed(0) : p.toStringAsFixed(1).replaceAll('.', ',');
    return '$s %';
  }

  static bool isLine(OrderItem i) => i.menuItemId == lineId;

  /// С чего считается процент: всё в счёте, кроме самой строки и доставки,
  /// со скидкой чека (скидка действует только на позиции, которые можно
  /// удешевлять — как в SessionModel.totalWithDiscount).
  static double baseOf(Iterable<OrderItem> items, double discountPercent) {
    final rest = items.where((i) => !isLine(i) && i.menuItemId != kDeliveryFeeItemId).toList();
    final sum = rest.fold<double>(0, (a, i) => a + i.total);
    final promo = PromoPolicy.promoBase(rest);
    final d = discountPercent.clamp(0, 100) / 100;
    final base = sum - promo * d;
    return base < 0 ? 0 : base;
  }

  /// Сумма процента, целые рубли (половина — вверх).
  static double amountOf(double base, double pct) {
    if (base <= 0 || pct <= 0) return 0;
    return (base * pct / 100 + 1e-9).roundToDouble();
  }

  /// Нужен ли процент в этом чеке: функция включена, это чек зала (не
  /// «с собой» и не доставка), не учебный, гость не отказался, гостей
  /// не меньше порога.
  static bool appliesTo({
    required String orderType,
    required bool serviceOff,
    required int guests,
    bool training = false,
  }) {
    if (!ready || serviceOff || training) return false;
    if (orderType.isNotEmpty) return false;
    if (minGuests > 0 && guests < minGuests) return false;
    return true;
  }

  static bool appliesToSession(SessionModel s) =>
      appliesTo(orderType: s.orderType, serviceOff: s.serviceOff, guests: s.guests, training: s.training);

  /// Строка счёта: уже «подана» — на кухню и в бегунки не идёт; без скидок.
  static OrderItem line(double amount, double pct) => OrderItem(
        menuItemId: lineId,
        name: '$title ${percentLabel(pct)}',
        price: amount,
        qty: 1,
        noPromo: true,
        kind: SaleKind.kitchen,
        ready: 1,
        sent: 1,
        accepted: 1,
        served: 1,
      );

  /// Привести строку «Обслуживание» в позициях чека в порядок: поставить,
  /// пересчитать или убрать. [data] — документ чека. Возвращает true, если
  /// позиции изменились.
  static bool syncItems(List<OrderItem> items, Map<String, dynamic> data) {
    if (!kSaasMode) return false;
    final guests = data['guests'] is num ? (data['guests'] as num).toInt() : 0;
    final want = appliesTo(
      orderType: (data['orderType'] ?? '').toString(),
      serviceOff: data['serviceOff'] == true,
      guests: guests,
      training: data['training'] == true,
    );
    final disc = data['discountPercent'] is num ? (data['discountPercent'] as num).toDouble() : 0.0;
    return syncList(items, want: want, discountPercent: disc);
  }

  /// То же по готовым значениям (для тестов и экранов).
  static bool syncList(List<OrderItem> items, {required bool want, required double discountPercent}) {
    final at = items.indexWhere(isLine);
    final hasOther = items.any((i) => !isLine(i));
    final amount = want && hasOther ? amountOf(baseOf(items, discountPercent), percent) : 0.0;
    if (amount <= 0) {
      if (at < 0) return false;
      items.removeWhere(isLine);
      return true;
    }
    final next = line(amount, percent);
    if (at >= 0) {
      final old = items[at];
      if (old.price == next.price && old.name == next.name && old.qty == 1) {
        // Строка верная; лишние копии (две кассы разом) — убрать.
        if (items.where(isLine).length == 1) return false;
      }
      items.removeWhere(isLine);
    }
    // Строка — всегда последней, под позициями.
    items.add(next);
    return true;
  }
}
