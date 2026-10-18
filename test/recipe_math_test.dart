import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/checkout_checks.dart';
import 'package:hookah_pos/utils/recipe_math.dart';

OrderItem _line(String id, int qty, {String name = '', List<String> mods = const []}) =>
    OrderItem(menuItemId: id, name: name, price: 100, qty: qty, mods: mods, since: DateTime(2026));

void main() {
  final stock = {
    'potato': InventoryItem(id: 'potato', name: 'Картофель', unit: InventoryUnit.kg, quantity: 5, costPrice: 40),
    'beef': InventoryItem(id: 'beef', name: 'Говядина', unit: InventoryUnit.g, quantity: 3000, costPrice: 800),
    'beet': InventoryItem(id: 'beet', name: 'Свёкла', unit: InventoryUnit.g, quantity: 2000, costPrice: 50),
    'broth': InventoryItem(id: 'broth', name: 'Бульон', unit: InventoryUnit.l, quantity: 4),
    'egg': InventoryItem(id: 'egg', name: 'Яйцо', unit: InventoryUnit.pcs, quantity: 30, costPrice: 12),
    'syrup': InventoryItem(id: 'syrup', name: 'Сироп', unit: InventoryUnit.ml, quantity: 700),
    'cola': InventoryItem(id: 'cola', name: 'Кола', unit: InventoryUnit.pcs, quantity: 1),
  };

  // Борщ: техкарта на кастрюлю — 10 порций. Картофель 1 кг нетто, отход 20 %.
  final borsch = MenuItem(id: 'borsch', categoryId: 'k', name: 'Борщ', price: 450, recipePortions: 10, components: [
    MenuItemComponent(inventoryItemId: 'potato', weight: 1000, lossPercent: 20),
    MenuItemComponent(inventoryItemId: 'beef', weight: 0.6, weightUnit: InventoryUnit.kg),
    MenuItemComponent(inventoryItemId: 'beet', weight: 500),
  ]);
  final omelette = MenuItem(id: 'omelette', categoryId: 'k', name: 'Омлет', price: 300, components: [
    MenuItemComponent(inventoryItemId: 'egg', weight: 3, weightUnit: InventoryUnit.pcs),
    MenuItemComponent(inventoryItemId: 'potato', weight: 100),
  ]);
  final latte = MenuItem(id: 'latte', categoryId: 'b', name: 'Латте', price: 250, modifierGroups: const [
    ModifierGroup(name: 'Сироп', options: [
      ModifierOption(name: 'Карамель', price: 50, inventoryItemId: 'syrup', weight: 20, weightUnit: InventoryUnit.ml),
    ]),
  ]);
  final lunch = MenuItem(id: 'lunch', categoryId: 'k', name: 'Бизнес-ланч', price: 550, modifierGroups: const [
    ModifierGroup(name: 'Первое', min: 1, options: [ModifierOption(name: 'Борщ', menuItemId: 'borsch')]),
  ]);
  final cola = MenuItem(id: 'cola', categoryId: 'b', name: 'Кола', price: 200, inventoryItemId: 'cola', weight: 1);
  final menu = {for (final m in [borsch, omelette, latte, lunch, cola]) m.id: m};

  test('брутто с отходом и рецепт на несколько порций', () {
    expect(MenuItemComponent(inventoryItemId: 'x', weight: 80, lossPercent: 20).grossWeight, closeTo(100, 1e-9));
    final p = {for (final c in borsch.perPortion) c.inventoryItemId: c};
    expect(p['potato']!.weight, closeTo(125, 1e-9), reason: '1000 г / 0,8 / 10 порций');
    expect(p['beef']!.weight, closeTo(0.06, 1e-9));
    expect(p['beef']!.weightUnit, InventoryUnit.kg);
    // Себестоимость порции: картофель 0,125 кг × 40 + говядина 0,06 кг × 800 + свёкла 0,05 кг × 50.
    expect(borsch.costPrice(stock), closeTo(5 + 48 + 2.5, 1e-9));
  });

  test('продажа: всё в единицах склада, одна позиция склада — одна строка на чек', () {
    final draws = saleDraws([_line('borsch', 2), _line('omelette', 1), _line('latte', 2, mods: ['Карамель'])], menu, stock);
    expect(draws['potato']!.qty, closeTo(0.25 + 0.1, 1e-9), reason: 'кг: 2 борща по 125 г + омлет 100 г');
    expect(draws['potato']!.sourceText, 'Борщ ×2, Омлет ×1');
    expect(draws['beef']!.qty, closeTo(120, 1e-9), reason: 'склад в граммах, рецепт в кг');
    expect(draws['egg']!.qty, 3);
    expect(draws['syrup']!.qty, 40);
    expect(draws['syrup']!.sources.single, 'Латте ×2 (Карамель)');
  });

  test('комбо списывает рецепт выбранного блюда; простая привязка — как раньше', () {
    final draws = saleDraws([_line('lunch', 3, mods: ['Борщ']), _line('cola', 2)], menu, stock);
    expect(draws['beet']!.qty, closeTo(150, 1e-9));
    expect(draws['beet']!.sources.single, 'Бизнес-ланч ×3: Борщ');
    expect(draws['cola']!.qty, 2);
  });

  test('проверка до оплаты видит и модификаторы с комбо', () {
    final short = stockShortages([_line('cola', 2), _line('latte', 40, mods: ['Карамель'])], menu, stock);
    expect(short.map((s) => s.name), ['Кола', 'Сироп']);
    expect(stockNeeds([_line('lunch', 1, mods: ['Борщ'])], menu, stock)['beef'], closeTo(60, 1e-9));
  });

  test('сколько порций хватит по остаткам', () {
    expect(portionsAvailable(borsch, stock), 40, reason: 'картофель 5 кг / 0,125 = 40, свёкла 2000 / 50 = 40, говядина 3000 / 60 = 50');
    expect(portionsAvailable(omelette, stock), 10, reason: 'яиц 30 / 3');
    final empty = {...stock, 'egg': InventoryItem(id: 'egg', name: 'Яйцо', unit: InventoryUnit.pcs, quantity: -4)};
    expect(portionsAvailable(omelette, empty), 0);
    expect(portionsAvailable(MenuItem(id: 'tea', categoryId: 'b', name: 'Чай', price: 1), stock), isNull);
  });

  test('ошибки рецепта: несовместимые единицы и удалённый продукт', () {
    final bad = [
      MenuItemComponent(inventoryItemId: 'egg', weight: 50),
      MenuItemComponent(inventoryItemId: 'gone', weight: 10),
      MenuItemComponent(inventoryItemId: 'beef', weight: 0.1, weightUnit: InventoryUnit.kg),
    ];
    final p = recipeProblems(bad, stock);
    expect(p.length, 2);
    expect(p.first, contains('в рецепте г, на складе шт'));
    expect(missingCosts([MenuItemComponent(inventoryItemId: 'broth', weight: 1)], stock), ['Бульон']);
    expect(InventoryUnit.g.compatibleWith(InventoryUnit.kg), isTrue);
    expect(InventoryUnit.ml.compatibleWith(InventoryUnit.g), isFalse);
    expect(InventoryUnit.l.compatibleUnits, [InventoryUnit.ml, InventoryUnit.l]);
  });

  test('заготовка: приготовить 5 л бульона по рецепту на 10 л, себестоимость литра', () {
    final broth = InventoryItem(id: 'broth', name: 'Бульон', unit: InventoryUnit.l, recipeOutput: 10, recipe: [
      MenuItemComponent(inventoryItemId: 'beef', weight: 2, weightUnit: InventoryUnit.kg),
      MenuItemComponent(inventoryItemId: 'potato', weight: 400, lossPercent: 20),
      MenuItemComponent(inventoryItemId: 'broth', weight: 1, weightUnit: InventoryUnit.l), // сам себя — игнорируется
    ]);
    expect(broth.isPrepared, isTrue);
    final d = productionDraws(broth, 5, stock);
    expect(d['beef'], closeTo(1000, 1e-9));
    expect(d['potato'], closeTo(0.25, 1e-9), reason: '400 г / 0,8 = 500 г на 10 л, на 5 л — 0,25 кг');
    expect(d.containsKey('broth'), isFalse);
    final noSelf = InventoryItem(id: 'broth', name: 'Бульон', unit: InventoryUnit.l, recipeOutput: 10, recipe: broth.recipe.take(2).toList());
    // 2 кг говядины × 800 + 0,5 кг картофеля × 40 = 1620 ₽ на 10 л.
    expect(preparedCostPrice(noSelf, stock), closeTo(162, 1e-9));
    final inMl = InventoryItem(id: 'b2', name: 'Соус', unit: InventoryUnit.ml, recipeOutput: 500, recipe: [
      MenuItemComponent(inventoryItemId: 'egg', weight: 2, weightUnit: InventoryUnit.pcs),
    ]);
    expect(preparedCostPrice(inMl, stock), closeTo(48, 1e-9), reason: '24 ₽ на 0,5 л — 48 ₽ за литр');
  });

  test('старые рецепты без новых полей читаются как раньше', () {
    final m = MenuItem.fromMap({
      'id': 'mix',
      'name': 'Тарелка снэков',
      'price': 500,
      'components': [
        {'inventoryItemId': 'nuts', 'weight': 50, 'weightUnit': 'g'},
      ],
    });
    expect(m.recipePortions, 1);
    expect(m.components.single.lossPercent, 0);
    expect(m.perPortion.single.weight, 50);
    final back = MenuItem.fromMap({'id': 'mix', ...m.copyWith(recipePortions: 4).toMap()});
    expect(back.recipePortions, 4);
    expect(MenuItemComponent.fromMap(MenuItemComponent(inventoryItemId: 'a', weight: 1, lossPercent: 15).toMap()).lossPercent, 15);
  });
}
