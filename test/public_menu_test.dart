import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/public_menu_service.dart';

void main() {
  test('меню с сервера: только доступные блюда, категории по порядку, битая запись не ломает список', () {
    final m = PublicMenu.fromJson({
      'menuItems': [
        {'id': 'a', 'name': 'Латте', 'price': 200, 'categoryId': 'c1'},
        {'id': 'b', 'name': 'Раф', 'price': 250, 'available': false},
        'мусор',
      ],
      'menuCategories': [
        {'id': 'c2', 'name': 'Чай', 'order': 2},
        {'id': 'c1', 'name': 'Кофе', 'order': 1},
      ],
    });
    expect(m.items.map((i) => i.name), ['Латте']);
    expect(m.items.single.price, 200);
    expect(m.categories.map((c) => c.name), ['Кофе', 'Чай']);
  });
}
