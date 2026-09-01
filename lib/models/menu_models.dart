import 'package:cloud_firestore/cloud_firestore.dart';
import 'inventory_models.dart';

class MenuCategory {
  final String id;
  final String name;
  final int order;

  /// Публичная ссылка (Firebase Storage download URL) на фото-плитку
  /// категории — как на плитках "Бургеры" / "Барная карта" в Restik POS.
  /// Пусто, если фото ещё не загружено — тогда плитка рисуется заглушкой.
  final String imageUrl;

  MenuCategory({
    required this.id,
    required this.name,
    this.order = 0,
    this.imageUrl = '',
  });

  factory MenuCategory.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return MenuCategory(
      id: doc.id,
      name: data['name'] ?? '',
      order: (data['order'] as num?)?.toInt() ?? 0,
      imageUrl: data['imageUrl'] ?? '',
    );
  }

  Map<String, dynamic> toMap() => {'name': name, 'order': order, 'imageUrl': imageUrl};

  MenuCategory copyWith({String? name, int? order, String? imageUrl}) => MenuCategory(
        id: id,
        name: name ?? this.name,
        order: order ?? this.order,
        imageUrl: imageUrl ?? this.imageUrl,
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
  });

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
    );
  }

  Map<String, dynamic> toMap() => {
        'categoryId': categoryId,
        'name': name,
        'price': price,
        'available': available,
        'imageUrl': imageUrl,
        'weight': weight,
        'weightUnit': weightUnit.name,
        'inventoryItemId': inventoryItemId,
        'components': components.map((c) => c.toMap()).toList(),
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
  }) =>
      MenuItem(
        id: id,
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