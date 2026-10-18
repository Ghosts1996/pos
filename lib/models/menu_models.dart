import 'package:cloud_firestore/cloud_firestore.dart';
import '../utils/sale_kind.dart';
import 'inventory_models.dart';

class MenuCategory {
  final String id;
  final String name;
  final int order;

  /// Публичная ссылка (Firebase Storage download URL) на фото-плитку
  /// категории — как на плитках "Бургеры" / "Барная карта" в Restik POS.
  /// Пусто, если фото ещё не загружено — тогда плитка рисуется заглушкой.
  final String imageUrl;

  /// Что в категории — кухня, бар и напитки или кальяны (SaleKind). Пусто —
  /// угадываем по названию. От этого зависят проценты кальянщику и бармену
  /// и раздельная печать чеков.
  final String kind;

  MenuCategory({
    required this.id,
    required this.name,
    this.order = 0,
    this.imageUrl = '',
    this.kind = '',
  });

  /// Вид категории: выбранный владельцем или угаданный по названию.
  String get effectiveKind => kind.isNotEmpty ? kind : SaleKind.inferFromCategoryName(name);

  factory MenuCategory.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return MenuCategory(
      id: doc.id,
      name: data['name'] ?? '',
      order: (data['order'] as num?)?.toInt() ?? 0,
      imageUrl: data['imageUrl'] ?? '',
      kind: SaleKind.normalize(data['kind'] as String?),
    );
  }

  factory MenuCategory.fromMap(Map<String, dynamic> map) => MenuCategory(
        id: map['id'] as String? ?? '',
        name: map['name'] as String? ?? '',
        order: (map['order'] as num?)?.toInt() ?? 0,
        imageUrl: map['imageUrl'] as String? ?? '',
        kind: SaleKind.normalize(map['kind'] as String?),
      );

  Map<String, dynamic> toMap() => {'name': name, 'order': order, 'imageUrl': imageUrl, 'kind': kind};

  MenuCategory copyWith({String? name, int? order, String? imageUrl, String? kind}) => MenuCategory(
        id: id,
        name: name ?? this.name,
        order: order ?? this.order,
        imageUrl: imageUrl ?? this.imageUrl,
        kind: kind ?? this.kind,
      );
}

/// Одна строка рецепта (техкарты): продукт склада и сколько его идёт в
/// блюдо. Пример — борщ: свёкла 50 г, говядина 60 г, бульон 250 мл.
/// При продаже со склада списывается [grossWeight] × количество.
class MenuItemComponent {
  /// ID позиции склада (InventoryItem).
  final String inventoryItemId;

  /// Сколько продукта идёт в блюдо (нетто) в единицах [weightUnit].
  final double weight;
  final InventoryUnit weightUnit;

  /// Отход при обработке, %: очистка овощей, разделка мяса, уварка. Со
  /// склада уходит брутто = нетто / (1 − отход). 0 — списывается ровно
  /// [weight] (так работали все рецепты до появления поля).
  final double lossPercent;

  MenuItemComponent({
    required this.inventoryItemId,
    required this.weight,
    this.weightUnit = InventoryUnit.g,
    this.lossPercent = 0,
  });

  /// Брутто — сколько взять со склада, с учётом отхода.
  double get grossWeight {
    final loss = lossPercent.clamp(0, 95).toDouble();
    return loss <= 0 ? weight : weight / (1 - loss / 100);
  }

  factory MenuItemComponent.fromMap(Map<String, dynamic> data) => MenuItemComponent(
        inventoryItemId: data['inventoryItemId'] as String? ?? '',
        weight: (data['weight'] as num?)?.toDouble() ?? 0,
        weightUnit: InventoryUnitX.fromName(data['weightUnit'] as String?),
        lossPercent: ((data['lossPercent'] as num?)?.toDouble() ?? 0).clamp(0, 95).toDouble(),
      );

  Map<String, dynamic> toMap() => {
        'inventoryItemId': inventoryItemId,
        'weight': weight,
        'weightUnit': weightUnit.name,
        if (lossPercent > 0) 'lossPercent': lossPercent,
      };

  MenuItemComponent copyWith({
    String? inventoryItemId,
    double? weight,
    InventoryUnit? weightUnit,
    double? lossPercent,
  }) =>
      MenuItemComponent(
        inventoryItemId: inventoryItemId ?? this.inventoryItemId,
        weight: weight ?? this.weight,
        weightUnit: weightUnit ?? this.weightUnit,
        lossPercent: lossPercent ?? this.lossPercent,
      );
}

