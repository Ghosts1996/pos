import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/guest_items.dart';
import 'package:hookah_pos/utils/parse.dart';

void main() {
  final menu = {
    'tea': MenuItem(id: 'tea', categoryId: 'drinks', name: 'Чай', price: 300),
    'mix': MenuItem(id: 'mix', categoryId: 'hookah', name: 'Авторский микс', price: 1500),
  };
  const cats = {'drinks': 'Напитки', 'hookah': 'Кальяны'};
  OrderItem item(String id, {double price = 1, int qty = 1, String name = 'x'}) =>
      OrderItem(menuItemId: id, name: name, price: price, qty: qty);

  test('цена и название берутся из меню, а не из заказа гостя', () {
    final out = priceGuestItems([item('tea', price: 1, name: 'Бесплатно')], menu, categoryNames: cats);
    expect(out.single.price, 300);
    expect(out.single.name, 'Чай');
    expect(out.single.noPromo, isFalse);
  });

  test('табак остаётся без скидок, даже если гость снял признак', () {
    final out = priceGuestItems([item('mix')], menu, categoryNames: cats);
    expect(out.single.noPromo, isTrue);
  });

  test('чужие позиции и неположительное количество выбрасываются, большое — ограничено', () {
    final out = priceGuestItems(
      [item('ghost', qty: 3), item('tea', qty: -5), item('tea', qty: 0), item('mix', qty: 500)],
      menu,
      categoryNames: cats,
    );
    expect(out.map((i) => i.menuItemId), ['mix']);
    expect(out.single.qty, kMaxGuestQty);
  });

  test('одинаковые позиции складываются в одну строку', () {
    final out = priceGuestItems([item('tea', qty: 2), item('tea', qty: 3)], menu, categoryNames: cats);
    expect(out.single.qty, 5);
  });

  test('разбор строки заказа не падает на дробном количестве и цене строкой', () {
    final i = OrderItem.fromMap({'menuItemId': 'tea', 'name': 'Чай', 'price': '1', 'qty': 1.5});
    expect(i.qty, 1);
    expect(i.price, 0);
  });

  test('поля от гостя неверного типа не роняют разбор', () {
    expect(asText(42), '42');
    expect(asText(null, 'new'), 'new');
    expect(asTextOrNull(5), isNull);
    expect(asNum('5'), isNull);
    expect(asList({'a': 1}), isEmpty);
  });
}
