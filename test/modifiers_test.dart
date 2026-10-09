import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/kitchen_slips.dart';
import 'package:hookah_pos/utils/sale_kind.dart';

MenuItem _latte() => MenuItem(
      id: 'latte',
      categoryId: 'c',
      name: 'Латте',
      price: 250,
      modifierGroups: const [
        ModifierGroup(name: 'Молоко', min: 1, max: 1, options: [
          ModifierOption(name: 'Обычное'),
          ModifierOption(name: 'Кокосовое', price: 60, inventoryItemId: 'coco', weight: 150, weightUnit: InventoryUnit.ml),
        ]),
        ModifierGroup(name: 'Сироп', max: 2, options: [
          ModifierOption(name: 'Карамель', price: 40),
          ModifierOption(name: 'Ваниль', price: 40),
          ModifierOption(name: 'Орех', price: 40),
        ]),
      ],
    );

void main() {
  group('Модификаторы позиции меню', () {
    test('цена с доплатами, неизвестные варианты не считаются', () {
      final m = _latte();
      expect(m.hasModifiers, isTrue);
      expect(m.priceWith(['Кокосовое', 'Карамель']), 350);
      expect(m.priceWith(['Кокосовое', 'Шоколад']), 310);
      expect(m.optionsNamed(['Карамель', 'Кокосовое']).map((o) => o.name), ['Кокосовое', 'Карамель']);
    });

    test('проверка выбора: обязательная группа и ограничение количества', () {
      final m = _latte();
      expect(m.checkModifiers(const []), 'Выберите: Молоко');
      expect(m.checkModifiers(['Обычное']), '');
      expect(m.checkModifiers(['Обычное', 'Карамель', 'Ваниль', 'Орех']), 'Сироп: не больше 2');
    });

    test('сохраняется и читается из базы, пустые группы отбрасываются', () {
      final back = ModifierGroup.fromMap(_latte().modifierGroups[0].toMap());
      expect(back.name, 'Молоко');
      expect(back.required, isTrue);
      expect(back.single, isTrue);
      expect(back.options[1].inventoryItemId, 'coco');
      expect(back.options[1].weightUnit, InventoryUnit.ml);
      final odd = ModifierGroup.fromMap({'name': 'X', 'min': 5, 'options': [{'name': 'A'}]});
      expect(odd.min, 1, reason: 'обязательных не больше, чем вариантов');
    });
  });

  group('Строка счёта с модификаторами', () {
    test('разные модификаторы — разные строки, без модификаторов ключ прежний', () {
      final plain = OrderItem(menuItemId: 'latte', name: 'Латте', price: 250, qty: 1);
      final coco = OrderItem(menuItemId: 'latte', name: 'Латте', price: 310, qty: 1, mods: const ['Кокосовое']);
      expect(plain.lineId, 'latte');
      expect(coco.lineId, 'latte|Кокосовое');
      expect(coco.displayName, 'Латте (Кокосовое)');
    });

    test('модификаторы переживают сохранение, «+», «−» и разделение счёта', () {
      final line = OrderItem(menuItemId: 'latte', name: 'Латте', price: 310, qty: 3, mods: const ['Кокосовое']);
      expect(OrderItem.fromMap(line.toMap()).mods, ['Кокосовое']);
      expect(line.plus(1).mods, ['Кокосовое']);
      expect(line.minus(1).mods, ['Кокосовое']);
      final (out, rest) = line.split(1);
      expect(out.mods, ['Кокосовое']);
      expect(rest!.mods, ['Кокосовое']);
      expect(OrderItem(menuItemId: 'a', name: 'A', price: 1, qty: 1).toMap().containsKey('mods'), isFalse);
    });

    test('бегунок: модификаторы в названии, отправка отмечается по строке', () {
      final s = SessionModel(
        id: 's',
        tableId: 't',
        tableName: 'Стол 1',
        employeeName: 'Алина',
        startTime: DateTime(2026, 10, 9, 19),
        plannedEnd: DateTime(2026, 10, 9, 21),
        orderItems: [
          OrderItem(menuItemId: 'latte', name: 'Латте', price: 250, qty: 1, kind: SaleKind.bar, since: DateTime(2026)),
          OrderItem(
              menuItemId: 'latte',
              name: 'Латте',
              price: 310,
              qty: 2,
              kind: SaleKind.bar,
              mods: const ['Кокосовое'],
              since: DateTime(2026)),
        ],
      );
      final slips = kitchenSlipsFor(s);
      expect(slips.single.lines.map((l) => l.name), ['Латте', 'Латте (Кокосовое)']);
      expect(kitchenSlipsSentQty(slips), {'latte': 1, 'latte|Кокосовое': 2});
    });
  });
}
