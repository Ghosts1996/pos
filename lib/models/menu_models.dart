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

class MenuItem {
  final String id;
  final String categoryId;
  final String name;
  final double price;
  final bool available;

  /// Фото блюда/позиции — используется в карточке позиции меню и, при
  /// желании, как фото по умолчанию для категории.
  final String imageUrl;

  /// Граммовка/объём порции в единицах [weightUnit] — тот же набор единиц,
  /// что и на складе (г/кг/мл/л/шт). 0 — граммовка не задана.
  final double weight;
  final InventoryUnit weightUnit;

  /// ID позиции склада (InventoryItem), с которой связана эта позиция меню.
  /// Пустая строка — связь не задана, при продаже склад не списывается.
  /// При наличии связи и weight > 0 при закрытии чека автоматически
  /// списывается weight * qty единиц с соответствующей позиции склада.
  final String inventoryItemId;

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
  });

  /// Позиция привязана к складу и имеет ненулевую граммовку — будет
  /// списана при продаже.
  bool get hasInventoryLink => inventoryItemId.isNotEmpty && weight > 0;

  factory MenuItem.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
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
      );
}
