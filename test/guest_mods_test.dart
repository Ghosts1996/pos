import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/guest_items.dart';

void main() {
  final menu = {
    'latte': MenuItem(id: 'latte', categoryId: 'drinks', name: 'Латте', price: 250, modifierGroups: [
      const ModifierGroup(name: 'Молоко', min: 1, max: 1, options: [
        ModifierOption(name: 'Обычное'),
        ModifierOption(name: 'Кокосовое', price: 60),
      ]),
    ]),
  };

  test('модификаторы гостя: цена по меню, разные варианты — разные строки', () {
    final out = priceGuestItems([
      OrderItem(menuItemId: 'latte', name: 'x', price: 1, qty: 1, mods: const ['Кокосовое']),
      OrderItem(menuItemId: 'latte', name: 'x', price: 1, qty: 2, mods: const ['Обычное']),
      OrderItem(menuItemId: 'latte', name: 'x', price: 1, qty: 1, mods: const ['Кокосовое']),
    ], menu);
    expect(out, hasLength(2));
    final coco = out.firstWhere((o) => o.mods.contains('Кокосовое'));
    expect(coco.price, 310);
    expect(coco.qty, 2);
    expect(coco.displayName, 'Латте (Кокосовое)');
  });

  test('чужие модификаторы гостя отбрасываются', () {
    final out = priceGuestItems([
      OrderItem(menuItemId: 'latte', name: 'x', price: 1, qty: 1, mods: const ['Золото', 'Обычное']),
    ], menu);
    expect(out.single.mods, ['Обычное']);
    expect(out.single.price, 250);
  });

  test('вариант комбо помнит блюдо меню', () {
    const o = ModifierOption(name: 'Борщ', menuItemId: 'borsch');
    final back = ModifierOption.fromMap(o.toMap());
    expect(back.menuItemId, 'borsch');
    expect(back.hasInventoryLink, isFalse);
  });
}