/// Вариант модификатора: «Кокосовое молоко +60 ₽», «Medium», «Без лука».
/// Может списывать продукт со склада (сироп 20 мл) — как простая позиция.
class ModifierOption {
  final String name;

  /// Доплата за вариант, ₽ (0 — бесплатно).
  final double price;
  final String inventoryItemId;
  final double weight;
  final InventoryUnit weightUnit;

  /// Блюдо меню, которым является вариант, — для комбо и бизнес-ланчей
  /// («Первое: Борщ»): со склада списывается техкарта этого блюда.
  final String menuItemId;

  const ModifierOption({
    required this.name,
    this.price = 0,
    this.inventoryItemId = '',
    this.weight = 0,
    this.weightUnit = InventoryUnit.g,
    this.menuItemId = '',
  });

  bool get hasInventoryLink => inventoryItemId.isNotEmpty && weight > 0;

  factory ModifierOption.fromMap(Map<String, dynamic> m) => ModifierOption(
        name: (m['name'] ?? '').toString().trim(),
        price: (m['price'] as num?)?.toDouble() ?? 0,
        inventoryItemId: (m['inventoryItemId'] ?? '').toString(),
        weight: (m['weight'] as num?)?.toDouble() ?? 0,
        weightUnit: InventoryUnitX.fromName(m['weightUnit'] as String?),
        menuItemId: (m['menuItemId'] ?? '').toString(),
      );

  Map<String, dynamic> toMap() => {
        'name': name,
        'price': price,
        if (menuItemId.isNotEmpty) 'menuItemId': menuItemId,
        if (inventoryItemId.isNotEmpty) 'inventoryItemId': inventoryItemId,
        if (weight > 0) 'weight': weight,
        if (inventoryItemId.isNotEmpty) 'weightUnit': weightUnit.name,
      };
}

/// Группа модификаторов позиции: «Молоко» (выбрать одно), «Добавки» (сколько
/// угодно), «Прожарка» (обязательно одно). [min] > 0 — выбор обязателен,
/// [max] = 1 — один вариант из списка.
class ModifierGroup {
  final String name;
  final int min;
  final int max;
  final List<ModifierOption> options;

  const ModifierGroup({required this.name, this.min = 0, this.max = 1, this.options = const []});

  bool get required => min > 0;
  bool get single => max == 1;

