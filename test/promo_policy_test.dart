import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/promo_policy.dart';

void main() {
  final items = [
    OrderItem(name: 'Классический кальян', price: 1200, qty: 1),
    OrderItem(name: 'Премиум-микс', price: 1800, qty: 1, noPromo: true),
    OrderItem(name: 'Чай чёрный', price: 350, qty: 2),
  ];

  tearDown(() => PromoPolicy.excludeTobacco = true);

  test('по умолчанию кальяны исключены из скидок и бонусов', () {
    expect(PromoPolicy.excludeTobacco, isTrue);
    expect(PromoPolicy.promoBase(items), 700);
    expect(PromoPolicy.restricted(items[0]), isTrue); // по названию
    expect(PromoPolicy.restricted(items[1]), isTrue); // по категории (флаг)
    expect(PromoPolicy.restricted(items[2]), isFalse);
  });

  test('переключатель выключен — скидка на всё', () {
    PromoPolicy.apply({PromoPolicy.field: false});
    expect(PromoPolicy.promoBase(items), 3700);
  });

  test('флаг сохраняется в заказе', () {
    final m = items[1].toMap();
    expect(m['noPromo'], isTrue);
    expect(OrderItem.fromMap(m).noPromo, isTrue);
    expect(items[2].toMap().containsKey('noPromo'), isFalse);
    expect(items[1].copyWith(qty: 3).noPromo, isTrue);
  });
}
