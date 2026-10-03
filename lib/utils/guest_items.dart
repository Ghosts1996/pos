import 'dart:math' as math;

import '../models/menu_models.dart';
import '../models/session_model.dart';
import 'promo_policy.dart';
import 'sale_kind.dart';

/// Сколько штук одной позиции гость может заказать за раз.
const int kMaxGuestQty = 99;

/// Позиции, присланные гостем (заказ из приложения, предзаказ к брони), по
/// данным меню: название, цену и признак табака берём из [menu], а не из
/// присланного. Веб-версию гостя можно подправить прямо в браузере, и
/// раньше касса принимала заказ с любой ценой, отрицательным количеством
/// или со снятым признаком табака (скидка на табак запрещена законом).
///
/// Позиции, которых нет в меню, выбрасываются; количество — целое от 1 до
/// [kMaxGuestQty]; одинаковые позиции складываются в одну строку.
/// [categoryNames] — названия категорий по id: по ним узнаётся табак.
List<OrderItem> priceGuestItems(
  Iterable<OrderItem> items,
  Map<String, MenuItem> menu, {
  Map<String, String> categoryNames = const {},
  Map<String, String> categoryKinds = const {},
}) {
  final out = <OrderItem>[];
  for (final item in items) {
    final m = menu[item.menuItemId];
    if (m == null || item.qty <= 0) continue;
    final qty = math.min(item.qty, kMaxGuestQty);
    final idx = out.indexWhere((o) => o.menuItemId == m.id);
    if (idx >= 0) {
      out[idx] = out[idx].copyWith(qty: math.min(out[idx].qty + qty, kMaxGuestQty));
      continue;
    }
    final noPromo = PromoPolicy.menuTobacco(m, categoryNames[m.categoryId] ?? '');
    out.add(OrderItem(
      menuItemId: m.id,
      name: m.name,
      price: m.price,
      qty: qty,
      noPromo: noPromo,
      kind: noPromo
          ? SaleKind.hookah
          : SaleKind.forMenuItem(
              tobacco: m.tobacco,
              itemName: m.name,
              categoryKind: categoryKinds[m.categoryId] ?? '',
              categoryName: categoryNames[m.categoryId] ?? '',
            ),
    ));
  }
  return out;
}