  factory ModifierGroup.fromMap(Map<String, dynamic> m) {
    final opts = ((m['options'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => ModifierOption.fromMap(Map<String, dynamic>.from(e)))
        .where((o) => o.name.isNotEmpty)
        .toList();
    final max = (m['max'] as num?)?.toInt() ?? 1;
    final min = (m['min'] as num?)?.toInt() ?? 0;
    return ModifierGroup(
      name: (m['name'] ?? '').toString().trim(),
      max: max < 0 ? 0 : max,
      min: min.clamp(0, opts.length),
      options: opts,
    );
  }

  Map<String, dynamic> toMap() =>
      {'name': name, 'min': min, 'max': max, 'options': options.map((o) => o.toMap()).toList()};

  ModifierGroup copyWith({String? name, int? min, int? max, List<ModifierOption>? options}) => ModifierGroup(
      name: name ?? this.name, min: min ?? this.min, max: max ?? this.max, options: options ?? this.options);
}

class MenuItem {
  final String id;
  final String categoryId;
  final String name;
  final double price;
  final bool available;

  /// Фото блюда/позиции — используется в карточке позиции меню и, при
  /// желании, как фото по умолчанию для категории.
  final String imageUrl;

  /// Граммовка/объём порции в единицах [weightUnit] — для простых позиций
  /// с одной привязкой к складу. 0 — граммовка не задана.
  final double weight;
  final InventoryUnit weightUnit;

  /// ID позиции склада (InventoryItem), с которой связана эта позиция меню.
  /// Пустая строка — связь не задана, при продаже склад не списывается.
  /// При наличии связи и weight > 0 при закрытии чека автоматически
  /// списывается weight * qty единиц с соответствующей позиции склада.
  final String inventoryItemId;

  /// Список компонентов для составных позиций (миксов).
  /// Если не пуст — используется вместо [inventoryItemId] + [weight]:
  /// при продаже списывается каждый компонент отдельно.
  /// Пример: "Тарелка Снэков" = орешки 50 г + чипсы 75 г + сухарики 75 г.
  final List<MenuItemComponent> components;

  /// На сколько порций записан рецепт [components]: повар пишет техкарту
  /// на кастрюлю («говядина 3 кг … на 20 порций»), а при продаже одной
  /// порции списывается 1/20. 1 — рецепт на одну порцию.
  final int recipePortions;

  /// Ставка НДС позиции для фискального чека ('vat22', 'vat5', 'none'…,
  /// см. FiscalVatRate). Пусто — ставка заведения по умолчанию.
  final String vat;

  /// Предмет расчёта для чека: 'commodity' (товар), 'service' (услуга —
  /// кальян, аренда), 'excise' (подакцизный — табак, пиво, алкоголь).
  final String fiscalSubject;

  /// Состав и описание для гостя («томаты, моцарелла, базилик»): видно в
  /// меню гостя, по нему ИИ-помощник рассказывает, что входит в блюдо.
  final String description;

  /// Табачная или никотинсодержащая позиция (кальян, табак, вейп) — ставит
  /// владелец. Такие позиции не получают скидок, бонусов и бейджа «Хит»,
  /// не видны гостю вне заведения (ст. 16 и 19 закона № 15-ФЗ). Помимо
  /// флага табак узнаётся по названию позиции/категории (PromoPolicy).
  final bool tobacco;

  /// Место в топе продаж за 30 дней (1 — самая популярная), 0 — не в топе.
  /// Считает сервер раз в сутки (saas-gateway, runMenuPopularity); в
  /// toMap() намеренно не пишется — правка позиции его не сотрёт.
  final int popularRank;

  /// Модификаторы: молоко, сиропы, прожарка, соус. Пусто — позиция
  /// добавляется в счёт сразу, без окна выбора.
  final List<ModifierGroup> modifierGroups;

  /// Бонус сотруднику за каждую проданную штуку, ₽ (мотивация продавать
  /// десерты, коктейли дня). 0 — без бонуса. Начисляется тому, кто добавил
  /// позицию в счёт (OrderItem.by).
  final double staffBonus;

  MenuItem({
    required this.id,
    required this.categoryId,
    required this.name,
    required this.price,
    this.available = true,
    this.imageUrl = '',
    this.weight = 0,
    this.weightUnit = InventoryUnit.g,
    this.inventoryItemId = '',
    this.components = const [],
    this.recipePortions = 1,
    this.vat = '',
    this.fiscalSubject = 'commodity',
    this.description = '',
    this.tobacco = false,
    this.popularRank = 0,
    this.modifierGroups = const [],
    this.staffBonus = 0,
  });

  bool get hasModifiers => modifierGroups.any((g) => g.options.isNotEmpty);

  /// Выбранные варианты по названиям (в порядке групп) — существующие в
  /// меню. Неизвестные названия отбрасываются.
  List<ModifierOption> optionsNamed(Iterable<String> names) {
    final want = names.toSet();
    return [
      for (final g in modifierGroups)
        for (final o in g.options)
          if (want.contains(o.name)) o,
    ];
  }

  /// Цена штуки с выбранными модификаторами.
  double priceWith(Iterable<String> mods) => price + optionsNamed(mods).fold<double>(0, (a, o) => a + o.price);

  /// Пустая строка — выбор подходит; иначе — что не так (для подсказки).
  String checkModifiers(Iterable<String> mods) {
    final chosen = mods.toSet();
    for (final g in modifierGroups) {
      final n = g.options.where((o) => chosen.contains(o.name)).length;
      if (n < g.min) return g.min == 1 ? 'Выберите: ${g.name}' : '${g.name}: выберите не меньше ${g.min}';
      if (g.max > 0 && n > g.max) return '${g.name}: не больше ${g.max}';
    }
    return '';
  }

  /// Что уходит со склада на одну порцию: строки рецепта (брутто, делённое
  /// на число порций рецепта) или простая привязка. Единый источник для
  /// списания при продаже, проверки остатков, себестоимости и стоп-листа.
  List<MenuItemComponent> get perPortion {
    if (isComposite) {
      final n = recipePortions < 1 ? 1 : recipePortions;
      return [
        for (final c in components)
          if (c.inventoryItemId.isNotEmpty && c.weight > 0)
            MenuItemComponent(inventoryItemId: c.inventoryItemId, weight: c.grossWeight / n, weightUnit: c.weightUnit),
      ];
    }
    if (!hasInventoryLink) return const [];
    return [MenuItemComponent(inventoryItemId: inventoryItemId, weight: weight, weightUnit: weightUnit)];
  }

  /// Себестоимость порции по техкарте (без модификаторов), ₽: брутто ×
  /// цена закупки продуктов склада [stock]. null — не всё посчитать: нет
  /// привязки к складу или цены закупки у какого-то продукта.
  double? costPrice(Map<String, InventoryItem> stock) {
    final lines = perPortion;
    if (lines.isEmpty) return null;
    var sum = 0.0;
    for (final c in lines) {
      final inv = stock[c.inventoryItemId];
      if (inv == null || inv.costPrice <= 0) return null;
      sum += inv.costOf(c.weight, c.weightUnit);
    }
    return sum;
  }

  /// Фудкост, % от цены: себестоимость / цена. null — не посчитать.
  double? foodCostPercent(Map<String, InventoryItem> stock) {
    final c = costPrice(stock);
    if (c == null || price <= 0) return null;
    return c / price * 100;
  }

  /// Входит в пятёрку самых популярных — бейдж «Хит» у гостя.
  bool get isHit => popularRank > 0 && popularRank <= 5;

  /// Позиция привязана к складу через простую связь.
  bool get hasInventoryLink => inventoryItemId.isNotEmpty && weight > 0;

  /// Позиция — составной микс с несколькими компонентами склада.
  bool get isComposite => components.isNotEmpty;

  /// Позиция спишет что-либо со склада при продаже.
  bool get hasAnyInventoryLink => isComposite || hasInventoryLink;

  factory MenuItem.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return MenuItem.fromMap({'id': doc.id, ...data});
  }

  factory MenuItem.fromMap(Map<String, dynamic> data) {
    final rawComponents = (data['components'] as List?) ?? [];
    return MenuItem(
      id: data['id'] as String? ?? '',
      categoryId: data['categoryId'] ?? '',
      name: data['name'] ?? '',
      price: (data['price'] ?? 0).toDouble(),
      available: data['available'] ?? true,
      imageUrl: data['imageUrl'] ?? '',
      weight: (data['weight'] as num?)?.toDouble() ?? 0,
      weightUnit: InventoryUnitX.fromName(data['weightUnit'] as String?),
      inventoryItemId: data['inventoryItemId'] ?? '',
      components: rawComponents
          .map((e) => MenuItemComponent.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      recipePortions: ((data['recipePortions'] as num?)?.toInt() ?? 1).clamp(1, 10000),
      vat: (data['vat'] as String?) ?? '',
      fiscalSubject: (data['fiscalSubject'] as String?) ?? 'commodity',
      description: (data['description'] as String?) ?? '',
      tobacco: data['tobacco'] == true,
      popularRank: (data['popularRank'] as num?)?.toInt() ?? 0,
      staffBonus: (data['staffBonus'] as num?)?.toDouble() ?? 0,
      modifierGroups: ((data['modifierGroups'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => ModifierGroup.fromMap(Map<String, dynamic>.from(e)))
          .where((g) => g.name.isNotEmpty && g.options.isNotEmpty)
          .toList(),
    );
  }

  Map<String, dynamic> toMap() => {
        'description': description,
        'tobacco': tobacco,
        'vat': vat,
        'fiscalSubject': fiscalSubject,
        'categoryId': categoryId,
        'name': name,
        'price': price,
        'available': available,
        'imageUrl': imageUrl,
        'weight': weight,
        'weightUnit': weightUnit.name,
        'inventoryItemId': inventoryItemId,
        'components': components.map((c) => c.toMap()).toList(),
        'recipePortions': recipePortions,
        'modifierGroups': modifierGroups.map((g) => g.toMap()).toList(),
        'staffBonus': staffBonus,
      };

  MenuItem copyWith({
    String? categoryId,
    String? name,
    double? price,
    bool? available,
    String? imageUrl,
    double? weight,
    InventoryUnit? weightUnit,
    String? inventoryItemId,
    List<MenuItemComponent>? components,
    int? recipePortions,
    String? vat,
    String? fiscalSubject,
    String? description,
    bool? tobacco,
    List<ModifierGroup>? modifierGroups,
    double? staffBonus,
  }) =>
      MenuItem(
        id: id,
        staffBonus: staffBonus ?? this.staffBonus,
        modifierGroups: modifierGroups ?? this.modifierGroups,
        description: description ?? this.description,
        tobacco: tobacco ?? this.tobacco,
        popularRank: popularRank,
        vat: vat ?? this.vat,
        fiscalSubject: fiscalSubject ?? this.fiscalSubject,
        categoryId: categoryId ?? this.categoryId,
        name: name ?? this.name,
        price: price ?? this.price,
        available: available ?? this.available,
        imageUrl: imageUrl ?? this.imageUrl,
        weight: weight ?? this.weight,
        weightUnit: weightUnit ?? this.weightUnit,
        inventoryItemId: inventoryItemId ?? this.inventoryItemId,
        components: components ?? this.components,
        recipePortions: recipePortions ?? this.recipePortions,
      );
}