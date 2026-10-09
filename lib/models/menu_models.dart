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

  Map<String, dynamic> toMap() => {'name': name, 'order': order, 'imageUrl': imageUrl, 'kind': kind};

  MenuCategory copyWith({String? name, int? order, String? imageUrl, String? kind}) => MenuCategory(
        id: id,
        name: name ?? this.name,
        order: order ?? this.order,
        imageUrl: imageUrl ?? this.imageUrl,
        kind: kind ?? this.kind,
      );
}

/// Один компонент составной позиции меню (например, "Тарелка Снэков":
/// орешки 50 г + чипсы 75 г + сухарики 75 г).
/// При продаже для каждого компонента списывается weight × qty со склада.
class MenuItemComponent {
  /// ID позиции склада (InventoryItem).
  final String inventoryItemId;

  /// Граммовка/объём этого компонента в единицах [weightUnit].
  final double weight;
  final InventoryUnit weightUnit;

  MenuItemComponent({
    required this.inventoryItemId,
    required this.weight,
    this.weightUnit = InventoryUnit.g,
  });

  factory MenuItemComponent.fromMap(Map<String, dynamic> data) => MenuItemComponent(
        inventoryItemId: data['inventoryItemId'] as String? ?? '',
        weight: (data['weight'] as num?)?.toDouble() ?? 0,
        weightUnit: InventoryUnitX.fromName(data['weightUnit'] as String?),
      );

  Map<String, dynamic> toMap() => {
        'inventoryItemId': inventoryItemId,
        'weight': weight,
        'weightUnit': weightUnit.name,
      };

  MenuItemComponent copyWith({
    String? inventoryItemId,
    double? weight,
    InventoryUnit? weightUnit,
  }) =>
      MenuItemComponent(
        inventoryItemId: inventoryItemId ?? this.inventoryItemId,
        weight: weight ?? this.weight,
        weightUnit: weightUnit ?? this.weightUnit,
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

  /// Себестоимость порции по техкарте (без модификаторов), ₽: граммовка ×
  /// цена закупки продуктов склада [stock]. null — не всё посчитать: нет
  /// привязки к складу или цены закупки у какого-то продукта.
  double? costPrice(Map<String, InventoryItem> stock) {
    if (isComposite) {
      var sum = 0.0;
      for (final c in components) {
        final inv = stock[c.inventoryItemId];
        if (inv == null || inv.costPrice <= 0) return null;
        sum += inv.costOf(c.weight, c.weightUnit);
      }
      return sum;
    }
    if (!hasInventoryLink) return null;
    final inv = stock[inventoryItemId];
    if (inv == null || inv.costPrice <= 0) return null;
    return inv.costOf(weight, weightUnit);
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
    final rawComponents = (data['components'] as List?) ?? [];
    return MenuItem(
      id: doc.id,
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
      );
}